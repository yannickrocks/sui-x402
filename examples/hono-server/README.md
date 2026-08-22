# example-hono-server

A runnable x402 seller on [Hono](https://hono.dev): one free route and one paid
route, guarded by [`@sui-x402/hono`](../../packages/middleware-hono). Callers
without a payment get a `402` carrying the terms; callers with one get the
content and a settlement receipt.

| Route              | Price                                  |
| ------------------ | -------------------------------------- |
| `GET /health`      | free — `{ "ok": true }`                |
| `GET /paid/quote`  | `AMOUNT` atomic units of `ASSET`       |

The quote itself is synthetic. What the example demonstrates is the payment
loop, not a price feed.

## Run it

```sh
cp examples/hono-server/.env.example examples/hono-server/.env
# set PAY_TO to an address you control (not the payer's own address)
set -a; source examples/hono-server/.env; set +a
pnpm --filter example-hono-server dev
```

Every variable is documented in [`.env.example`](./.env.example). Only `PAY_TO`
is required; `FACILITATOR_URL` defaults to `http://localhost:4402`, the
self-hosted facilitator from [`deploy/facilitator`](../../deploy/facilitator)
(PRD §8.16). The public testnet demo instance,
`https://sui-facilitator.onrender.com`, is fine for a first run.

The server calls `seller.assertFacilitatorSupports()` before it listens, so a
facilitator that is down, or one that does not settle `exact` payments on your
network, is a startup failure rather than a `503` on every request (PRD §8.15).
Nothing secret is read or logged here: the seller side of x402 never holds a key.

## What a caller sees

```sh
$ curl -si localhost:8402/paid/quote | head -3
HTTP/1.1 402 Payment Required
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIg…
```

The header is the base64 of the same JSON the body carries, so either one can be
decoded:

```sh
$ curl -si localhost:8402/paid/quote \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "http://localhost:8402/paid/quote",
    "description": "A synthetic SUI quote",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "sui:testnet",
      "amount": "10000",
      "asset": "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
      "payTo": "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
      "maxTimeoutSeconds": 60,
      "extra": {}
    }
  ]
}
```

## Paying it

[`@sui-x402/payer-sui`](../../packages/payer-sui) wraps `fetch`: it reads the
402, builds and signs a Sui payment, and replays the request with the
`PAYMENT-SIGNATURE` header.

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiX402Payer, ed25519SignerFromEnv } from "@sui-x402/payer-sui";

const asset =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const payer = new SuiX402Payer({
  client: new SuiGrpcClient({ network: "testnet" }),
  signer: ed25519SignerFromEnv(), // reads PAYER_SECRET_KEY
  // A ceiling, so a seller that raised its price cannot be paid by accident.
  select: { assets: [asset], maxAmount: { [asset]: 10_000n } },
});

const { response, receipt } = await payer.fetchWithReceipt(
  "http://localhost:8402/paid/quote",
);
console.log(response.status, await response.json());
console.log("settled in", receipt?.digest);
```

## The e2e loop

[`test/e2e.test.ts`](./test/e2e.test.ts) runs the whole thing — server, payer,
live testnet facilitator — and asserts `402 → pay → 200`, a settlement receipt,
and that the next unpaid request is `402` again. It spends real testnet USDC, so
it skips unless `E2E`, `PAYER_SECRET_KEY` and `PAY_TO` are all set:

```sh
set -a; source examples/hono-server/.env; set +a
E2E=1 pnpm --filter example-hono-server test
```

Funding the payer wallet is a human step; see `docs/BLOCKED.md` #1.
