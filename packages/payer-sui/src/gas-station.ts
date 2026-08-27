/**
 * HTTP client for the reference facilitator's Enoki gas station.
 *
 * Deliberately exposes only the sponsor half (`POST /gas-station`): broadcast
 * belongs to the facilitator's settle, and an SDK method for
 * `/gas-station/execute` would invite a seller to call it.
 */

export interface SponsorRequest {
  sender: string;
  /** base64 of `build({ onlyTransactionKind: true })`. */
  transactionKindBytes: string;
  /** Full network id, e.g. `"sui:testnet"` — sent unsplit; the facilitator derives the bare Enoki id itself. */
  network: string;
  /** Addresses the sponsored tx may touch. MUST include `payTo`. */
  recipients?: string[];
}

export interface SponsorResult {
  /** base64 full sponsored `TransactionData`. */
  bytes: string;
  digest: string;
}

export interface GasStationClient {
  sponsor(req: SponsorRequest): Promise<SponsorResult>;
  /** Base URL this client posts to — compared against the seller's advertisement. */
  readonly baseUrl: string;
}

export type GasStationErrorKind =
  | "not_configured" // 503 {"error":"sponsorship not configured"}
  | "sender_cap" // 429 {"error":"daily sponsorship limit reached"}
  | "global_cap" // 503 {"error":"sponsorship temporarily unavailable"}
  | "rate_limited" // 429 {"error":"rate limited"}
  | "deployment_mismatch" // configured gas station != the seller's advertised one; local, pre-flight
  | "rejected" // 400 (bad request) or 502 (Enoki passthrough)
  | "unreachable"
  | "timeout"
  | "unparseable";

export class GasStationError extends Error {
  constructor(
    readonly kind: GasStationErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GasStationError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Upstream discriminates the two 429s and two 503s only by the `error` string. */
const kindOf = (status: number, error: string): GasStationErrorKind => {
  if (status === 503)
    return error === "sponsorship temporarily unavailable"
      ? "global_cap"
      : "not_configured";
  if (status === 429)
    return error === "daily sponsorship limit reached"
      ? "sender_cap"
      : "rate_limited";
  return "rejected";
};

export function httpGasStation(
  baseUrl: string,
  options?: { fetch?: typeof globalThis.fetch; timeoutMs?: number }
): GasStationClient {
  const doFetch =
    options?.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/gas-station`;
  return {
    baseUrl,
    async sponsor(req: SponsorRequest): Promise<SponsorResult> {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "TimeoutError") {
          throw new GasStationError(
            "timeout",
            `gas station timed out after ${timeoutMs}ms: ${endpoint}`
          );
        }
        throw new GasStationError(
          "unreachable",
          `gas station unreachable: ${endpoint}: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        throw new GasStationError(
          "unparseable",
          `gas station answered ${response.status} with a non-JSON body`,
          response.status
        );
      }
      if (!response.ok) {
        const error =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "";
        throw new GasStationError(
          kindOf(response.status, error),
          `gas station refused: ${response.status}${
            error === "" ? "" : ` ${error}`
          }`,
          response.status
        );
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("bytes" in body) ||
        typeof body.bytes !== "string" ||
        !("digest" in body) ||
        typeof body.digest !== "string"
      ) {
        throw new GasStationError(
          "unparseable",
          "gas station success body is missing bytes/digest",
          response.status
        );
      }
      return { bytes: body.bytes, digest: body.digest };
    },
  };
}
