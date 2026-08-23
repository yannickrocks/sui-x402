# sui-x402

**Per-request payments for APIs on Sui, built for agents.** A TypeScript SDK and
middleware suite for the [x402 v2](https://github.com/x402-foundation/x402)
protocol: make any HTTP endpoint payable in about ten lines, and give an agent a
`fetch` that pays for what it reads. Settlement runs through the open-source
reference facilitator, used unmodified and self-hosted, so nobody in this stack
ever holds your funds or keys.

> Status: **testnet, pre-1.0, not yet on npm.** Three live payments have settled
> end to end (see [Proof](#proof)). Mainnet is gated behind explicit opt-ins.

## The problem

Machines are becoming API consumers, and the way we charge for APIs does not fit
them. API keys and monthly subscriptions assume a human who signs up, enters a
card, and remembers to cancel. An agent that needs one answer from one endpoint,
once, has no good way to pay for it — and a seller has no good way to charge it
without onboarding friction that kills the use case.

x402 fixes the protocol half: an HTTP `402 Payment Required` that carries the
price, a signed on-chain payment attached to the retried request, and a
facilitator that verifies and settles it. Stripe, AWS and Cloudflare ship it
for EVM chains. On Sui — the chain whose roadmap is agents and stablecoin
payments — there was a facilitator, but no client library and no middleware.
Every seller would have to hand-roll the money path.

## The solution

```
Agent ──@sui-x402/payer-sui──▶ Seller API ──@sui-x402/{hono,express,next}──▶ reference facilitator ──gRPC──▶ Sui
```

| Package | Role |
|---|---|
| [`@sui-x402/core`](packages/core) | Wire schemas derived from live facilitator fixtures, the header codec, reason codes, and the framework-agnostic seller core |
| [`@sui-x402/payer-sui`](packages/payer-sui) | The agent side: coin discovery, payment transaction construction, signing, and a `fetch` that pays |
| [`@sui-x402/hono`](packages/middleware-hono) · [`@sui-x402/express`](packages/middleware-express) · [`@sui-x402/next`](packages/middleware-next) | Seller adapters, each certified by one shared conformance suite |
| [`deploy/facilitator`](deploy/facilitator) | Dockerfile, Fly.io and Railway config, and a runbook for self-hosting the facilitator |

### Sell: one paid route

```ts
import { Hono } from "hono";
import { x402 } from "@sui-x402/hono";

const app = new Hono();
app.use("/paid/*", x402({
  payTo: "0xYOUR_SUI_ADDRESS",
  amount: "10000",                     // 0.01 USDC, atomic units
  asset: "0xa1ec…7e29::usdc::USDC",    // full coin type, testnet USDC
  network: "sui:testnet",
  facilitator: "https://your-facilitator.example",
}));
app.get("/paid/quote", (c) => c.json({ symbol: "SUI", quote: "1.00" }));
```

### Pay: a `fetch` that pays

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiX402Payer, ed25519SignerFromEnv } from "@sui-x402/payer-sui";

const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
const payer = new SuiX402Payer({ client, signer: ed25519SignerFromEnv() }); // PAYER_SECRET_KEY
const { response, receipt } = await payer.fetchWithReceipt("https://api.example/paid/quote");
```

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Why this design

- **Non-custodial by construction.** The payer signs a complete Sui transaction
  for exactly the advertised amount. The seller relays those bytes untouched;
  the facilitator dry-runs them and broadcasts them. No party can redirect or
  inflate a payment, and no party holds anyone's key.
- **The facilitator is reused, not rebuilt.** Replay protection, idempotent
  settlement and gRPC failover are the risky parts of a payment engine. The
  reference implementation already solves them; this repo vendors it as a
  pinned submodule and ships the deployment config. Weeks of money-path risk
  avoided, and contributions go upstream.
- **Settle before you serve.** Strict mode (the default) runs your handler only
  after settlement is final. A facilitator outage becomes `503 + Retry-After`,
  never free content. Fast mode exists for cheap content and says so.
- **One seller core, one conformance suite.** Hono, Express and Next.js
  adapters are thin translators over `createSeller`; a single 13-scenario suite
  certifies that all three behave identically.
- **Payer guardrails that survive hostile sellers.** Testnet-only by default,
  per-asset spend caps, a chain-identity check before any coin is touched, and
  at most one extra payment per call — issued only after the first payment's
  gas coin is proven unmoved on chain.
- **gRPC only, fixtures first.** Public JSON-RPC was retired in 2026; every
  chain call uses `SuiGrpcClient`. Wire schemas are derived from captured live
  facilitator responses, and a test pins the reason-code table to the vendored
  upstream source so drift fails loudly.

## How it works

A paid request, strict mode:

1. `GET /paid/quote` → `402` with `PAYMENT-REQUIRED` (price, asset, payee) in
   the header and the same JSON in the body.
2. The payer picks an acceptable offer, lists its coins, simulates a
   `split + transfer` of exactly the amount, checks the simulated balance
   change itself, and signs — the transaction is bound to the chain id and the
   current epoch, with a random nonce.
3. `GET /paid/quote` + `PAYMENT-SIGNATURE` (the signed transaction, base64).
4. The seller POSTs the payload verbatim to the facilitator's `/verify`
   (dry-run, replay check) and `/settle` (broadcast, wait for finality).
5. Only now does your handler run. The response carries `PAYMENT-RESPONSE`
   with the settlement digest.

Deeper: [docs/concepts.md](docs/concepts.md) · trust boundaries:
[docs/security-model.md](docs/security-model.md).

## Proof

Three $0.01 testnet payments settled on 2026-08-23 through the hono and express
examples, the payer, and the pinned facilitator — verified on chain with exact
±10000 USDC balance changes:
[`GE85dg3w…`](https://testnet.suivision.xyz/txblock/GE85dg3wNUdfRKJpFW9bBz2qkk4qgvgihWxMrFzDfc4T)
· [`CKYr3pP6…`](https://testnet.suivision.xyz/txblock/CKYr3pP6Amrg62C9kxZX5w2UVfitDTBJeE2zjdfjnZZU)
· [`5MGrTQ82…`](https://testnet.suivision.xyz/txblock/5MGrTQ82xhYeciurZssjTcnLvRn4rdp1wkorEJaA7bAB).
The unit and conformance suites add 346 tests; the money path went through two
adversarial review rounds (recorded in [docs/journal.md](docs/journal.md)).

## Documentation

| | |
|---|---|
| [Overview](docs/overview.md) | Problem, solution, who it is for, non-goals |
| [Quickstart](docs/quickstart.md) | A paid API in 10 lines, a paying agent in 5 |
| [Concepts](docs/concepts.md) | The payment lifecycle, headers, modes, expiry, retries |
| [Guide: sell](docs/guides/sell.md) | Make a route payable with Hono, Express or Next.js |
| [Guide: pay](docs/guides/pay.md) | Build a paying agent with `@sui-x402/payer-sui` |
| [Security model](docs/security-model.md) | Trust boundaries, double-pay defenses, residual risks |
| [Facilitator runbook](docs/facilitator-runbook.md) | Self-host the reference facilitator |
| [FAQ](docs/faq.md) | Short answers |
| [Spec notes](docs/spec-notes.md) | Where the live facilitator differs from the spec |

## Develop

```sh
git clone --recurse-submodules https://github.com/yannickrocks/sui-x402
pnpm install
pnpm typecheck && pnpm test        # 13 turbo tasks; e2e tests skip without E2E=1 + PAYER_SECRET_KEY
pnpm --filter example-hono-server dev
```

Node 22, pnpm 9. Publishing uses [Changesets](.changeset/README.md).
