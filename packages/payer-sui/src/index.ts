/**
 * @sui-x402/payer-sui — agent/client-side lib. Wraps fetch: on 402, builds a Sui
 * payment tx per the returned requirements, signs, retries with the payload.
 *
 * NOTE (P0 skeleton): tx construction uses `Transaction` from @mysten/sui and
 * coin selection via gRPC (public JSON-RPC on fullnode.*.sui.io was RETIRED
 * in July 2026 — use SuiGrpcClient, not SuiClient/JSON-RPC).
 */
import {
  PaymentRequirements, HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE,
  encodeHeader, decodeHeader,
} from "@sui-x402/core";
import { z } from "zod";

export {
  discoverCoins,
  selectCoins,
  InsufficientBalanceError,
  MAX_INPUT_COINS,
  type CoinRef,
  type OwnedCoin,
  type CoinSource,
  type CoinSelection,
} from "./coins.js";
export {
  buildPaymentTransaction,
  computeGasBudget,
  receivedBy,
  PaymentBuildError,
  DEFAULT_GAS_HEADROOM_PERCENT,
  DEFAULT_MAX_GAS_BUDGET,
  type BuildPaymentOptions,
  type BuiltPayment,
  type PaymentClient,
  type PaymentBuildReason,
} from "./tx.js";

const RequiredHeader = z.object({
  x402Version: z.literal(2),
  accepts: z.array(PaymentRequirements).min(1),
  resource: z.object({ url: z.string(), description: z.string().optional() }).partial(),
});

export interface PayerSigner {
  /** Sign complete tx bytes; return base64 serialized signature. */
  signTransaction(txBytes: Uint8Array): Promise<string>;
  address(): string;
}

export interface PayerOptions {
  signer: PayerSigner;
  /** Build + serialize a signed payment tx for the chosen requirements.
   *  Injected so the core stays chain-SDK-agnostic; default impl ships in
   *  @sui-x402/payer-sui (TODO P1): coin discovery (gRPC), merge fragmented
   *  coins, splitCoins+transfer, gas budget with headroom, optional gas
   *  station flow via requirements.extra.gasStation. */
  buildPayment(req: PaymentRequirements): Promise<{ transaction: string; signature: string }>;
  /** Pick from server's accepts[]; default: first supported network. */
  select?(accepts: PaymentRequirements[]): PaymentRequirements;
}

export class SuiX402Payer {
  constructor(private opts: PayerOptions) {}

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const first = await fetch(input, init);
    if (first.status !== 402) return first;

    const hdr = first.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!hdr) return first; // 402 without terms — nothing we can do
    const terms = decodeHeader(hdr, RequiredHeader);
    const req = (this.opts.select ?? ((a) => a[0]))(terms.accepts);

    const { transaction, signature } = await this.opts.buildPayment(req);
    const payload = {
      x402Version: 2 as const,
      resource: { url: String(input) },
      accepted: req,
      payload: { transaction, signature },
    };

    const headers = new Headers(init.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, encodeHeader(payload));
    return fetch(input, { ...init, headers });
  }
}
