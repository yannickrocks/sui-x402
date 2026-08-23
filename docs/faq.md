# FAQ

**Do I need my own facilitator?**
For development, the pinned facilitator runs locally in one command
([status.md](status.md)). For anything public, self-host it with
`deploy/facilitator` — it is a deploy, not a port. The author's public demo
instance is not a production dependency (PRD §8.16).

**Does anyone hold my funds?**
No. The payer signs a complete transaction; the seller relays it; the
facilitator broadcasts it. No party but the payer has a key.

**What does a payment cost?**
The price the seller sets plus Sui gas — about 0.0023 SUI for a USDC transfer
on testnet today. The payer caps gas at 1 SUI by default (`maxGasBudget`).

**Can a payer be charged twice for one request?**
Resending the same signed payment is safe: the facilitator deduplicates by
digest. The payer signs a second, different payment at most once per call and
only after proving on chain that the first never executed.
[Security model](security-model.md).

**Why strict mode by default?**
Because it is the only mode in which you cannot serve content you were not
paid for. Fast mode exists for cheap content where latency matters more.

**Can I use a browser wallet?**
Not with this SDK. x402's payer is a program with its own key. A human checkout
flow is a different product.

**Mainnet?**
Sellers opt in with `allowMainnet: true`. Payers must list `"sui:mainnet"` in
`select.networks` and pass its genesis digest in `chainIdentifiers`. Both are
deliberate steps; nothing defaults to mainnet.

**Why gRPC?**
Sui retired public JSON-RPC in July 2026. Every chain call here goes through
`SuiGrpcClient`, including the facilitator's.

**What is the testnet network id?**
`sui:testnet`. The x402 spec only names `sui:mainnet`; the reference facilitator
and this SDK both use `sui:testnet`, and a spec proposal is drafted in
the project's outbox.

**How is this different from `@t2000/serve`?**
t2000 ships a Sui x402 dialect for its agent marketplace: v1-style
`X-PAYMENT` headers, a custom `extra.suimpp` extension, the seller verifying
and settling payments itself, and a Next.js-first router. sui-x402 implements
the x402 v2 wire format as the x402 Foundation specifies it, uses the
facilitator architecture the foundation's own implementations use, settles
before serving by default, and certifies Hono, Express and Next.js adapters
with one conformance suite. It works with any compliant facilitator or payer.
t2000 supports gasless payments today; sui-x402 does not yet.

**Why is the public demo failing?**
Its seller layer still calls JSON-RPC and answers `500` to valid payments
(`docs/spec-notes.md` #12). The facilitator itself is fine; run it locally or
self-host.
