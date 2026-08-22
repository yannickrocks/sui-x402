/**
 * @sui-x402/core — x402 v2 wire schemas for the Sui `exact` scheme.
 *
 * Shapes are derived from captured facilitator traffic (`fixtures/`) and the
 * reference facilitator's `checkStructure`, not from memory. Schemas describe
 * the wire exactly: no defaults, no coercion — middleware and payer must relay
 * what they received unchanged (see docs/spec-notes.md).
 *
 * Spec: x402-foundation/x402 specs/schemes/exact/scheme_exact_sui.md
 */
import { z } from "zod";

// Network ids. Spec defines sui:mainnet; sui:testnet is the CAIP-2-style id the
// reference facilitator uses. Our own config never enables mainnet (CLAUDE.md
// rule 3) but inbound documents from the live instance legitimately carry it.
export const SuiNetwork = z.enum(["sui:mainnet", "sui:testnet"]);
export type SuiNetwork = z.infer<typeof SuiNetwork>;

// Atomic units (USDC 6dp, SUI 9dp) as a base-10 string. The facilitator
// rejects amounts <= 0, so we do too. Never a float.
export const AmountString = z
  .string()
  .regex(/^[0-9]*[1-9][0-9]*$/, "atomic units, positive base-10 string");

// Hex address; the facilitator normalizes with normalizeSuiAddress, so short
// forms are accepted on the wire. Equality checks must normalize first.
export const SuiAddress = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "sui address");

// Full coin struct tag `0x<pkg>::<module>::<Name>[<...>]`. A bare symbol like
// "USDC" is never a valid asset (CLAUDE.md rule 8).
export const StructTag = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(<.+>)?$/, "coin struct tag");

// Canonical padded base64 — what @mysten/sui's fromBase64 accepts.
export const Base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "base64");

// Mirrors the reference facilitator's cap on `payload.transaction`.
export const MAX_TRANSACTION_BASE64_CHARS = 120_000;

export const PaymentRequirements = z.object({
  scheme: z.literal("exact"),
  network: SuiNetwork,
  amount: AmountString,
  asset: StructTag,
  payTo: SuiAddress,
  maxTimeoutSeconds: z.number().int().nonnegative(),
  extra: z.record(z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const Resource = z.object({
  url: z.string().url(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type Resource = z.infer<typeof Resource>;

/** Body and `PAYMENT-REQUIRED` header of a 402 — identical JSON on the wire. */
export const PaymentRequired = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: Resource,
  accepts: z.array(PaymentRequirements).min(1),
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequired>;

/** Sui `exact` scheme payload: the payer's complete signed transaction. */
export const SuiExactPayload = z.object({
  signature: Base64.min(1),
  transaction: Base64.min(1).max(MAX_TRANSACTION_BASE64_CHARS),
});
export type SuiExactPayload = z.infer<typeof SuiExactPayload>;

/** Decoded `PAYMENT-SIGNATURE` header. */
export const PaymentPayload = z.object({
  x402Version: z.literal(2),
  resource: Resource.optional(),
  accepted: PaymentRequirements, // facilitator checks it matches the server's requirements
  payload: SuiExactPayload,
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

/** Body of `POST /verify` and `POST /settle`. */
export const FacilitatorRequest = z.object({
  x402Version: z.literal(2),
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
});
export type FacilitatorRequest = z.infer<typeof FacilitatorRequest>;

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
  transaction: z.string(), // settlement digest; "" on failure
  network: z.string(), // "" when the failure happened before network resolution
  amount: z.string().optional(), // atomic units actually received by payTo
});
export type SettleResponse = z.infer<typeof SettleResponse>;

/** `GET /supported` */
export const SupportedKind = z.object({
  x402Version: z.literal(2),
  scheme: z.string(),
  network: SuiNetwork,
  extra: z.record(z.unknown()).optional(),
});
export const Supported = z.object({
  kinds: z.array(SupportedKind),
  extensions: z.array(z.string()),
  signers: z.record(z.array(z.string())),
});
export type Supported = z.infer<typeof Supported>;

// x402 HTTP headers
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export const encodeHeader = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString("base64");
export const decodeHeader = <T>(s: string, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(Buffer.from(s, "base64").toString("utf8")));
