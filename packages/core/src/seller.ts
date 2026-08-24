/**
 * The seller half of x402, with no framework in it.
 *
 * `createSeller` owns every decision a paywall makes: what a 402 says, when a
 * payment header is malformed, when the facilitator is unavailable, and whether
 * the handler may run at all. `@sui-x402/hono`, `@sui-x402/express` and
 * `@sui-x402/next` only translate their own request and response objects to and
 * from `SellerRequest` / `SellerDecision`, so the three behave identically and
 * share one conformance suite (`test/seller-conformance.ts`).
 *
 * Two rules shape the code. The payer-signed document is relayed verbatim —
 * validated, never rewritten — because the facilitator judges it against the
 * bytes the payer signed. And content is never fulfilled unpaid: a facilitator
 * that cannot be reached is a 503 with `Retry-After`, never a 200.
 *
 * Verify, settle and replay protection belong to the facilitator. Nothing here
 * inspects a transaction, and nothing here decides whether a payment is good.
 */
import type { z } from "zod";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HeaderError,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  Supported,
  VerifyResponse,
  decodeHeaderVerbatim,
  encodeHeader,
  type PaymentRequired,
  type Resource,
  type SuiNetwork,
} from "./index.js";

const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;
/** Added to the payment window so a settle is not abandoned while the facilitator is still broadcasting. */
const SETTLE_TIMEOUT_HEADROOM_MS = 10_000;
const JSON_CONTENT_TYPE = "application/json";

export interface SettleFailure {
  /** A facilitator reason code, or a `FacilitatorError` kind when the settle call itself failed. */
  reason: string;
  payer: string | null;
  /** Settlement digest, when one was broadcast before the failure. */
  digest: string | null;
}

export interface SellerOptions {
  payTo: string;
  /** Atomic units as a base-10 string (USDC 6 dp, SUI 9 dp). Never a float. */
  amount: string;
  /** Full coin struct tag, never a symbol. */
  asset: string;
  network: SuiNetwork;
  /** Facilitator base URL; a trailing slash is tolerated. */
  facilitator: string;
  /** `strict` (default) settles before the handler runs; `fast` settles after it. */
  mode?: "strict" | "fast";
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  /** `Retry-After` on a 503; defaults to 5. */
  retryAfterSeconds?: number;
  verifyTimeoutMs?: number;
  /** Defaults to `maxTimeoutSeconds * 1000 + 10_000`. */
  settleTimeoutMs?: number;
  allowMainnet?: boolean;
  fetch?: typeof globalThis.fetch;
  /** A settlement that failed — after the content was served in fast mode, before it in strict mode. */
  onSettleFailure?: (failure: SettleFailure) => void;
  /** A successful settlement; in fast mode this is the seller's only record of it. */
  onSettled?: (settle: SettleResponse) => void;
}

export interface SellerRequest {
  /** Absolute URL of the resource being paid for; it is echoed in the 402. */
  url: string;
  paymentSignature: string | null;
}

export type SellerDecision =
  | { kind: "respond"; status: 400 | 402 | 503; headers: Record<string, string>; body: Record<string, unknown> }
  | {
      kind: "fulfill";
      headers: Record<string, string>;
      /** Fast mode: settle once the handler has run. Never rejects. Null in strict mode. */
      settleAfter: (() => Promise<SettleResponse | null>) | null;
    };

export interface Seller {
  readonly requirements: PaymentRequirements;
  readonly mode: "strict" | "fast";
  /** The 402 document, in the header and the body alike (spec-notes #1). */
  paymentRequired(url: string, error: string): { header: string; body: PaymentRequired };
  handle(request: SellerRequest): Promise<SellerDecision>;
  /** Startup check against `GET /supported`. */
  assertFacilitatorSupports(): Promise<void>;
}

/** The seller's own configuration is wrong; nothing per-request can fix it. */
export class SellerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerConfigError";
  }
}

export type FacilitatorErrorKind = "unreachable" | "timeout" | "http" | "unparseable";

