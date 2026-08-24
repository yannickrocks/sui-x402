# @sui-x402/payer-sui

The agent/client side of [x402 v2](https://github.com/x402-foundation/x402) on Sui:
a `fetch` that pays. On a `402 Payment Required` it picks an offer from the
server's `accepts[]`, builds and signs a Sui payment transaction, and replays the
request with the `PAYMENT-SIGNATURE` header.

This is the money path. Everything that decides what leaves the wallet — coin
selection, gas budget, expiry, the pre-sign self-check — lives here, in atomic
units, with the asset matched by full struct tag. Chain access is gRPC only
(`SuiGrpcClient`); public JSON-RPC was retired in July 2026.

## Install

```sh
pnpm add @sui-x402/payer-sui @mysten/sui
```

## Example

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiX402Payer, ed25519SignerFromEnv } from "@sui-x402/payer-sui";

const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
});
const payer = new SuiX402Payer({ client, signer: ed25519SignerFromEnv() }); // reads PAYER_SECRET_KEY

// A paid route, e.g. one of the example sellers in this repo (testnet).
const { response, receipt } = await payer.fetchWithReceipt(
  "https://api.example/paid/quote"
);

console.log(await response.json());
console.log(receipt?.digest, receipt?.amount); // settlement digest, atomic units received by payTo
```

`payer.fetch(input, init)` is the same call without the receipt, and is a drop-in
for `globalThis.fetch` for the request shapes x402 covers.

### Guardrails

`SuiX402Payer` pays the first offer that passes selection. Cap what it may spend
before it ever touches a coin:

```ts
const USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const capped = new SuiX402Payer({
  client,
  signer: ed25519SignerFromEnv(),
  select: { assets: [USDC], maxAmount: { [USDC]: 50_000n } }, // never pay over 0.05 USDC
});
```

## API

Everything exported from the package entry point.

| Export                         | Kind      | What it does                                                                                                                                                               |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SuiX402Payer`                 | class     | The paying `fetch`. `fetch(input, init)` → `Response`; `fetchWithReceipt(input, init)` → `{ response, receipt }`.                                                          |
| `SuiX402PayerOptions`          | type      | `client`, `signer`, and the optional `select`, `fetch`, `now`, `sleep`, `gasHeadroomPercent`, `maxGasBudget`, `chainIdentifiers`.                                                                       |
| `PaymentReceipt`               | type      | What the seller reported in `PAYMENT-RESPONSE`: `digest`, `payer`, `amount`, `network`, the `accepted` offer, and the raw `settle` response.                               |
| `PaymentRejectedError`         | class     | The seller answered 402 to a paid request and the payer will not pay again. Carries `reason`, `retryHint` and the `response`.                                              |
| `selectRequirement`            | function  | `(accepts, options?)` → the first offer in server order matching scheme, network, asset and cap. Returns it by reference, unmodified.                                      |
| `SelectOptions`                | type      | `networks`, `assets` (struct tags), `maxAmount` (atomic-unit `bigint` per struct tag).                                                                                     |
| `NoAcceptableRequirementError` | class     | No offer passed. `rejected` lists each offer's index and `RejectReason`.                                                                                                   |
| `RejectReason`                 | type      | `"unsupported_scheme" \| "unsupported_network" \| "unsupported_asset" \| "amount_over_cap"`.                                                                               |
| `RejectedRequirement`          | type      | One rejection: `{ index, reason, requirement }`.                                                                                                                           |
| `DEFAULT_NETWORKS`             | const     | `["sui:testnet"]`. Mainnet is never implicit.                                                                                                                              |
| `buildPaymentTransaction`      | function  | Builds, simulates, sizes gas for and self-checks one payment transaction. Returns `BuiltPayment`; never signs.                                                             |
| `BuildPaymentOptions`          | type      | `client`, `sender`, `requirements`, plus `gasHeadroomPercent`, `maxGasBudget`, `chainIdentifiers`.                                                                       |
| `BuiltPayment`                 | type      | `bytes`, `digest`, `sender`, `payTo`, `asset`, `amount` (bigint), `gasPrice`, `gasBudget`, `gasCoin`, `expiresAfterEpoch`.                                                                  |
| `PaymentClient`                | interface | The slice of `SuiGrpcClient` the payer needs: `listCoins`, `getReferenceGasPrice`, `getChainIdentifier`, `simulateTransaction`. `SuiGrpcClient` satisfies it structurally. |
| `PaymentBuildError`            | class     | Build refused before signing. `reason` is a `PaymentBuildReason`.                                                                                                          |
| `PaymentBuildReason`           | type      | `"network_mismatch" \| "simulation_failed" \| "gas_budget_exceeded" \| "self_check_failed"`.                                                                                        |
| `computeGasBudget`             | function  | `(gasUsed, gasPrice, headroomPercent)` → budget in MIST, using the Sui SDK's formula.                                                                                      |
| `receivedBy`                   | function  | `(balanceChanges, payTo, asset)` → atomic units credited, or `null` when nothing matched. The pre-sign self-check.                                                         |
| `DEFAULT_GAS_HEADROOM_PERCENT` | const     | `20`.                                                                                                                                                                      |
| `DEFAULT_MAX_GAS_BUDGET`       | const     | `1_000_000_000n` MIST (1 SUI). Above this the build fails as a gas spike.                                                                                                  |
| `discoverCoins`                | function  | `(client, owner, asset)` → every `Coin<asset>` object the owner holds, paged.                                                                                              |
| `selectCoins`                  | function  | `(coins, amount, asset)` → largest-first `CoinSelection` covering `amount`.                                                                                                |
| `CoinSelection`                | type      | `{ primary, merge, total }` — `merge` is merged into `primary` before the split.                                                                                           |
| `InsufficientBalanceError`     | class     | Not enough of `asset` before anything is signed. Carries `asset`, `required`, `available`.                                                                                 |
| `MAX_INPUT_COINS`              | const     | `128` coin objects per payment transaction.                                                                                                                                |
| `CoinRef`                      | type      | `{ objectId, version, digest }`.                                                                                                                                           |
| `OwnedCoin`                    | type      | `CoinRef` plus the full object `type` and an atomic-unit `balance` string.                                                                                                 |
| `CoinSource`                   | interface | The `listCoins` slice of the client used by coin discovery.                                                                                                                |
| `PayerSigner`                  | interface | `address()` and `signTransaction(bytes)` → base64 signature. The seam for zkLogin, multisig and hardware signers.                                                          |
| `KeypairSigner`                | class     | Adapts any `@mysten/sui` `Signer` to `PayerSigner`.                                                                                                                        |
| `ed25519Signer`                | function  | `PayerSigner` from a bech32 `suiprivkey…` string.                                                                                                                          |
| `ed25519SignerFromEnv`         | function  | `PayerSigner` from `env[name]`, default `PAYER_SECRET_KEY`.                                                                                                                |
| `ENV_PAYER_SECRET_KEY`         | const     | `"PAYER_SECRET_KEY"`.                                                                                                                                                      |
| `SignerConfigError`            | class     | The key is missing, not bech32, or not Ed25519. Never quotes the key material.                                                                                             |

