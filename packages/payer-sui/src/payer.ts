/**
 * The payer loop.
 *
 * Ties the pieces together: read the seller's terms, choose one offer, build
 * and sign a payment, replay the request with it. The transaction bytes are
 * handed to the signer and then to the seller verbatim; nothing here rewrites
 * what the server sent back, and nothing is signed before the offer passes
 * selection and the built transaction passes its own self-check.
 */
import { SUI_TYPE_ARG, normalizeStructTag, toBase64 } from "@mysten/sui/utils";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HeaderError,
  MAX_HEADER_CHARS,
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
  decodeHeader,
  decodeHeaderVerbatim,
  encodeHeader,
  retryHint,
  SUI_GAS_STATION_EXTRA,
  SUI_SPONSOR_EXTENSION,
  type PaymentRequirements,
  type Resource,
  type RetryHint,
} from "@sui-x402/core";
import { InsufficientBalanceError, type CoinRef } from "./coins.js";
import {
  GasStationError,
  httpGasStation,
  type GasStationClient,
} from "./gas-station.js";
import { type SelectOptions, selectRequirement } from "./select.js";
import type { PayerSigner } from "./signer.js";
import {
  type BuiltPayment,
  type PaymentClient,
  buildPaymentTransaction,
} from "./tx.js";
import {
  type BuiltSponsoredPayment,
  buildSponsoredPaymentKind,
  sponsorPayment,
} from "./tx-sponsored.js";

export interface SuiX402PayerOptions {
  client: PaymentClient;
  signer: PayerSigner;
  /** Which offers this payer will pay; see `selectRequirement`. */
  select?: SelectOptions;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Backoff timer; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  gasHeadroomPercent?: number;
  maxGasBudget?: bigint;
  /** Genesis digests per network, extending the pinned `CHAIN_IDENTIFIERS`. */
  chainIdentifiers?: Readonly<Record<string, string>>;
  /**
   * `"never"` (default): the self-funded path only.
   * `"auto"`: self-funded, falling back to sponsored only when the SUI *gas*
   *   floor is what failed.
   * `"always"`: sponsored only; never spends the payer's SUI on gas.
   */
  gasless?: "never" | "auto" | "always";
  /** Gas-station base URL, or a client. Required unless `gasless` is `"never"`. */
  gasStation?: string | GasStationClient;
}

/** The payer options contradict themselves; nothing was signed or sent. */
export class PayerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayerConfigError";
  }
}

export interface PaymentReceipt {
  /** Settlement digest; `""` when the facilitator failed before broadcasting. */
  digest: string;
  payer: string | null;
  /** Atomic units actually received by `payTo`. */
  amount: string | null;
  network: string;
  /** The offer that was paid, exactly as the seller sent it. */
  accepted: PaymentRequirements;
  settle: SettleResponse;
}

/** The last payment this call signed and sent. */
export interface SentPayment {
  digest: string;
  accepted: PaymentRequirements;
}

/** The seller answered 402 again and the payer will not pay a second time. */
export class PaymentRejectedError extends Error {
  constructor(
    readonly reason: string,
    readonly retryHint: RetryHint,
    readonly response: Response,
    detail?: string
  ) {
    super(
      `payment rejected: ${
        reason === "" ? "402 carried no reason code" : reason
      } (retry hint: ${retryHint})` +
        (detail === undefined ? "" : `: ${detail}`)
    );
    this.name = "PaymentRejectedError";
  }
}

/** One extra payment per `fetch` call, whatever the seller asks for. */
const MAX_REBUILDS = 1;
/** Resends of the identical signed payload while the facilitator is unavailable. */
const MAX_RESENDS = 2;
const DEFAULT_BACKOFF_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 30_000;
/** Gap between the two gas-coin reads that must agree before a second payment is signed. */
const RECHECK_MS = 1_500;

/** The 402 body, parsed as JSON, unless it is larger than a header may be. */
const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (Number(response.headers.get("content-length") ?? "0") > MAX_HEADER_CHARS)
    return null;
  const reader = response.clone().body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HEADER_CHARS) {
      // Not cancel(): on a tee'd body that never resolves under undici.
      reader.releaseLock();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
};

/** A 402 document: validated, plus the JSON exactly as the seller wrote it. */
interface Terms {
  document: PaymentRequired;
  raw: unknown;
}