/** The facilitator could not be reached or could not be understood; no verdict was reached. */
export class FacilitatorError extends Error {
  constructor(
    readonly kind: FacilitatorErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

const aborted = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const positiveInteger = (field: string, value: number): number => {
  if (!Number.isInteger(value) || value <= 0) throw new SellerConfigError(`${field} must be a positive integer`);
  return value;
};

const facilitatorBase = (facilitator: string): string => {
  let url: URL;
  try {
    url = new URL(facilitator);
  } catch {
    throw new SellerConfigError("facilitator must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SellerConfigError("facilitator must be an absolute http(s) URL");
  }
  return facilitator.replace(/\/+$/, "");
};

const buildRequirements = (options: SellerOptions): PaymentRequirements => {
  const parsed = PaymentRequirements.safeParse({
    scheme: "exact",
    network: options.network,
    amount: options.amount,
    asset: options.asset,
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: {},
  });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue === undefined) throw new SellerConfigError("payment requirements are invalid");
  throw new SellerConfigError(
    `${issue.path.length === 0 ? "requirements" : issue.path.join(".")}: ${issue.message}`,
  );
};

/** Adapters accept either; a `Seller` is shared across mounts, options build one. */
export const isSeller = (value: SellerOptions | Seller): value is Seller => "handle" in value;

export function createSeller(options: SellerOptions): Seller {
  const requirements = buildRequirements(options);
  if (requirements.network === "sui:mainnet" && options.allowMainnet !== true) {
    throw new SellerConfigError("network is sui:mainnet: set allowMainnet to take real funds");
  }
  const base = facilitatorBase(options.facilitator);
  const mode = options.mode ?? "strict";
  const retryAfter = String(
    positiveInteger("retryAfterSeconds", options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS),
  );
  const verifyTimeoutMs = positiveInteger("verifyTimeoutMs", options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
  const settleTimeoutMs = positiveInteger(
    "settleTimeoutMs",
    options.settleTimeoutMs ?? requirements.maxTimeoutSeconds * 1_000 + SETTLE_TIMEOUT_HEADROOM_MS,
  );
  // Wrapped rather than stored bare: a detached `fetch` throws in browsers.
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const onSettleFailure = options.onSettleFailure;
  const onSettled = options.onSettled;

  const send = async (path: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (aborted(e)) throw new FacilitatorError("timeout", `facilitator ${path}: no answer within ${timeoutMs}ms`);
      throw new FacilitatorError("unreachable", `facilitator ${path}: ${detail(e)}`);
    }
  };

  const read = async <T>(response: Response, schema: z.ZodType<T>, path: string): Promise<T> => {
    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      if (aborted(e)) throw new FacilitatorError("timeout", `facilitator ${path}: body never arrived`);
      throw new FacilitatorError("unparseable", `facilitator ${path}: body is not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new FacilitatorError("unparseable", `facilitator ${path}: unexpected response shape`);
    return parsed.data;
  };

  /**
   * A semantic verdict is HTTP 200, and 400 for a body the facilitator could not
   * parse — both carry a reason code (spec-notes #5). Any other status is an
   * outage, not a verdict.
   */
  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>, timeoutMs: number): Promise<T> => {
    const response = await send(
      path,
      { method: "POST", headers: { "content-type": JSON_CONTENT_TYPE }, body: JSON.stringify(body) },
      timeoutMs,
    );
    if (response.status !== 200 && response.status !== 400) {
      throw new FacilitatorError("http", `facilitator ${path}: HTTP ${response.status}`, response.status);
    }
    return read(response, schema, path);
  };

  const paymentRequired = (url: string, error: string): { header: string; body: PaymentRequired } => {
    const resource: Resource = {
      url,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    };
    const body: PaymentRequired = { x402Version: 2, error, resource, accepts: [requirements] };
    return { header: encodeHeader(body), body };
  };

  const askForPayment = (url: string, error: string): SellerDecision => {
    const { header, body } = paymentRequired(url, error);
    return {
      kind: "respond",
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED]: header, "content-type": JSON_CONTENT_TYPE },
      body,
    };
  };

  const unavailable = (e: FacilitatorError): SellerDecision => ({
    kind: "respond",
    status: 503,
    headers: { "Retry-After": retryAfter, "content-type": JSON_CONTENT_TYPE },
    body: { error: "facilitator unavailable", kind: e.kind },
  });

  /** The seller's own reporting is not allowed to break the response. */
  const report = (fn: (() => void) | undefined): void => {
    try {
      fn?.();
    } catch {
      // Deliberately swallowed: see above.
    }
  };

  /** POSTs /settle and reports the outcome; throws `FacilitatorError` when the call itself fails. */
  const settleAndReport = async (body: unknown): Promise<SettleResponse> => {
    const settle = await post("/settle", body, SettleResponse, settleTimeoutMs);
    if (settle.success) report(() => onSettled?.(settle));
    else {
      report(() =>
        onSettleFailure?.({
          reason: settle.errorReason ?? "unexpected_settle_error",
          payer: settle.payer ?? null,
          digest: settle.transaction === "" ? null : settle.transaction,
        }),
      );
    }
    return settle;
  };

  /** A fire-and-forget settle must not take the process down, whatever fails inside it. */
  const settleInBackground = async (body: unknown): Promise<SettleResponse | null> => {
    try {
      const settle = await settleAndReport(body);
      return settle.success ? settle : null;
    } catch (e) {
      report(() =>
        onSettleFailure?.({ reason: e instanceof FacilitatorError ? e.kind : detail(e), payer: null, digest: null }),
      );
      return null;
    }
  };

  /** Strict path: settled before anything is served. */
  const settleNow = async (url: string, body: unknown): Promise<SellerDecision> => {
    let settle: SettleResponse;
    try {
      settle = await settleAndReport(body);
    } catch (e) {
      if (!(e instanceof FacilitatorError)) throw e;
      // The payer resends the identical payload; the facilitator dedupes by
      // digest, so a retry cannot pay twice.
      return unavailable(e);
    }
    if (!settle.success) return askForPayment(url, settle.errorReason ?? "unexpected_settle_error");
    return { kind: "fulfill", headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settle) }, settleAfter: null };
  };

  const handle = async (request: SellerRequest): Promise<SellerDecision> => {
    if (request.paymentSignature === null) {
      return askForPayment(request.url, "PAYMENT-SIGNATURE header is required");
    }

    let raw: unknown;
    try {
      // Validated, not rewritten: `raw` is what the payer signed, and `raw` is
      // what the facilitator will judge.
      raw = decodeHeaderVerbatim(request.paymentSignature, PaymentPayload).raw;
    } catch (e) {
      if (!(e instanceof HeaderError)) throw e;
      return {
        kind: "respond",
        status: 400,
        headers: { "content-type": JSON_CONTENT_TYPE },
        body: { error: "malformed PAYMENT-SIGNATURE", reason: e.reason },
      };
    }

    const body = { x402Version: 2, paymentPayload: raw, paymentRequirements: requirements };

    let verify: VerifyResponse;
    try {
      verify = await post("/verify", body, VerifyResponse, verifyTimeoutMs);
    } catch (e) {
      if (!(e instanceof FacilitatorError)) throw e;
      return unavailable(e);
    }
    if (!verify.isValid) {
      // "invalid_transaction_state" is also what an already-executed payment
      // gets from /verify — a payer resending after a lost settle response.
      // Only /settle can tell, because it reconstructs a prior settlement
      // from chain; a genuinely stale transaction fails there too.
      if (verify.invalidReason !== "invalid_transaction_state") {
        return askForPayment(request.url, verify.invalidReason ?? "invalid_payload");
      }
      return settleNow(request.url, body);
    }

    if (mode === "fast") {
      return { kind: "fulfill", headers: {}, settleAfter: () => settleInBackground(body) };
    }
    return settleNow(request.url, body);
  };

  const assertFacilitatorSupports = async (): Promise<void> => {
    const response = await send("/supported", { method: "GET" }, verifyTimeoutMs);
    if (response.status !== 200) {
      throw new FacilitatorError("http", `facilitator /supported: HTTP ${response.status}`, response.status);
    }
    const kinds = (await read(response, Supported, "/supported")).kinds;
    if (!kinds.some((kind) => kind.scheme === "exact" && kind.network === requirements.network)) {
      throw new SellerConfigError(
        `network: ${base} does not settle exact payments on ${requirements.network}`,
      );
    }
  };

  return { requirements, mode, paymentRequired, handle, assertFacilitatorSupports };
}