## Notes

**Testnet by default.** `selectRequirement` accepts `sui:testnet` only unless you
pass `networks` explicitly. Paying on mainnet is an opt-in the SDK will never make
for you.

**Retries.** At most one extra payment per `fetch` call, and only when the
seller says the terms drifted (`invalid_payment_requirements`: re-selected from
the new terms) or the transaction went stale (`invalid_transaction_state`:
rebuilt with a fresh nonce). Before either, the payer reads the first payment's
gas coin twice, 1.5 s apart: it must still be at the version that was signed,
which proves that payment never executed (a transaction lookup cannot — full
nodes answer "not found" for pruned history too). A moved coin or a failed
lookup ends the call with `PaymentRejectedError`. A facilitator outage
(502/503/504, or a 402 carrying `unexpected_*_error`) resends the *same* signed
payload after `Retry-After` (default 1 s then 3 s, at most twice); the
facilitator dedupes by digest, so that can never pay twice. Every other answer
is returned to you as-is. `fetchWithReceipt` also returns `sent` — the digest
and offer of the payment that went out — so a paid-but-rejected request is
never mistaken for one that was never paid.

**Chain identity.** The payer refuses to build unless the chain its client is
connected to (`getChainIdentifier`) is the one the offer's `network` names.
Only `sui:testnet` is pinned (`CHAIN_IDENTIFIERS`); to pay on any other network
pass its genesis checkpoint digest in `chainIdentifiers` — a deliberate human
step.

**Expiry.** Every payment carries a `ValidDuring` expiration bound to the next
epoch, the chain identifier and a random nonce: an unsettled payment dies with
the epoch, and a rebuilt one is a new transaction rather than a replay. Sui does
not support timestamp-based expiry yet (the node rejects it), so
`maxTimeoutSeconds` is only a local deadline — a payment whose window closed
before it could be sent is rebuilt once.

**120 KB transaction cap.** The payload is validated against `@sui-x402/core`'s
schema before the header is sent, so a transaction whose base64 exceeds
`MAX_TRANSACTION_BASE64_CHARS` (120,000 chars, the reference facilitator's limit)
fails locally instead of being rejected as a malformed header.

**Live e2e.** `test/e2e.test.ts` pays 0.01 testnet USDC to a live demo resource.
It skips unless `E2E` and `PAYER_SECRET_KEY` are both set; `SUI_GRPC_URL`
overrides the default full node and `X402_RESOURCE_URL` retargets it at any
seller advertising the same terms (the public demo is broken, spec-notes #12). See `.env.example` and `docs/status.md` —
vitest does not load `.env` on its own.
