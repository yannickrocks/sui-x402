# FAQ

**Do I need my own facilitator?**
For development, the pinned facilitator runs locally in one command
([status.md](status.md)). For anything public, self-host it with
`deploy/facilitator` — it is a deploy, not a port. The author's public demo
instance is not a production dependency.

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

Running a mainnet *facilitator* is a separate matter, and currently on hold: a
pre-mainnet review of the pinned reference facilitator found defects that are
reported upstream and unfixed
([status](status.md#known-upstream-issues)).

**Why gRPC?**
Sui retired public JSON-RPC in July 2026. Every chain call here goes through
`SuiGrpcClient`, including the facilitator's.

**What is the testnet network id?**
`sui:testnet`. The Sui exact-scheme spec under review
(x402-foundation/x402 PR #3081) defines `sui:mainnet`, `sui:testnet` and
`sui:devnet`; this SDK and the reference facilitator both already use
`sui:testnet`. The remaining gap is that the x402 network registry doc does
not list Sui yet, which is being addressed alongside that spec PR.

**How is this different from `@t2000/serve`?**
t2000 ships a Sui x402 dialect for its agent marketplace: v1-style
`X-PAYMENT` headers, a custom `extra.suimpp` extension, the seller verifying
and settling payments itself, and a Next.js-first router. sui-x402 implements
the x402 v2 wire format as the x402 Foundation specifies it, uses the
facilitator architecture the foundation's own implementations use, settles
before serving by default, and certifies Hono, Express and Next.js adapters
with one conformance suite. It works with any compliant facilitator or payer.
t2000 supports gasless payments end to end. sui-x402 ships the payer half —
building and signing sponsored payments through the gas station
([guide](guides/gasless.md)) — but settling one needs an upstream facilitator
change that is requested and not merged.

**Is the public demo working?**
Yes. Its seller layer briefly answered `500` to valid payments because it
still called the retired Sui JSON-RPC; that was fixed upstream on 2026-08-24
(`docs/spec-notes.md` #12). You can still run the facilitator locally or
self-host it.
