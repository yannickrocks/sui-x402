/**
 * @sui-x402/next — the x402 seller paywall for Next.js App Router route
 * handlers.
 *
 * Every decision belongs to `@sui-x402/core`'s seller; this module only moves
 * a web `Request` into a `SellerRequest` and a `SellerDecision` back into the
 * `Response` a route handler returns, so `@sui-x402/hono`, `@sui-x402/express`
 * and `@sui-x402/next` share one conformance suite. A `respond` decision never
 * runs the wrapped handler, so content is never fulfilled unpaid, and the
 * PAYMENT-SIGNATURE header reaches the seller exactly as it arrived.
 *
 * Node runtime only: the header codec needs `Buffer`, which the edge runtime
 * lacks. Wrap route handlers, not `middleware.ts` — that file runs
 * on the edge.
 */
import { HEADER_PAYMENT_SIGNATURE, createSeller, isSeller, type Seller, type SellerOptions } from "@sui-x402/core";

export { createSeller } from "@sui-x402/core";
export type { Seller, SellerOptions } from "@sui-x402/core";

/** An App Router route handler; `context` is whatever Next passes (`{ params }`). */
export type RouteHandler<Context = unknown> = (request: Request, context: Context) => Response | Promise<Response>;

/**
 * Makes a route handler payable: `export const GET = withX402(options)(handler)`.
 * Pass a `Seller` to share one instance (and one set of terms) across routes.
 */
export function withX402(options: SellerOptions | Seller): <Context>(handler: RouteHandler<Context>) => RouteHandler<Context> {
  const seller = isSeller(options) ? options : createSeller(options);

  return (handler) => async (request, context) => {
    const decision = await seller.handle({
      url: request.url,
      paymentSignature: request.headers.get(HEADER_PAYMENT_SIGNATURE),
    });
    if (decision.kind === "respond") {
      return Response.json(decision.body, { status: decision.status, headers: decision.headers });
    }

    const response = await handler(request, context);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(decision.headers)) headers.set(name, value);
    // Fast mode: settlement runs behind the response and is reported through
    // onSettled / onSettleFailure. Serverless hosts may freeze it — use strict there.
    if (decision.settleAfter !== null) void decision.settleAfter();
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