/**
 * Terms of a 402: the `PAYMENT-REQUIRED` header, or the body carrying the same
 * JSON (spec-notes #1). Before anything is paid, an unreadable header is a
 * seller bug worth surfacing; after a payment it must not hide the response.
 */
const readTerms = async (
  response: Response,
  surfaceHeaderErrors: boolean
): Promise<Terms | null> => {
  const header = response.headers.get(HEADER_PAYMENT_REQUIRED);
  if (header !== null) {
    try {
      const { raw, value } = decodeHeaderVerbatim(header, PaymentRequired);
      return { document: value, raw };
    } catch (e) {
      if (surfaceHeaderErrors || !(e instanceof HeaderError)) throw e;
      return null;
    }
  }
  const raw = await readBoundedJson(response);
  const parsed = PaymentRequired.safeParse(raw);
  return parsed.success ? { document: parsed.data, raw } : null;
};

/** The chosen offer as the seller wrote it, keys this schema does not know included. */
const rawOffer = (terms: Terms, index: number): unknown => {
  const { raw } = terms;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("accepts" in raw) ||
    !Array.isArray(raw.accepts)
  )
    return undefined;
  return raw.accepts[index];
};

/** `Retry-After` in seconds, clamped; anything else falls back to the default schedule. */
const retryAfterMs = (response: Response, resend: number): number => {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isInteger(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return (
    DEFAULT_BACKOFF_MS[Math.min(resend, DEFAULT_BACKOFF_MS.length - 1)] ??
    MAX_RETRY_AFTER_MS
  );
};

/** The seller could not reach or could not trust its facilitator; the payload itself was not judged. */
const facilitatorUnavailable = (response: Response, hint: RetryHint): boolean =>
  response.status === 502 ||
  response.status === 503 ||
  response.status === 504 ||
  hint === "facilitator";

interface Attempt {
  response: Response;
  terms: Terms | null;
}

/**
 * A `fetch` that pays. On a 402 it selects an offer, builds and signs a Sui
 * payment, and replays the request with the `PAYMENT-SIGNATURE` header.
 *
 * Retry contract: at most one extra payment per call, and only when the seller
 * says the terms drifted (§8.11) or the transaction went stale (§8.12) — and
 * only after the first payment's gas coin is seen unmoved on chain, twice,
 * which proves that payment never executed. A facilitator outage (502/503/504,
 * or a 402 carrying `unexpected_*_error`) resends the *same* signed payload
 * after `Retry-After`, which the facilitator dedupes by digest (§8.7, §8.9).
 * Every other answer is returned to the caller as-is.
 */
export class SuiX402Payer {
  readonly #client: PaymentClient;
  readonly #signer: PayerSigner;
  readonly #select: SelectOptions | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #gasHeadroomPercent: number | undefined;
  readonly #maxGasBudget: bigint | undefined;
  readonly #chainIdentifiers: Readonly<Record<string, string>> | undefined;
  readonly #gasless: "never" | "auto" | "always";
  readonly #gasStation: GasStationClient | undefined;

  constructor(options: SuiX402PayerOptions) {
    this.#client = options.client;
    this.#signer = options.signer;
    this.#select = options.select;
    // Wrapped rather than stored bare: a detached `fetch` throws in browsers.
    this.#fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#gasHeadroomPercent = options.gasHeadroomPercent;
    this.#maxGasBudget = options.maxGasBudget;
    this.#chainIdentifiers = options.chainIdentifiers;
    this.#gasless = options.gasless ?? "never";
    this.#gasStation =
      typeof options.gasStation === "string"
        ? httpGasStation(options.gasStation)
        : options.gasStation;
    if (this.#gasless !== "never" && this.#gasStation === undefined) {
      throw new PayerConfigError(
        `gasless is "${this.#gasless}" but no gasStation is configured`
      );
    }
  }

  /** Pays a 402 and returns the seller's final response. */
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return (await this.#pay(input, init)).response;
  }

  /**
   * As `fetch`, plus what was paid (`sent`) and the settlement the seller
   * reported in `PAYMENT-RESPONSE` (`receipt`). The receipt is null when nothing
   * was paid, the header is absent or unreadable, or a successful settlement
   * names a digest other than the one this payer signed.
   */
  async fetchWithReceipt(
    input: string | URL,
    init?: RequestInit
  ): Promise<{
    response: Response;
    receipt: PaymentReceipt | null;
    sent: SentPayment | null;
  }> {
    const { response, sent } = await this.#pay(input, init);
    const header = response.headers.get(HEADER_PAYMENT_RESPONSE);
    if (sent === null || header === null)
      return { response, receipt: null, sent };
    let settle: SettleResponse;
    try {
      settle = decodeHeader(header, SettleResponse);
    } catch (e) {
      if (e instanceof HeaderError) return { response, receipt: null, sent };
      throw e;
    }
    if (settle.success && settle.transaction !== sent.digest)
      return { response, receipt: null, sent };
    return {
      response,
      sent,
      receipt: {
        digest: settle.transaction,
        payer: settle.payer ?? null,
        amount: settle.amount ?? null,
        network: settle.network,
        accepted: sent.accepted,
        settle,
      },
    };
  }

  async #pay(
    input: string | URL,
    init: RequestInit | undefined
  ): Promise<{ response: Response; sent: SentPayment | null }> {
    const first = await this.#fetch(input, init);
    if (first.status !== 402) return { response: first, sent: null };
    let terms = await readTerms(first, true);
    if (terms === null) return { response: first, sent: null };

    let requirement = selectRequirement(terms.document.accepts, this.#select);
    let rebuilds = 0;
    for (;;) {
      const offer =
        rawOffer(terms, terms.document.accepts.indexOf(requirement)) ??
        requirement;
      const { built, header } = await this.#sign(
        requirement,
        offer,
        terms.document.resource
      );
      const sent = { digest: built.digest, accepted: requirement };
      const { response, terms: next } = await this.#sendWithBackoff(
        input,
        init,
        header
      );
      if (response.status !== 402) return { response, sent };

      const reason = next?.document.error ?? "";
      const hint = retryHint(reason);
      const retryable =
        (hint === "refetch_terms" && next !== null) || hint === "rebuild_tx";
      if (rebuilds === MAX_REBUILDS || !retryable)
        throw new PaymentRejectedError(reason, hint, response);
      // The proof target is per path: any execution moves a gas coin, but the
      // sponsor's gas coin proves nothing about the payer — there the
      // payer-owned payment coin is the only usable target (§6.4).
      const proofCoin = isSelfFunded(built) ? built.gasCoin : built.paymentCoin;
      await this.#assertNotExecuted(
        { digest: built.digest, coin: proofCoin },
        reason,
        hint,
        response
      );
      if (hint === "refetch_terms" && next !== null) {
        terms = next;
        requirement = selectRequirement(terms.document.accepts, this.#select);
      }
      rebuilds += 1;
    }
  }

  /** Builds and signs; a payment whose local window closed before it could go out is rebuilt once (§8.12). */
  async #sign(
    requirement: PaymentRequirements,
    offer: unknown,
    resource: Resource
  ): Promise<{ built: BuiltPayment | BuiltSponsoredPayment; header: string }> {
    const windowMs = requirement.maxTimeoutSeconds * 1000;
    const startedAt = this.#now();
    let built = await this.#buildForMode(requirement);
    if (windowMs > 0 && this.#now() >= startedAt + windowMs)
      built = await this.#buildForMode(requirement);
    const signature = await this.#signer.signTransaction(built.bytes);
    const sponsored = !isSelfFunded(built);
    const payload = {
      x402Version: 2,
      resource,
      accepted: offer,
      payload: { transaction: toBase64(built.bytes), signature },
      // The Enoki digest rides in the already-optional extensions field; the
      // payload shape itself is unchanged.
      ...(sponsored
        ? { extensions: { [SUI_SPONSOR_EXTENSION]: { digest: built.digest } } }
        : {}),
    };
    // Validated, not rewritten: the header carries the seller's own `accepted` object.
    PaymentPayload.parse(payload);
    return { built, header: encodeHeader(payload) };
  }

  /**
   * Mode dispatch. `"auto"` falls back to sponsored only when the SUI *gas*
   * floor is what failed: a payment-asset shortfall would fail identically in
   * the kind builder, so falling back on it only duplicates the failure.
   */
  async #buildForMode(
    requirement: PaymentRequirements
  ): Promise<BuiltPayment | BuiltSponsoredPayment> {
    if (this.#gasless === "always") return this.#buildSponsored(requirement);
    if (this.#gasless === "never") return this.#build(requirement);
    try {
      return await this.#build(requirement);
    } catch (e) {
      const isGasShortfall =
        e instanceof InsufficientBalanceError &&
        normalizeStructTag(e.asset) === SUI_TYPE_ARG;
      if (!isGasShortfall) throw e;
      return this.#buildSponsored(requirement);
    }
  }

  async #buildSponsored(
    requirement: PaymentRequirements
  ): Promise<BuiltSponsoredPayment> {
    const gasStation = this.#gasStation;
    if (gasStation === undefined)
      throw new PayerConfigError("gasless requires a configured gasStation");
    // §6.5: a seller-advertised gas station is only ever used to detect
    // disagreement with the configured one — never adopted.
    const advertised = requirement.extra?.[SUI_GAS_STATION_EXTRA];
    if (
      typeof advertised === "object" &&
      advertised !== null &&
      "url" in advertised &&
      typeof advertised.url === "string"
    ) {
      if (
        normalizeBaseUrl(advertised.url) !==
        normalizeBaseUrl(gasStation.baseUrl)
      ) {
        throw new GasStationError(
          "deployment_mismatch",
          `the seller advertises gas station ${advertised.url}, but this payer is configured for ${gasStation.baseUrl}; sponsorship and settlement must run through one deployment`
        );
      }
    }
    const kind = await buildSponsoredPaymentKind({
      client: this.#client,
      sender: this.#signer.address(),
      requirements: requirement,
      chainIdentifiers: this.#chainIdentifiers,
    });
    return sponsorPayment({
      client: this.#client,
      gasStation,
      kind,
      network: requirement.network,
    });
  }

  #build(requirement: PaymentRequirements): Promise<BuiltPayment> {
    return buildPaymentTransaction({
      client: this.#client,
      sender: this.#signer.address(),
      requirements: requirement,
      gasHeadroomPercent: this.#gasHeadroomPercent,
      maxGasBudget: this.#maxGasBudget,
      chainIdentifiers: this.#chainIdentifiers,
    });
  }

  /** Sends the signed payload, resending the identical bytes while the facilitator is unavailable. */
  async #sendWithBackoff(
    input: string | URL,
    init: RequestInit | undefined,
    header: string
  ): Promise<Attempt> {
    let attempt = await this.#send(input, init, header);
    for (let resend = 0; resend < MAX_RESENDS; resend++) {
      const hint = retryHint(attempt.terms?.document.error ?? "");
      if (!facilitatorUnavailable(attempt.response, hint)) break;
      await this.#sleep(retryAfterMs(attempt.response, resend));
      attempt = await this.#send(input, init, header);
    }
    return attempt;
  }

  async #send(
    input: string | URL,
    init: RequestInit | undefined,
    header: string
  ): Promise<Attempt> {
    const headers = new Headers(init?.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, header);
    const response = await this.#fetch(input, { ...init, headers });
    return {
      response,
      terms: response.status === 402 ? await readTerms(response, false) : null,
    };
  }

  /**
   * A second payment is signed only once the first one provably never
   * executed: the proof coin still sits at the signed version, on two reads
   * spaced apart. Self-funded payments prove it with the gas coin (any
   * execution moves it, even an abort); sponsored payments with the payment
   * coin, which a successful execution always moves.
   * NOT-HANDLED(an aborted sponsored execution reads as never-executed; the
   * payer bears no gas cost and the retry carries a fresh digest)
   */
  async #assertNotExecuted(
    proof: { digest: string; coin: CoinRef },
    reason: string,
    hint: RetryHint,
    response: Response
  ): Promise<void> {
    const { objectId, version } = proof.coin;
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) await this.#sleep(RECHECK_MS);
      let current: string;
      try {
        current = (await this.#client.getObject({ objectId })).object.version;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new PaymentRejectedError(
          reason,
          hint,
          response,
          `could not confirm payment ${proof.digest} never executed (proof coin ${objectId}): ${detail}`
        );
      }
      if (current !== version) {
        throw new PaymentRejectedError(
          reason,
          "none",
          response,
          `payment ${proof.digest} may have executed: proof coin ${objectId} moved from version ${version} to ${current}`
        );
      }
    }
  }
}

/** The two built-payment shapes are told apart by their proof coin. */
const isSelfFunded = (built: BuiltPayment | BuiltSponsoredPayment): built is BuiltPayment => "gasCoin" in built;

/** Lowercased origin plus path with trailing slashes trimmed — the §6.5 comparison key. */
const normalizeBaseUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
};
