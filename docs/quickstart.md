# Quickstart — a paid API on Sui in 10 lines

Time: under 15 minutes. You need Node 22, pnpm, and a facilitator URL — your
own (`docs/facilitator-runbook.md`) or, to try things out on testnet, the public
demo at `https://sui-facilitator.onrender.com`.

## 1. Seller: make a route payable

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { x402 } from "@sui-x402/hono";

const app = new Hono();
app.use("/paid/*", x402({
  payTo: "0xYOUR_SUI_ADDRESS",
  amount: "10000",                                                                             // 0.01 USDC (6 decimals)
  asset: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",     // testnet USDC
  network: "sui:testnet",
  facilitator: "https://sui-facilitator.onrender.com",                                         // self-host for production
}));
app.get("/paid/quote", (c) => c.json({ symbol: "SUI", quote: "1.00" }));
serve({ fetch: app.fetch, port: 8402, serverOptions: { maxHeaderSize: 262144 } });
```

Same shape for Express (`@sui-x402/express`) and Next.js route handlers
(`@sui-x402/next`, `withX402(options)(handler)`); all three run one seller
core and one conformance suite.

```sh
curl -i localhost:8402/paid/quote     # HTTP 402 + PAYMENT-REQUIRED: <base64 terms>
```

## 2. Payer: a `fetch` that pays

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiX402Payer, ed25519SignerFromEnv } from "@sui-x402/payer-sui";

const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
const payer = new SuiX402Payer({ client, signer: ed25519SignerFromEnv() });   // reads PAYER_SECRET_KEY
const { response, receipt } = await payer.fetchWithReceipt("http://localhost:8402/paid/quote");
console.log(await response.json(), receipt?.digest);
```

The wallet behind `PAYER_SECRET_KEY` needs testnet SUI for gas
(https://faucet.sui.io) and testnet USDC (https://faucet.circle.com).

## What happened

1. The first request got a 402 with the terms in `PAYMENT-REQUIRED`.
2. The payer picked the offer (testnet only unless you allow more), built a
   Sui transaction paying `amount` of `asset` to `payTo`, simulated it, checked
   the simulated balance change itself, signed it, and retried the request
   with `PAYMENT-SIGNATURE`.
3. The middleware relayed that payload untouched to the facilitator, which
   dry-ran and then broadcast it. Only after settlement did your handler run
   (strict mode). The settlement digest came back in `PAYMENT-RESPONSE`.

## Guardrails worth knowing

- Seller: `503` + `Retry-After` when the facilitator is down — never free
  content; `allowMainnet: true` required for `sui:mainnet`.
- Payer: at most one extra payment per call, only after proving on chain the
  first never executed; caps per asset via `select.maxAmount`; the client's
  chain must match the offer's network.
- Both sides relay bytes verbatim; the facilitator is the only verifier.

## Next

- Run the examples: `examples/hono-server`, `examples/express-server`, `examples/next-paywall`.
- Self-host the facilitator: `docs/facilitator-runbook.md`.
- Package docs: `packages/*/README.md`. Protocol notes from the live facilitator: `docs/spec-notes.md`.
