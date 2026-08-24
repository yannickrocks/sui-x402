# @sui-x402/next

x402 paywall for Next.js App Router route handlers on Sui. Wrap a handler, and
the route answers `402 Payment Required` with the terms, verifies and settles a
payment through the reference facilitator, and only then runs your code.

## Install

```sh
pnpm add @sui-x402/next
```

## Example

`app/api/quote/route.ts`:

```ts
import { withX402 } from "@sui-x402/next";

export const runtime = "nodejs"; // the header codec needs Buffer; the edge runtime has none

const paywall = withX402({
  payTo: process.env.PAY_TO!, // your Sui address
  amount: "10000", // 0.01 USDC, atomic units
  asset: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC", // testnet USDC
  network: "sui:testnet",
  facilitator: process.env.FACILITATOR_URL!, // your self-hosted facilitator
});

export const GET = paywall(async () => Response.json({ symbol: "SUI", quote: "…" }));
```

An agent pays it with `@sui-x402/payer-sui`; `curl -i` shows the 402 and its
`PAYMENT-REQUIRED` header.

## API

| Export | Kind | What it is |
|---|---|---|
| `withX402(options \| seller)` | function | Returns a wrapper: `withX402(opts)(handler)` is a route handler that pays the wrapped one. |
| `RouteHandler<Context>` | type | `(request: Request, context: Context) => Response \| Promise<Response>` — what Next calls. |
| `createSeller`, `Seller`, `SellerOptions` | re-export | From `@sui-x402/core`; build one seller and share it across routes. |

## Notes

**Node runtime, route handlers only.** `export const runtime =
"nodejs"` in every wrapped route file. Do not wrap `middleware.ts`: it runs on
the edge runtime, where the header codec's `Buffer` does not exist.

**Strict vs fast.** `mode: "strict"` (default) settles before your handler runs
and returns the settlement digest in `PAYMENT-RESPONSE`. `mode: "fast"` returns
your handler's response as soon as verification passes and settles behind it,
reporting only through `onSettled` / `onSettleFailure`. On serverless hosts
the function may be frozen once the response is sent, so settlement may never
run — use strict there.

**What the payer sees.** `402` with `PAYMENT-REQUIRED` (and the same JSON body)
until it pays; `400` on a malformed `PAYMENT-SIGNATURE`; `503` + `Retry-After`
when the facilitator is unreachable, so the payer resends the same payment;
`402` with the facilitator's reason code in the document's `error` field when
the payment is refused.

**Header size.** A signed payment is up to 120 KB of base64 in one header, above
Node's 16 KiB default. Start Next with `NODE_OPTIONS=--max-http-header-size=262144`.

**Testnet by default.** `network: "sui:mainnet"` throws unless `allowMainnet: true`.

**Startup check.** Call `seller.assertFacilitatorSupports()` once at boot
(instrumentation hook or first request) so a facilitator that does not serve
your network fails loudly rather than per request.
