# Status

Last updated 2026-08-23.

## Where things stand

| Area | State |
|---|---|
| `@sui-x402/core`, `payer-sui`, `hono`, `express`, `next` | Complete for testnet. 346 unit and conformance tests. Not yet published to npm. |
| Live settlement | Proven. Seven $0.01 testnet payments settled through the reference facilitator (three locally, four from CI), each verified on chain. |
| CI | Typecheck and unit tests on every push; the live loop runs on pushes to `master` when `PAYER_SECRET_KEY` is configured. |
| Mainnet | Gated. Sellers need `allowMainnet: true`; payers need the mainnet genesis digest in `chainIdentifiers` (see below). |
| Facilitator hosting | Deployment config and runbook ready; not deployed by this project. |

Digests of the first three settlements:
[`GE85dg3w…`](https://testnet.suivision.xyz/txblock/GE85dg3wNUdfRKJpFW9bBz2qkk4qgvgihWxMrFzDfc4T),
[`CKYr3pP6…`](https://testnet.suivision.xyz/txblock/CKYr3pP6Amrg62C9kxZX5w2UVfitDTBJeE2zjdfjnZZU),
[`5MGrTQ82…`](https://testnet.suivision.xyz/txblock/5MGrTQ82xhYeciurZssjTcnLvRn4rdp1wkorEJaA7bAB).

## Live tests

The `E2E=1` tests pay real testnet USDC. They need:

- `PAYER_SECRET_KEY`: a bech32 `suiprivkey…` for a wallet holding testnet SUI
  (https://faucet.sui.io) and testnet USDC (https://faucet.circle.com, network
  "Sui Testnet"). Keep it in `packages/payer-sui/.env` (gitignored); never commit it.
- `PAY_TO`: any Sui address other than the payer's, for the example sellers.
- A facilitator. The public demo seller is currently broken (spec-notes #12),
  so run the pinned facilitator locally or point `FACILITATOR_URL` at your own:

```sh
(cd deploy/facilitator/upstream && PORT=4402 ./node_modules/.bin/tsx src/index.ts &)
set -a; source packages/payer-sui/.env; set +a
E2E=1 PAY_TO=<payee> FACILITATOR_URL=http://127.0.0.1:4402 pnpm --filter example-hono-server test
E2E=1 X402_RESOURCE_URL=http://127.0.0.1:8402/paid/quote pnpm --filter @sui-x402/payer-sui test   # with the example running
```

## Mainnet

The payer refuses to build unless the chain its client reaches matches the
offer's `network`. Only `sui:testnet` is pinned in `CHAIN_IDENTIFIERS`. To pay
on mainnet, read the genesis checkpoint digest from a full node you trust
(`GetServiceInfo.chain_id`), verify it, and pass it as
`chainIdentifiers: { "sui:mainnet": "<digest>" }`. This is deliberately a
manual step.

## Not yet exercised live

- Rebuild paths (stale transaction, drifted terms) and the same-payload resend
  after a `503`: covered by unit tests against mocked gRPC only.
- Fast mode: every live run was strict.
- Wallets with many small SUI coins: every live payment came from one coin.

## Known upstream issue

The reference facilitator's public demo seller answers `500` to valid payments
because it still calls Sui JSON-RPC, which was retired. Its `/verify` and
`/settle` endpoints work. Details in [spec-notes #12](spec-notes.md).

## Next

1. Report the demo issue upstream.
2. Deploy the facilitator when a persistent URL is needed ([runbook](facilitator-runbook.md)).
3. Add a `LICENSE`, make the repository public, publish with Changesets.
