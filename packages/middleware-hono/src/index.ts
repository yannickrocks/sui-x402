/**
 * @sui-x402/hono — the x402 seller paywall for Hono routes.
 *
 * Every decision belongs to `@sui-x402/core`'s seller: what a 402 says, when a
 * payment header is malformed, whether the facilitator answered, and whether
 * the handler may run at all. This module only moves a Hono request into a
 * `SellerRequest` and a `SellerDecision` back out, so `@sui-x402/hono`,
 * `@sui-x402/express` and `@sui-x402/next` share one conformance suite.
 *
 * Two invariants live in the translation. A `respond` decision never calls
 * `next()`, so content is never fulfilled unpaid. And the PAYMENT-SIGNATURE
 * header is handed to the seller exactly as it arrived — the facilitator judges
 * the bytes the payer signed.
 *
 * `x402()` never contacts the facilitator at construction: call
 * `seller.assertFacilitatorSupports()` when the app boots so a network or
 * scheme mismatch fails loudly at startup rather than once per request
 * (PRD §8.15).
 */
import type { MiddlewareHandler } from "hono";
import {
  HEADER_PAYMENT_SIGNATURE,
  createSeller,
  isSeller,
  type Seller,
  type SellerOptions,
} from "@sui-x402/core";

export { createSeller } from "@sui-x402/core";
export type { Seller, SellerOptions } from "@sui-x402/core";

/**
 * Makes the routes it is mounted on payable. Pass options to build a seller, or
 * a `Seller` to share one instance (and one set of terms) across several mounts.
 */
export function x402(options: SellerOptions | Seller): MiddlewareHandler {
  const seller = isSeller(options) ? options : createSeller(options);

  return async (c, next) => {
    const decision = await seller.handle({
      url: c.req.url,
      paymentSignature: c.req.header(HEADER_PAYMENT_SIGNATURE) ?? null,
    });
    for (const [name, value] of Object.entries(decision.headers))
      c.header(name, value);

    if (decision.kind === "respond")
      return c.json(decision.body, decision.status);

    await next();
    // Fast mode: the response leaves now; settlement runs behind it and is
    // reported through onSettled / onSettleFailure. `settleAfter` never rejects.
    if (decision.settleAfter !== null) void decision.settleAfter();
  };
}
