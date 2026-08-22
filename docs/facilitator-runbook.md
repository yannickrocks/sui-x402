# Facilitator runbook — self-hosting the reference facilitator

We do not write facilitator logic. This runbook deploys
[`DrVelvetFog/sui-x402-facilitator`](https://github.com/DrVelvetFog/sui-x402-facilitator)
**unmodified** (Apache-2.0), pinned as a git submodule at
`deploy/facilitator/upstream` — see `deploy/facilitator/UPSTREAM.md` for the
commit hash and update procedure.

Why self-host: the author's instance (`https://sui-facilitator.onrender.com`)
is a free-tier Render box run by one person. Fine for dev/beta; production
sellers point at their own deployment (PRD §8.16).

## What you get

```
GET  /supported   -> { kinds: [{ x402Version, scheme, network, extra: { usdc, decimals } }], extensions, signers }
POST /verify      -> { isValid, invalidReason?, payer? }
POST /settle      -> { success, errorReason?, payer?, transaction, network, amount? }
GET  /health      -> { ok, service, networks, custody, fees, terms, uptimeSeconds }
```

Non-custodial: it simulates (verify) or broadcasts verbatim (settle) the
payer's own signed transaction. No keys unless you opt into the Enoki gas
station. Semantic failures are HTTP 200 with `isValid:false` /
`success:false`; 400 only for unparseable bodies; 429 when rate-limited.

## Files

| path | purpose |
|---|---|
| `deploy/facilitator/upstream/` | submodule, read-only for us |
| `deploy/facilitator/Dockerfile` | `node:22-alpine`, `npm ci --omit=dev`, runs `tsx src/index.ts` as upstream does |
| `deploy/facilitator/.env.example` | every env var upstream reads |
| `deploy/facilitator/fly.toml` | Fly.io app manifest |
| `deploy/facilitator/railway.json` | Railway service config |
| `deploy/facilitator/smoke.mjs` | local smoke test (starts server, checks `/health` + `/supported`) |

## Prerequisites

- Node 22+ and Docker (for the image); `flyctl` or the Railway CLI for deploys
- Submodule initialised: `git submodule update --init deploy/facilitator/upstream`
- A **second trusted gRPC endpoint** for failover (see next section)

## gRPC endpoints and failover

`SUI_TESTNET_RPC` is a comma-separated list, first = primary. Upstream's
`FailoverRpc` retries the next endpoint on transport errors (timeout,
unavailable, network) and never on deterministic gRPC statuses (`NOT_FOUND`,
`INVALID_ARGUMENT`, …), so a protocol rejection is reported truthfully
instead of hidden by failover. Public JSON-RPC was retired in July 2026;
these must be **gRPC** endpoints.

Verification trusts whatever the node answers (dry-run result, balance
changes, digest lookup for the replay guard). A malicious or buggy endpoint
could validate a bad payment. Therefore:

1. Primary: Mysten's official `https://fullnode.testnet.sui.io:443`.
2. Secondary: your own full node, or a paid provider you trust that serves
   Sui gRPC. The placeholder `REPLACE-WITH-SECOND-TRUSTED-GRPC-ENDPOINT` in
   `.env.example` / `fly.toml` must be replaced before deploying; a single
   entry also works (no failover) if you prefer that over an untrusted second
   node.

## Run locally

### Node (fastest)

```sh
cd deploy/facilitator/upstream
npm ci
PORT=4402 npm run serve
# other terminal
curl -s localhost:4402/supported | jq
```

### Smoke test (what CI and the runbook mean by "it works")

```sh
node deploy/facilitator/smoke.mjs            # starts upstream on a free port, checks /health and /supported, exits 0/1
node deploy/facilitator/smoke.mjs --save     # also writes packages/core/fixtures/facilitator-supported.local.json
```

### Docker

```sh
cd deploy/facilitator
docker build -t sui-x402-facilitator .
docker run --rm -p 4402:4402 --env-file .env sui-x402-facilitator
curl -s localhost:4402/health
```

## Deploy — Fly.io

```sh
cd deploy/facilitator                          # build context must contain ./upstream
fly launch --no-deploy --copy-config --name <your-app-name>   # first time only; keeps fly.toml
fly secrets set SUI_TESTNET_RPC="https://fullnode.testnet.sui.io:443,https://<second-trusted-grpc>:443"
fly deploy
fly status && curl -s https://<your-app-name>.fly.dev/supported | jq
```

`fly.toml` pins one always-on machine (`auto_stop_machines = "off"`,
`min_machines_running = 1`) — see "Operating notes" for why. Secrets set via
`fly secrets` override `[env]` values of the same name.

## Deploy — Railway

1. New project → "Deploy from GitHub repo" → pick this repo.
2. Service settings → **Root Directory** = `deploy/facilitator`. Railway
   reads `railway.json` there and builds the `Dockerfile`.
3. Make sure the build checks out submodules (Railway's GitHub integration
   does by default; if the build fails on `upstream/package.json` missing,
   enable submodule checkout in the service's source settings).
4. Variables: paste the contents of `.env.example` with the placeholder
   replaced. Railway injects `PORT`; the app honours it.
5. Deploy, then `curl -s https://<service>.up.railway.app/supported`.

`railway.json` pins `numReplicas: 1` and the `/health` check.

## Configuration

| env | default | notes |
|---|---|---|
| `PORT` | `4402` | Fly/Railway inject their own; upstream reads it |
| `SUI_TESTNET_RPC` | official fullnode | comma-separated gRPC failover list |
| `SUI_MAINNET_RPC` | official fullnode | only read when `ENABLE_MAINNET=1` |
| `ENABLE_MAINNET` | unset | **human-only flip**, see "Mainnet" |
| `RPC_TIMEOUT_MS` | `20000` | per-call timeout before failover |
| `RATE_LIMIT` | `120` | requests per IP per minute (keyed on the last `x-forwarded-for` hop) |
| `ENOKI_KEY` | unset | enables `/gas-station` routes; sponsor key pays gas only |
| `SPONSOR_DAILY_CAP` | `60` | sponsored txs per sender per day |
| `SPONSOR_GLOBAL_DAILY_CAP` | `1000` | sponsored txs per day, all senders |

## Operating notes

- **Exactly one instance.** Settle idempotency (in-flight promise cache keyed
  by digest), rate-limit buckets and sponsorship counters are in-process
  `Map`s. Two replicas would each see a "first" settle. Chain-level
  protections (digest uniqueness, consumed coin objects) still make a double
  broadcast fail closed, but you would lose the clean single-broadcast
  guarantee and the 429 accounting. Scale vertically or add a shared store
  upstream first.
- **Restarts are safe.** After a restart, a settle retry finds the digest
  on-chain and reconstructs the original outcome from execution truth.
- **Keep it warm.** A cold start on Fly/Railway is a few seconds of
  `tsx` boot; sellers in strict mode block the response on `/settle`, so
  scale-to-zero shows up as payer-visible latency. Config already disables it.
- **Fails closed on RPC outage.** If every endpoint is unreachable the replay
  guard throws rather than treating "unknown" as "not executed"; `/verify`
  returns `isValid:false` with an `unexpected_verify_error` reason. Seller
  middleware should respond 503 + `Retry-After` (PRD §8.7).
- **Logs** are stdout (`fly logs` / Railway log tab). Transport failovers log
  `rpc endpoint N failed (...); trying next`.
- **Body cap** 256 KB; signed payment txs are 2–6 KB.

## Upgrading upstream

Follow `deploy/facilitator/UPSTREAM.md`, then `node deploy/facilitator/smoke.mjs`,
then redeploy. If `/supported` changed shape, refresh
`packages/core/fixtures/` and re-run `pnpm test` — core's schemas are derived
from those fixtures.

## Mainnet (human-only)

Not done by the agent (hard rule 3). When a human decides to enable it:

1. Read upstream's README "Networks & assets" and `PROOF.md`; confirm the
   pinned commit is the one you reviewed.
2. Provide two trusted mainnet gRPC endpoints in `SUI_MAINNET_RPC`.
3. Set `ENABLE_MAINNET=1` as a platform secret; redeploy.
4. `curl /supported` must now list `sui:mainnet` with Circle's USDC
   `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`.
5. Update `packages/core/fixtures/` from the mainnet-enabled `/supported`.

## Troubleshooting

| symptom | likely cause |
|---|---|
| build fails: `upstream/package.json` not found | submodule not initialised / platform skipped submodules |
| `/supported` lists only `sui:testnet` | expected unless `ENABLE_MAINNET=1` |
| `/verify` → `unexpected_verify_error` for every request | all gRPC endpoints unreachable or not gRPC (JSON-RPC URL?) |
| 429 on `/verify` | `RATE_LIMIT` per IP per minute; behind a proxy make sure the platform appends the real client IP to `x-forwarded-for` |
| `/gas-station` → 404 | `ENOKI_KEY` unset (by design for v1) |
