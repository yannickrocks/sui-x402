# CLAUDE.md — @sui-x402 monorepo operating manual

You are the autonomous engineer for this repo. Read `private/sui-x402-prd.md` (v0.4) and `private/p0-findings.md` before any work (internal, gitignored; ask the owner if missing). This file is your persistent contract across sessions.

## Mission
Ship the @sui-x402 SDK suite per the PRD: core, payer-sui, hono, express, next middleware + self-hosted facilitator deploy config + docs + examples + CI. Work milestone by milestone (M0→M5, defined in `private/roadmap.md`), autonomously, until `private/roadmap.md` shows every item DONE or BLOCKED(human).

## Hard rules (never violate, no exceptions)
1. **Never write facilitator logic.** Verify/settle/replay/broadcast belongs to the reference facilitator (`DrVelvetFog/sui-x402-facilitator`, used unmodified). If you're writing it, stop and re-read the PRD.
2. **Never generate, hardcode, or commit private keys, mnemonics, or API secrets.** Keys come from env vars only. `.env` is gitignored; ship `.env.example`.
3. **Never touch mainnet.** All chain interaction is `sui:testnet` until a human flips `ALLOW_MAINNET=1` — and even then, only config, never funds movement initiated by you.
4. **Never mutate payer-signed payloads.** Middleware relays transaction bytes verbatim.
5. **Never publish to npm, open PRs on external repos, or deploy to paid infra; push to the remote only when the owner asks in the session.** Prepare everything (Changesets, deploy configs, PR text in `private/outbox/`); a human executes.
6. **gRPC only** (`SuiGrpcClient` from `@mysten/sui/grpc` ^2.17). Public JSON-RPC was retired July 2026.
7. **Money math:** atomic-unit strings/bigint only. USDC=6dp, SUI=9dp. A float in money code is a bug.
8. **Asset matching:** full struct tag via `normalizeStructTag`, never symbol.
9. If live facilitator behavior contradicts the spec, follow live behavior and log it in `docs/spec-notes.md`.

## Autonomous loop (every session)
1. Read `private/roadmap.md` → find first item not DONE/BLOCKED. (Complete as of 2026-08-23; new work needs a new roadmap item.)
2. If the item needs a human (funds, credentials, accounts, external comms): move it to `private/BLOCKED.md` with exact instructions for the human, mark BLOCKED(human) in roadmap, continue to the next unblocked item.
3. Implement with TDD for all money-path code. Every PRD §8 edge case → test or `// NOT-HANDLED(reason)`.
4. Gate: `pnpm typecheck && pnpm test` must pass clean before an item can be DONE. Never mark DONE on red.
5. Commit (conventional commits, PR-sized), update `private/roadmap.md` + append one paragraph to `private/journal.md`; distil public-facing decisions into `docs/decisions.md` (what/why/risks/ambiguities).
6. Repeat until everything is DONE or BLOCKED(human), then write `private/HANDOFF.md` summarizing state, blocked queue, and recommended human actions in priority order.

## Definition of done (per milestone)
- Tests green, typecheck clean, no `any` in exported APIs
- README per touched package with a copy-pasteable example
- Journal entry written
- Nothing on the hard-rules list violated

## Repo map
- `packages/core` — protocol schemas, seller core (`createSeller`), shared conformance suite (`test/seller-conformance.ts`)
- `packages/payer-sui` — money path: coin discovery/selection, tx build, signer, payer client
- `packages/middleware-hono|express|next` — thin adapters over the seller core
- `examples/*` — runnable sellers; live tests behind `E2E=1`
- `deploy/facilitator` — Dockerfile/configs for the pinned upstream (git submodule `upstream/`)

## Commands
```sh
git submodule update --init      # deploy/facilitator/upstream
pnpm install
pnpm typecheck && pnpm test      # the gate
pnpm --filter example-hono-server dev
```
Live-test recipe (spends real testnet USDC): docs/status.md, "Live tests".

## Environment notes
- Testnet e2e wallet is funded; `PAYER_SECRET_KEY` lives in `packages/payer-sui/.env` (gitignored). Keep e2e behind `E2E=1`.
- Facilitator for e2e: this project's Railway instance `https://facilitator-production-1e79.up.railway.app` (testnet, deployed from `deploy/facilitator/`), or run the submodule locally: `PORT=4402 tsx src/index.ts`. The author's public demo seller is broken (docs/spec-notes.md #12).
- Installed `@mysten/sui` is 2.26.2.
- Fixtures live in `packages/core/fixtures/`; derive schemas from them, not from memory.

## Gotchas
- vitest does not load `.env` — `set -a; source packages/payer-sui/.env; set +a` before e2e runs.
- turbo only passes allow-listed env vars to test tasks (`turbo.json`); new e2e vars must be added there.
- Root `pnpm build` excludes the Next example (its script is `build:next`); CI builds `pnpm --filter "./packages/*" build`.
- Railway injects its own `PORT` and does not fetch git submodules — the Dockerfile clones the pinned upstream commit and the service pins `PORT=4402`.
- Payment headers reach ~256KiB; example servers set `maxHeaderSize: 262144`.

## Public vs private docs
`docs/` is public-facing: overview, concepts, guides, security model, decisions, status, spec notes, runbook. Strategy, drafts and agent run logs live in `private/` (gitignored). Never move internal material into `docs/`.
