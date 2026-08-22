# CLAUDE.md — @sui-x402 monorepo operating manual

You are the autonomous engineer for this repo. Read `docs/sui-x402-prd.md` (v0.4) and `docs/p0-findings.md` before any work. This file is your persistent contract across sessions.

## Mission
Ship the @sui-x402 SDK suite per the PRD: core, payer-sui, hono, express, next middleware + self-hosted facilitator deploy config + docs + examples + CI. Work milestone by milestone (M0→M5, defined in `docs/roadmap.md`), autonomously, until `docs/roadmap.md` shows every item DONE or BLOCKED(human).

## Hard rules (never violate, no exceptions)
1. **Never write facilitator logic.** Verify/settle/replay/broadcast belongs to the reference facilitator (`DrVelvetFog/sui-x402-facilitator`, used unmodified). If you're writing it, stop and re-read the PRD.
2. **Never generate, hardcode, or commit private keys, mnemonics, or API secrets.** Keys come from env vars only. `.env` is gitignored; ship `.env.example`.
3. **Never touch mainnet.** All chain interaction is `sui:testnet` until a human flips `ALLOW_MAINNET=1` — and even then, only config, never funds movement initiated by you.
4. **Never mutate payer-signed payloads.** Middleware relays transaction bytes verbatim.
5. **Never publish to npm, push to remote git, open PRs on external repos, or deploy to paid infra.** Prepare everything (Changesets, deploy configs, PR text in `docs/outbox/`); a human executes.
6. **gRPC only** (`SuiGrpcClient` from `@mysten/sui/grpc` ^2.17). Public JSON-RPC was retired July 2026.
7. **Money math:** atomic-unit strings/bigint only. USDC=6dp, SUI=9dp. A float in money code is a bug.
8. **Asset matching:** full struct tag via `normalizeStructTag`, never symbol.
9. If live facilitator behavior contradicts the spec, follow live behavior and log it in `docs/spec-notes.md`.

## Autonomous loop (every session)
1. Read `docs/roadmap.md` → find first item not DONE/BLOCKED.
2. If the item needs a human (funds, credentials, accounts, external comms): move it to `docs/BLOCKED.md` with exact instructions for the human, mark BLOCKED(human) in roadmap, continue to the next unblocked item.
3. Implement with TDD for all money-path code. Every PRD §8 edge case → test or `// NOT-HANDLED(reason)`.
4. Gate: `pnpm typecheck && pnpm test` must pass clean before an item can be DONE. Never mark DONE on red.
5. Commit (conventional commits, PR-sized), update `docs/roadmap.md` + append one paragraph to `docs/journal.md` (what/why/risks/ambiguities).
6. Repeat until everything is DONE or BLOCKED(human), then write `docs/HANDOFF.md` summarizing state, blocked queue, and recommended human actions in priority order.

## Definition of done (per milestone)
- Tests green, typecheck clean, no `any` in exported APIs
- README per touched package with a copy-pasteable example
- Journal entry written
- Nothing on the hard-rules list violated

## Environment notes
- Testnet e2e requires a funded wallet (SUI gas + testnet USDC): env `PAYER_SECRET_KEY`. If absent → write the funding request to `docs/BLOCKED.md`, keep e2e behind `E2E=1` flag, and proceed with unit/mocked tests.
- Live facilitator for fixtures/e2e: `https://sui-facilitator.onrender.com` (testnet). Self-hosted config in `deploy/facilitator/` targets Fly/Railway but is NOT deployed by you.
- Fixtures live in `packages/core/fixtures/`; derive schemas from them, not from memory.
