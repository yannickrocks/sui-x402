/**
 * The payer loop (PRD §8.5, §8.7, §8.11, §8.12).
 *
 * Ties the pieces together: read the seller's terms, choose one offer, build
 * and sign a payment, replay the request with it. The transaction bytes are
 * handed to the signer and then to the seller verbatim; nothing here rewrites
 * what the server sent back, and nothing is signed before the offer passes
 * selection and the built transaction passes its own self-check.
 */
import { TransactionError } from "@mysten/sui/client";
import { toBase64 } from "@mysten/sui/utils";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HeaderError,
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
  decodeHeader,
  encodeHeader,
  retryHint,
  type PaymentRequirements,
  type Resource,
  type RetryHint,
} from "@sui-x402/core";
import { type SelectOptions, selectRequirement } from "./select.js";
import type { PayerSigner } from "./signer.js";
import { type BuiltPayment, type PaymentClient, buildPaymentTransaction } from "./tx.js";

export interface SuiX402PayerOptions {
  client: PaymentClient;
  signer: PayerSigner;
  /** Which offers this payer will pay; see `selectRequirement`. */
  select?: SelectOptions;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Backoff timer between resends of the same payload; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  gasHeadroomPercent?: number;
  maxGasBudget?: bigint;
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

/** The seller answered 402 again and the payer will not pay a second time. */
export class PaymentRejectedError extends Error {
  constructor(
    readonly reason: string,
    readonly retryHint: RetryHint,
    readonly response: Response,
    detail?: string,
  ) {
    super(
      `payment rejected: ${reason === "" ? "402 carried no reason code" : reason} (retry hint: ${retryHint})` +
        (detail === undefined ? "" : `: ${detail}`),
    );
    this.name = "PaymentRejectedError";
  }
}

/** One extra payment per `fetch` call, whatever the seller asks for. */
const MAX_REBUILDS = 1;
/** Resends of the identical signed payload while the facilitator is unavailable (PRD §8.7). */
const MAX_RESENDS = 2;
const DEFAULT_BACKOFF_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Terms of a 402: the `PAYMENT-REQUIRED` header, or the body carrying the same
 * JSON (spec-notes #1). A header that is present but unreadable is a seller bug
 * worth surfacing; a 402 with no terms at all is simply not payable.
 */
const readTerms = async (response: Response): Promise<PaymentRequired | null> => {
  const header = response.headers.get(HEADER_PAYMENT_REQUIRED);
  if (header !== null) return decodeHeader(header, PaymentRequired);
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return null;
  }
  const parsed = PaymentRequired.safeParse(body);
  return parsed.success ? parsed.data : null;
};

/** `Retry-After` in seconds, clamped; anything else falls back to the default schedule. */
const retryAfterMs = (response: Response, resend: number): number => {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isInteger(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return DEFAULT_BACKOFF_MS[Math.min(resend, DEFAULT_BACKOFF_MS.length - 1)] ?? MAX_RETRY_AFTER_MS;
};

/** The seller could not reach or could not trust its facilitator; the payload itself was not judged. */
const facilitatorUnavailable = (response: Response, hint: RetryHint): boolean =>
  response.status === 502 || response.status === 503 || response.status === 504 || hint === "facilitator";

interface Attempt {
  response: Response;
  terms: PaymentRequired | null;
}

/**
 * A `fetch` that pays. On a 402 it selects an offer, builds and signs a Sui
 * payment, and replays the request with the `PAYMENT-SIGNATURE` header.
 *
 * Retry contract: at most one extra payment per call, and only when the seller
 * says the terms drifted (§8.11) or the transaction went stale (§8.12, after
 * checking on chain that the first one never executed). A facilitator outage
 * (502/503/504, or a 402 carrying `unexpected_*_error`) resends the *same*
 * signed payload after `Retry-After`, which the facilitator dedupes by digest
 * (§8.7, §8.9). Every other answer is returned to the caller as-is.
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

  constructor(options: SuiX402PayerOptions) {
    this.#client = options.client;
    this.#signer = options.signer;
    this.#select = options.select;
    // Wrapped rather than stored bare: a detached `fetch` throws in browsers.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#gasHeadroomPercent = options.gasHeadroomPercent;
    this.#maxGasBudget = options.maxGasBudget;
  }

  /** Pays a 402 and returns the seller's final response. */
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return (await this.#pay(input, init)).response;
  }

  /**
   * As `fetch`, plus the settlement the seller reported in `PAYMENT-RESPONSE`.
   * The receipt is null when no payment was made or the header is absent or
   * unreadable — a seller bug never hides a response that was paid for.
   */
  async fetchWithReceipt(
    input: string | URL,
    init?: RequestInit,
  ): Promise<{ response: Response; receipt: PaymentReceipt | null }> {
    const { response, requirement } = await this.#pay(input, init);
    const header = response.headers.get(HEADER_PAYMENT_RESPONSE);
    if (requirement === null || header === null) return { response, receipt: null };
    let settle: SettleResponse;
    try {
      settle = decodeHeader(header, SettleResponse);
    } catch (e) {
      if (e instanceof HeaderError) return { response, receipt: null };
      throw e;
    }
    return {
      response,
      receipt: {
        digest: settle.transaction,
        payer: settle.payer ?? null,
        amount: settle.amount ?? null,
        network: settle.network,
        accepted: requirement,
        settle,
      },
    };
  }

  async #pay(
    input: string | URL,
    init: RequestInit | undefined,
  ): Promise<{ response: Response; requirement: PaymentRequirements | null }> {
    const first = await this.#fetch(input, init);
    if (first.status !== 402) return { response: first, requirement: null };
    let terms = await readTerms(first);
    if (terms === null) return { response: first, requirement: null };

    let requirement = selectRequirement(terms.accepts, this.#select);
    let rebuilds = 0;
    for (;;) {
      const { built, header } = await this.#sign(requirement, terms.resource);
      const { response, terms: next } = await this.#sendWithBackoff(input, init, header);
      if (response.status !== 402) return { response, requirement };

      const reason = next?.error ?? "";
      const hint = retryHint(reason);
      if (rebuilds === MAX_REBUILDS) throw new PaymentRejectedError(reason, hint, response);
      if (hint === "refetch_terms" && next !== null) {
        terms = next;
        requirement = selectRequirement(terms.accepts, this.#select);
      } else if (hint === "rebuild_tx") {
        await this.#assertNotExecuted(built.digest, reason, response);
      } else {
        throw new PaymentRejectedError(reason, hint, response);
      }
      rebuilds += 1;
    }
  }

  /** Builds and signs; a payment whose local window closed before it could go out is rebuilt once (§8.12). */
  async #sign(requirement: PaymentRequirements, resource: Resource): Promise<{ built: BuiltPayment; header: string }> {
    const windowMs = requirement.maxTimeoutSeconds * 1000;
    const startedAt = this.#now();
    let built = await this.#build(requirement);
    if (windowMs > 0 && this.#now() >= startedAt + windowMs) built = await this.#build(requirement);
    const signature = await this.#signer.signTransaction(built.bytes);
    const payload = {
      x402Version: 2,
      resource,
      accepted: requirement,
      payload: { transaction: toBase64(built.bytes), signature },
    };
    // Validated, not rewritten: the header carries the seller's own `accepted`
    // object, including any field this version of the schema does not know.
    PaymentPayload.parse(payload);
    return { built, header: encodeHeader(payload) };
  }

  #build(requirement: PaymentRequirements): Promise<BuiltPayment> {
    return buildPaymentTransaction({
      client: this.#client,
      sender: this.#signer.address(),
      requirements: requirement,
      gasHeadroomPercent: this.#gasHeadroomPercent,
      maxGasBudget: this.#maxGasBudget,
    });
  }

  /** Sends the signed payload, resending the identical bytes while the facilitator is unavailable. */
  async #sendWithBackoff(input: string | URL, init: RequestInit | undefined, header: string): Promise<Attempt> {
    let attempt = await this.#send(input, init, header);
    for (let resend = 0; resend < MAX_RESENDS; resend++) {
      const hint = retryHint(attempt.terms?.error ?? "");
      if (!facilitatorUnavailable(attempt.response, hint)) break;
      await this.#sleep(retryAfterMs(attempt.response, resend));
      attempt = await this.#send(input, init, header);
    }
    return attempt;
  }

  async #send(input: string | URL, init: RequestInit | undefined, header: string): Promise<Attempt> {
    const headers = new Headers(init?.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, header);
    const response = await this.#fetch(input, { ...init, headers });
    return { response, terms: response.status === 402 ? await readTerms(response) : null };
  }

  /** A rebuild is only safe when the rejected payment never executed; anything less than proof of absence aborts. */
  async #assertNotExecuted(digest: string, reason: string, response: Response): Promise<void> {
    try {
      await this.#client.getTransaction({ digest });
    } catch (e) {
      if (e instanceof TransactionError && e.reason === "notFound") return;
      const detail = e instanceof Error ? e.message : String(e);
      throw new PaymentRejectedError(reason, "rebuild_tx", response, `could not confirm ${digest} is absent from chain: ${detail}`);
    }
    throw new PaymentRejectedError(reason, "none", response, `transaction ${digest} is already on chain`);
  }
}
