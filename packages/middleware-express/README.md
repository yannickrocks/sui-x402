# @sui-x402/express

x402 v2 paywall middleware for [Express](https://expressjs.com) 4, for the
`exact` scheme on Sui. Mount it on a route and that route is payable: unpaid
requests get a 402 carrying your terms, paid ones reach your handler only after
the facilitator has accepted the payment.

Every decision comes from `@sui-x402/core`'s framework-free seller, so this
package behaves identically to `@sui-x402/hono` and `@sui-x402/next` — the three
share one conformance suite. Verification, settlement and replay protection
belong to the facilitator; nothing here inspects a transaction.

## Install

```sh
pnpm add @sui-x402/express express
```

## Example

```ts
import express from "express";
import { x402 } from "@sui-x402/express";

const app = express();

app.get(
  "/signal/whales",
  x402({
    payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
    amount: "10000", // atomic units: 0.01 USDC (6 dp)
    asset:
      "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    network: "sui:testnet",
    facilitator: "https://your-facilitator.example",
  }),
  (_req, res) => res.json({ whales: [] })
);

app.listen(3000);
```

`x402` also accepts a `Seller` built by `createSeller` (re-exported here), which
lets you check the facilitator at startup with `await
seller.assertFacilitatorSupports()` and share one seller across routes.

## Responses

| Status | When                                                                       | Carries                                                                                                           |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 402    | No `PAYMENT-SIGNATURE`, or the facilitator rejected the payment            | `PAYMENT-REQUIRED` header plus the identical JSON as the body; the reason code is in the document's `error` field |
| 400    | `PAYMENT-SIGNATURE` is not decodable as an x402 payment document           | `{ error, reason }`; the facilitator is never called                                                              |
| 503    | The facilitator was unreachable, timed out, or answered something unusable | `Retry-After` (default 5 s) and `{ error, kind }`                                                                 |
| 200    | Payment settled (strict) or verified (fast)                                | Your handler's response, plus `PAYMENT-RESPONSE` in strict mode                                                   |

A facilitator outage is never a 200: content is not served unpaid. The payer is
expected to resend the identical payload, which the facilitator deduplicates, so
a retry cannot pay twice.

The payer-signed document is relayed to the facilitator byte for byte. It is
validated, never rewritten.

## Strict vs fast

`mode: "strict"` (default) verifies and settles before `next()` is called; a
facilitator outage is `503` + `Retry-After` (the payer resends the same
payment), a failed settlement withholds the content, and the digest reaches
the payer in `PAYMENT-RESPONSE`.

`mode: "fast"` calls `next()` as soon as verification passes and settles once
the response is over (`finish`, or `close` when the client went away
mid-body). Between verify and settle the payer's coins can be spent elsewhere,
so only use it for content you could afford to give away. Fast mode attaches
no `PAYMENT-RESPONSE`; the outcome reaches only `onSettled` /
`onSettleFailure`.

## Node's 16 KiB header limit

A `PAYMENT-SIGNATURE` header carries a complete signed transaction and routinely
exceeds Node's default 16 KiB limit for the whole header block. Node answers such
a request with **431 before Express — and therefore this middleware — sees it**,
so raise the limit on any server that takes real payments:

```ts
import { createServer } from "node:http";

createServer({ maxHeaderSize: 262_144 }, app).listen(3000);
```

`app.listen()` gives you no way to set this, so use `createServer` as above, or
start the process with `node --max-http-header-size=262144`. Reverse proxies
have their own limits (nginx: `large_client_header_buffers`).

## Testnet by default

`network` is a full CAIP-2-style id and there is no default: pass
`"sui:testnet"`. `"sui:mainnet"` is refused with a `SellerConfigError` unless you
also pass `allowMainnet: true`, so no deployment takes real funds by accident.

`amount` is always an atomic-unit string (USDC 6 dp, SUI 9 dp) and `asset` is
always a full coin struct tag, never a symbol.
