# sui-x402

TypeScript SDK and middleware for [x402 v2](https://github.com/x402-foundation/x402)
payments on Sui: make any API payable in 10 lines, and give agents a `fetch` that
pays. Settlement goes through the open-source reference facilitator
([DrVelvetFog/sui-x402-facilitator](https://github.com/DrVelvetFog/sui-x402-facilitator)),
used unmodified and self-hosted — this repo never holds funds or keys.

**Status:** testnet, pre-1.0, not yet on npm. The live end-to-end payment is
gated on a funded wallet (`docs/BLOCKED.md`).

| Package | What it is |
|---|---|
| `@sui-x402/core` | Wire schemas (zod, fixture-derived), header codec, reason codes, and the framework-agnostic seller core |
| `@sui-x402/payer-sui` | The agent side: coin discovery, payment tx construction, signing, the paying `fetch` |
| `@sui-x402/hono` · `@sui-x402/express` · `@sui-x402/next` | Seller adapters, one shared conformance suite |
| `examples/hono-server` · `examples/express-server` · `examples/next-paywall` | Runnable sellers |
| `deploy/facilitator` | Dockerfile, Fly/Railway config and runbook for self-hosting the facilitator |

Start with [`docs/quickstart.md`](docs/quickstart.md). Design record:
[`docs/journal.md`](docs/journal.md) (decisions D1–D13), live-facilitator
observations in [`docs/spec-notes.md`](docs/spec-notes.md), the human queue in
[`docs/BLOCKED.md`](docs/BLOCKED.md).

## Develop

```sh
pnpm install
pnpm typecheck && pnpm test        # 13 turbo tasks; e2e tests skip without E2E=1 + PAYER_SECRET_KEY
pnpm --filter example-hono-server dev
```

Requires Node 22 and pnpm 9. The facilitator is a git submodule
(`git submodule update --init`).
