/**
 * @sui-x402/core — shared x402 v2 types + Zod schemas for the Sui `exact` scheme.
 * Spec: x402-foundation/x402 specs/schemes/exact/scheme_exact_sui.md
 */
import { z } from "zod";

// Network ids. NOTE: spec defines sui:mainnet; sui:testnet is the de facto
// (CAIP-2 style) id used by the reference facilitator — not yet canonical.
export const SuiNetwork = z.enum(["sui:mainnet", "sui:testnet"]);
export type SuiNetwork = z.infer<typeof SuiNetwork>;

// Amounts are atomic-unit strings (USDC 6dp, SUI 9dp). Never floats.
const AmountString = z.string().regex(/^[0-9]+$/, "atomic units, base-10 string");

export const PaymentRequirements = z.object({
  scheme: z.literal("exact"),
  network: SuiNetwork,
  amount: AmountString,
  asset: z.string().min(1),            // full struct tag, e.g. 0x…::usdc::USDC
  payTo: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  maxTimeoutSeconds: z.number().int().positive().default(60),
  extra: z.record(z.unknown()).default({}), // may carry { gasStation: url }
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const PaymentPayload = z.object({
  x402Version: z.literal(2),
  resource: z.object({
    url: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  accepted: PaymentRequirements, // must EQUAL the server's requirements (facilitator enforces)
  payload: z.object({
    signature: z.string().min(1),
    transaction: z.string().min(1).max(120_000), // Base64 signed Sui tx bytes
  }),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

export const VerifyResponse = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

export const SettleResponse = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string(), // tx digest
  network: z.string(),
  amount: z.string().optional(), // actual received (execution truth)
});
export type SettleResponse = z.infer<typeof SettleResponse>;

// x402 HTTP headers
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export const encodeHeader = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString("base64");
export const decodeHeader = <T>(s: string, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(Buffer.from(s, "base64").toString("utf8")));
