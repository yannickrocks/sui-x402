# @sui-x402/hono

The [x402 v2](https://github.com/x402-foundation/x402) seller paywall for
[Hono](https://hono.dev). Mount it on a route and the route is payable: callers
without a valid payment get a `402` carrying your terms, callers with one get
the content and a settlement receipt.

Every decision — the 402 document, the malformed-header `400`, the
facilitator-unavailable `503`, and whether your handler is allowed to run —
belongs to `@sui-x402/core`'s seller. This package only translates a Hono
request into a `SellerRequest` and a `SellerDecision` back into a Hono
response, so it behaves identically to `@sui-x402/express` and `@sui-x402/next`
and is tested against the same conformance suite.

Verification, settlement and replay protection belong to the facilitator.
Nothing here inspects a transaction, and the payer-signed `PAYMENT-SIGNATURE`
header reaches the facilitator byte for byte as the payer sent it.

## Install

```sh
pnpm add @sui-x402/hono hono
```

> Not yet on npm; the first release is imminent. Until then, clone the repo
> and `pnpm install` to use the packages from source.

## Example

```ts
import { Hono } from "hono";
import { createSeller, x402 } from "@sui-x402/hono";

const seller = createSeller({
  payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
  amount: "10000", // atomic units — 0.01 USDC at 6 decimals. Never a float.
  asset:
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  network: "sui:testnet",
  facilitator: process.env.X402_FACILITATOR_URL ?? "http://localhost:8080",
  description: "Recent large SUI transfers",
});

// Fail loudly at startup, not once per request.
await seller.assertFacilitatorSupports();

const app = new Hono();
app.use("/paid/*", x402(seller));
app.get("/paid/whales", (c) => c.json({ whales: [] }));
```

`x402()` also accepts the options object directly (`app.use("/paid/*",
x402({ payTo, amount, ... }))`) when you do not need the `Seller` handle. Pass a
shared `Seller` when several mounts advertise the same terms; each mount still
echoes its own route in `resource.url`.

`x402()` never contacts the facilitator on its own, so `assertFacilitatorSupports()`
is the call that turns a wrong network, a wrong scheme or a dead facilitator into
a boot failure instead of a per-request `503`.

## What the payer sees

| Status                     | Meaning                                                                                                                                    | What a payer does                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `402` + `PAYMENT-REQUIRED` | Terms, or a rejected payment. The body is the same JSON as the base64 header, and its `error` field carries the facilitator's reason code. | Build a payment against `accepts[0]`, or read the reason code through core's `retryHint` and retry, refetch terms, or give up. |
| `400`                      | The `PAYMENT-SIGNATURE` header itself is unreadable (not base64, not JSON, wrong shape, over the size cap). The body carries `reason`.     | Fix the client. Retrying the same header cannot help.                                                                          |
| `503` + `Retry-After`      | The facilitator could not be reached or could not be understood. No verdict was reached and no content was served.                         | Wait `Retry-After` seconds and resend the identical payload — the facilitator dedupes by digest, so a retry cannot pay twice.  |
| `200` + `PAYMENT-RESPONSE` | Paid. The header carries the settlement, including the transaction digest.                                                                 | Nothing.                                                                                                                       |

## Strict vs fast

`mode: "strict"` (default) verifies and settles the payment before your handler
runs; if the facilitator cannot be reached the payer gets `503` + `Retry-After`
and resends the same payment, and if settlement fails the content is withheld.
The settlement digest reaches the payer in `PAYMENT-RESPONSE`.

`mode: "fast"` serves the content as soon as verification passes and settles
behind the response, so the payer waits only for the dry-run. The cost is
equivocation: between verify and settle the payer's coins can be spent
elsewhere, and then you have served something you were never paid for. Fast
mode attaches no `PAYMENT-RESPONSE`; the outcome reaches only your
`onSettled` / `onSettleFailure` callbacks. Use strict for anything you would
not give away.

## Header size on Node

A signed Sui payment is up to 120 KB of base64, and Node's HTTP server rejects
header blocks over 16 KiB by default — the request never reaches Hono, so you
see a connection-level `431`, not a `400`. With `@hono/node-server`, raise it:

```ts
import { serve } from "@hono/node-server";

serve({
  fetch: app.fetch,
  port: 3000,
  serverOptions: { maxHeaderSize: 262_144 },
});
```

Or start Node with `--max-http-header-size=262144`. Node is the runtime where
this is a flag you raise; every other runtime imposes its own request-header cap
that you have to check against a 120 KB payment before you ship. Cloudflare
Workers in particular caps total request headers low enough that a large signed
payment may not fit at all, with no setting to raise it — check the current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
rather than assuming.

## Network

`network` is required, and `sui:testnet` is what every example and every config
in this repo uses. `sui:mainnet` is refused at construction unless you also pass
`allowMainnet: true`, so real funds are never moved by an unreviewed default.

Do not point production at someone else's hosted facilitator. Self-host: see
[`deploy/facilitator/`](../../deploy/facilitator/).

## API

| Export                    | What it is                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `x402(options \| seller)` | Hono `MiddlewareHandler` that makes the routes it is mounted on payable.                                          |
| `createSeller(options)`   | Re-exported from `@sui-x402/core`; builds the `Seller` to share across mounts.                                    |
| `SellerOptions`, `Seller` | Re-exported types. Options, defaults and `SettleFailure` are documented in [`@sui-x402/core`](../core/README.md). |
