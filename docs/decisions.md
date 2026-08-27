# Decisions

The design decisions that shaped the code, in the order they were made. Each
names the alternative that was rejected and why.

**D1 · The facilitator is a pinned git submodule, not a copy.**
`deploy/facilitator/upstream` tracks the reference implementation at an exact
commit. Upgrades are explicit (`git submodule update`), the provenance is
visible, and nothing in it is modified. A copied tree would drift silently.

**D2 · Wire schemas carry no defaults; core has no chain dependency.**
Zod defaults made parsed input differ from what was sent and broke type
parity. Core validates shape only and stays zod-only; normalising addresses
and struct tags is a comparison concern for payer and middleware, which have
the chain SDK.

**D3 · One payer package, `@sui-x402/payer-sui`.**
A chain-agnostic payer has nothing to do: the Sui `exact` scheme is a signed
Sui transaction. All transaction construction sits behind one module so the
eventual gasless path (Sui Address Balances) is a drop-in replacement.

**D4 · Explicit coin selection instead of the SDK's `coinWithBalance` intent.**
The intent resolves coins inside `Transaction.build({ client })`, hiding the
selection and requiring a live client at build time. `discoverCoins` and
`selectCoins` are pure over a one-method interface the real client satisfies,
and the transaction is built offline from resolved object references.

**D5 · Gas is estimated with real coins and the payer self-checks.**
One simulation with the actual gas coins sizes the budget (SDK formula plus
20 % headroom, capped at 1 SUI by default). The same simulation's balance
changes are checked with the facilitator's own rule, so a construction bug
fails locally instead of as a facilitator rejection of a signed transaction.

**D6 · Every payment is bound to the next epoch; `maxTimeoutSeconds` is local.**
Sui rejects timestamp-based expiry today (verified by live simulation). The
payer stamps `ValidDuring { maxEpoch: current + 1, chain, nonce }` on every
build. The nonce makes a rebuilt payment a distinct transaction. A seller's
`maxTimeoutSeconds: 0` therefore no longer yields a forever-valid payment.

**D7 · Second payments are gated by reason code and proven safe on chain.**
Review found a double-payment path: a late facilitator-side error plus a
closed local window made the payer sign a second transaction. Now a repeat
`402` is re-paid only on `invalid_payment_requirements` or
`invalid_transaction_state`, and only after the first payment's gas coin is
read twice, 1.5 s apart, at the version that was signed. Any execution moves
the gas coin, so an unmoved coin is proof of non-execution. Transaction
lookups are not used for this: full nodes answer "not found" for pruned
history. Facilitator outages resend the identical payload instead, which the
facilitator deduplicates by digest.

**D8 · Spend caps are binding.**
Once any `maxAmount` cap is configured, an asset without a cap is rejected
rather than payable without limit.

**D9 · Chain identity is pinned per network; mainnet on purpose is not.**
Nothing in an offer ties `network` to the node a client reaches. The payer
compares the node's genesis checkpoint digest with a pinned table before
touching a coin. Only testnet is pinned; the mainnet digest is supplied by the
integrator, never hardcoded from memory.

**D10 · One gas set, simulated and signed.**
Estimating gas on a subset of the coins that are later signed understated the
budget on fragmented wallets (gas smashing refunds storage for every extra
coin). The coins covering the amount plus up to `maxGasBudget` are both
simulated and signed, so the estimate is the real cost.

**D11 · The seller core lives in `@sui-x402/core`; adapters only translate.**
`createSeller` makes every seller decision and returns a `SellerDecision`;
the Hono, Express and Next adapters map it onto their request and response
types in under 60 lines each. One conformance suite runs against all three
and against core itself. `decodeHeaderVerbatim` lets the seller relay the
payer's payload as the raw parsed JSON, never a schema-normalised copy.

**D12 · Fast mode is fire-and-forget everywhere, reported through hooks.**
Adapters had diverged (two awaited the settle, one could not), which also
made fast mode no faster than strict. Every adapter now returns the response
as soon as verification passes and reports settlement only through
`onSettled` / `onSettleFailure`. Express settles on `finish` or `close`, so a
client that aborts mid-body is still settled.

**D13 · `invalid_transaction_state` from `/verify` falls through to `/settle`.**
The facilitator's `/verify` rejects an already-executed payment with that
code while `/settle` reconstructs the prior settlement. Without the
fallthrough, a payer resending after a lost settle response could never
redeem a payment it had made. The seller now settles on that one code and
fulfils only on `success: true`.

**D14 · Gasless rides the facilitator's gas station; the SDK holds no sponsor key.**
Four designs were considered for sponsored payments. Client-side Enoki
integration would put a sponsor credential in the payer — a key the SDK must
never hold. Extending the facilitator was ruled out by the reuse rule
(hard rule 1). The chosen shape — payer builds a transaction kind, the
facilitator's existing `/gas-station` sponsors it, the payer validates and
signs, settle broadcasts — reuses a shipped, tested capability, even though a
seller-side alternative would have been the smaller upstream diff. The one
property lost is settle's in-flight dedupe cache for sponsored bytes; the
prior-on-chain path still re-asserts the payee's credit against execution
truth. SUI-denominated payments are excluded: sourced from the sponsor's gas
coin, they leave no payer-owned input to prove non-execution with.

## Review rounds

The money path (`packages/payer-sui`) went through two structured internal
reviews (correctness, security, protocol conformance) and the seller side
through one. Seventeen findings were raised; every one was fixed or are listed as known limitations in
[status.md](status.md). Two were confirmed against the live network before
fixing: timestamp expiry is unsupported, and "transaction not found" is not
proof of non-execution.

## Evidence

- Wire schemas are derived from captured live facilitator responses
  (`packages/core/fixtures`), and a test pins the reason-code enum to the
  vendored facilitator's source.
- The header codec produces bytes identical to the live facilitator's.
- Ten testnet settlements (as of 2026-08-24) verified on chain with exact balance changes,
  the expiration as built, and the pinned chain identifier.
