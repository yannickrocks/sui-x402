# Guide: build a paying agent

`@sui-x402/payer-sui` gives an agent a `fetch` that pays `402`s, within limits
you set, from a key you control.

## Install

```sh
pnpm add @sui-x402/payer-sui @mysten/sui
```

## Minimal payer

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiX402Payer, ed25519SignerFromEnv } from "@sui-x402/payer-sui";

const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
const payer = new SuiX402Payer({ client, signer: ed25519SignerFromEnv() });   // reads PAYER_SECRET_KEY

const { response, receipt, sent } = await payer.fetchWithReceipt("https://api.example/paid/quote");
console.log(response.status, await response.json());
console.log(receipt?.digest, receipt?.amount);      // settlement digest, atomic units received by payTo
```

`payer.fetch(input, init)` is the same without the receipt — a drop-in for
`globalThis.fetch` for requests whose body can be sent twice (strings, bytes,
`FormData`; not streams).

## Keys

The payer signs with a key it holds. Provide it as the bech32 `suiprivkey…`
string from the Sui CLI (`sui keytool export`) or from
`Ed25519Keypair.getSecretKey()`:

| | |
|---|---|
| `ed25519SignerFromEnv(name = "PAYER_SECRET_KEY")` | Reads the variable; throws `SignerConfigError` naming it when unset or not Ed25519. |
| `ed25519Signer(secretKey)` | Same from a string. |
| `new KeypairSigner(signer)` | Wraps any `@mysten/sui` `Signer` — Ed25519, Secp256k1/r1, MultiSig, `ZkLoginSigner`. |
| `PayerSigner` | The two-method interface (`address()`, `signTransaction(bytes)`) if you bring your own signer (HSM, remote signer). |

Error messages never include key material. Keep the key in an environment
variable or a secret store, never in the repository.

## Spend limits

```ts
const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

const payer = new SuiX402Payer({
  client,
  signer,
  select: {
    networks: ["sui:testnet"],            // default; list "sui:mainnet" explicitly to allow it
    assets: [USDC],                       // only pay in these coins
    maxAmount: { [USDC]: 50_000n },       // never more than 0.05 USDC per payment
  },
  maxGasBudget: 100_000_000n,             // refuse gas above 0.1 SUI (default 1 SUI)
});
```

Selection walks the seller's `accepts[]` in order and takes the first offer
that passes scheme, network, asset and cap. Once any cap is set, an asset
without one is rejected. No acceptable offer → `NoAcceptableRequirementError`
with a per-offer reason list, before anything is signed.

## Chain identity

Before any coin is touched the payer checks that the node its client talks to
is the chain the offer names, by genesis checkpoint digest. `sui:testnet` is
pinned in `CHAIN_IDENTIFIERS`; for any other network pass the digest yourself:

```ts
new SuiX402Payer({ client, signer, chainIdentifiers: { "sui:mainnet": "<genesis digest>" }, select: { networks: ["sui:mainnet"] } });
```

A mismatch or an unpinned network fails with `PaymentBuildError("network_mismatch")`.

## What a call can throw

| Error | Means | Anything signed? |
|---|---|---|
| `HeaderError` | The first `402`'s `PAYMENT-REQUIRED` header is unreadable (seller bug) | no |
| `NoAcceptableRequirementError` | No offer passed your `select` rules | no |
| `InsufficientBalanceError { asset, required, available }` | Not enough of the asset, or not enough SUI for gas | no |
| `PaymentBuildError { reason }` | `network_mismatch`, `simulation_failed`, `gas_budget_exceeded`, `self_check_failed` | no |
| `PaymentRejectedError { reason, retryHint, response }` | The seller answered `402` to the paid request and the payer will not pay again | yes — `sent` on `fetchWithReceipt` tells you what went out |

Everything else — a `403`, a `500`, a `503` after the resends — is returned as
the `Response`, unchanged.

## The retry contract

- At most **one extra payment per call**, only on `invalid_payment_requirements`
  (re-read the terms) or `invalid_transaction_state` (rebuild), and only after
  the first payment's gas coin is seen unmoved on chain twice, 1.5 s apart.
- Facilitator outages (`502`/`503`/`504`, or a `402` with `unexpected_*_error`)
  resend the **same** signed payload after `Retry-After`, at most twice.
- Nothing else is retried. Whether to call `fetch` again is your decision.

## Receipts

`fetchWithReceipt` returns:

- `response` — the seller's final response;
- `sent` — `{ digest, accepted }` of the payment that went out, or `null` if
  nothing was paid;
- `receipt` — the decoded `PAYMENT-RESPONSE` (`digest`, `payer`, `amount`,
  `network`, `accepted`, `settle`), or `null` when the header is absent or
  unreadable, or when a successful settlement names a digest other than the
  one this payer signed.

Verify a receipt independently with `client.getTransaction({ digest })`.

## Under the hood

`buildPaymentTransaction({ client, sender, requirements })` is the money path
and is exported for integrators who want the transaction without the `fetch`:
coin discovery (`discoverCoins`), largest-first selection (`selectCoins`, up to
128 inputs), `merge → split → transfer` from resolved object refs, one
simulation to size the gas budget (+20 % headroom, capped by `maxGasBudget`),
a self-check that the simulated balance change credits the payee, and an
epoch-bound `ValidDuring` expiration with a random nonce. Everything is
`bigint`; nothing is signed until every check passes.

## Live test

`packages/payer-sui/test/e2e.test.ts` pays a real seller on testnet. It skips
unless `E2E=1` and `PAYER_SECRET_KEY` are set; `X402_RESOURCE_URL` points it at
any seller advertising the fixture's terms (the public demo is currently
broken upstream). See `docs/BLOCKED.md` for the local facilitator recipe.
