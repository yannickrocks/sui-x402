# Status

Last updated 2026-08-23.

## Where things stand

| Area                                                     | State                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sui-x402/core`, `payer-sui`, `hono`, `express`, `next` | Complete for testnet. 381 unit and conformance tests. Published to npm as v0.1.0; the gasless payer path is staged for v0.2.0.                                                                                                                |
| Live settlement                                          | Proven. The live loop settles a real $0.01 testnet payment on every push to master through this project's Railway facilitator; more than a dozen settlements on chain as of 2026-08-27, each verified.                                        |
| Gasless (sponsored) payments                             | Payer side shipped: kind build, gas-station client, sponsor-response validation, `gasless` payer modes ([guide](guides/gasless.md)). End-to-end settlement waits on an upstream facilitator settle branch and an Enoki key on the deployment. |
| CI                                                       | Typecheck and unit tests on every push; the live loop runs on pushes to `master` when `PAYER_SECRET_KEY` is configured.                                                                                                                       |
| Mainnet                                                  | Gated. Sellers need `allowMainnet: true`; payers need the mainnet genesis digest in `chainIdentifiers` (see below).                                                                                                                           |
| Facilitator hosting                                      | Deployed to Railway from `deploy/facilitator/`: `https://facilitator-production-1e79.up.railway.app` (testnet).                                                                                                                               |

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
  so run the pinned facilitator locally, point `FACILITATOR_URL` at this
  project's instance (`https://facilitator-production-1e79.up.railway.app`), or use your own:

```sh
(cd deploy/facilitator/upstream && PORT=4402 ./node_modules/.bin/tsx src/index.ts &)
set -a; source packages/payer-sui/.env; set +a
E2E=1 PAY_TO=<payee> FACILITATOR_URL=http://127.0.0.1:4402 pnpm --filter example-hono-server test
E2E=1 X402_RESOURCE_URL=http://127.0.0.1:8402/paid/quote pnpm --filter @sui-x402/payer-sui test   # with the example running
```

## Mainnet

The payer refuses to build unless the chain its client reaches matches the
offer's `network`. Only `sui:testnet` is pinned in `CHAIN_IDENTIFIERS`;
`sui:mainnet` throws `network_mismatch` before any coin is read for spending.

**Decision (2026-09-01): the packages ship no `sui:mainnet` pin.** Each
integrator verifies the mainnet genesis checkpoint digest and passes it
explicitly ([D15](decisions.md)). The digest is the payer's only defence
against a client pointed at the wrong chain, and a wrong published value
would disable that check for every downstream user at once; verifying it
yourself takes minutes and keeps the blast radius with the party whose money
is moving.

To pay on mainnet, verify the digest against two independent sources:

1. Query a full node you control or independently trust for its chain id
   over gRPC:

   ```ts
   import { SuiGrpcClient } from "@mysten/sui/grpc";

   const client = new SuiGrpcClient({
     network: "mainnet",
     baseUrl: "https://<a-node-you-trust>",
   });
   console.log(await client.getChainIdentifier()); // base58 genesis digest
   ```

2. Obtain the same value from an independent origin: official Mysten
   documentation, or a second full node run by a different operator. Two
   queries against the same provider are one source, not two.
3. Compare the two values byte for byte. On any difference, stop — one of
   your sources is wrong, misconfigured, or lying to you.
4. Pass the verified value to the payer:

   ```ts
   const payer = new SuiX402Payer({
     client,
     signer,
     select: { networks: ["sui:mainnet"] },
     chainIdentifiers: { "sui:mainnet": "<your verified digest>" },
   });
   ```

Never source the digest from a chat transcript, a language model, or an
unverified web page: the check exists to catch a misdirected client, and an
unverified value silently turns it off.

Paying is only half of mainnet; the facilitator side of the checklist —
separate service, trusted-only RPC endpoints, canary rollout — lives in the
[runbook](facilitator-runbook.md), not here.

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

1. ~~Report the demo issue upstream~~ Done: [sui-x402-facilitator#2](https://github.com/DrVelvetFog/sui-x402-facilitator/issues/2).
2. ~~Deploy the facilitator when a persistent URL is needed~~ Done: `https://facilitator-production-1e79.up.railway.app` ([runbook](facilitator-runbook.md)).
3. ~~Make the repository public and publish with Changesets~~ Done: public
   repo, v0.1.0 on npm (2026-08-24).
4. Ecosystem listing and the testnet network-id spec proposal.
