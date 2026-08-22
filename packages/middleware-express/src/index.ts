/**
 * @sui-x402/express — the seller paywall as an Express request handler.
 *
 * Every decision belongs to `createSeller` in `@sui-x402/core`; this module only
 * maps an Express request to a `SellerRequest` and the `SellerDecision` back to
 * a response, so it behaves exactly like the Hono and Next adapters.
 */
import type { RequestHandler } from "express";
import {
  HEADER_PAYMENT_SIGNATURE,
  createSeller,
  isSeller,
  type Seller,
  type SellerOptions,
} from "@sui-x402/core";

export {
  FacilitatorError,
  SellerConfigError,
  createSeller,
} from "@sui-x402/core";
export type {
  FacilitatorErrorKind,
  Seller,
  SellerDecision,
  SellerOptions,
  SellerRequest,
  SettleFailure,
} from "@sui-x402/core";

/**
 * Guards the routes it is mounted on. In strict mode (the default) the payment
 * has settled before the next handler runs; in fast mode settlement starts once
 * the response is over and is reported through `onSettled` / `onSettleFailure`.
 */
export function x402(options: SellerOptions | Seller): RequestHandler {
  const seller = isSeller(options) ? options : createSeller(options);
  return (req, res, next) => {
    const url = `${req.protocol}://${req.get("host") ?? "localhost"}${
      req.originalUrl
    }`;
    seller
      .handle({
        url,
        paymentSignature: req.get(HEADER_PAYMENT_SIGNATURE) ?? null,
      })
      .then((decision) => {
        if (decision.kind === "respond") {
          // Not `res.json`: `json spaces` would reformat the 402 body and break
          // its byte identity with the PAYMENT-REQUIRED header (spec-notes #1).
          res
            .status(decision.status)
            .set(decision.headers)
            .send(JSON.stringify(decision.body));
          return;
        }
        res.set(decision.headers);
        const settleAfter = decision.settleAfter;
        if (settleAfter !== null) {
          // Fast mode: settle once the response is over, whether it finished
          // or the client went away mid-body (`close` without `finish`).
          let started = false;
          const settleOnce = (): void => {
            if (started) return;
            started = true;
            void settleAfter();
          };
          res.once("finish", settleOnce);
          res.once("close", settleOnce);
        }
        next();
      })
      .catch(next);
  };
}
