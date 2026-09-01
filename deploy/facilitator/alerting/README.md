# Settle-failure alerting

The mainnet facilitator must alert on settle failures before it takes traffic.
Railway cannot do this natively: Monitors threshold only on CPU/RAM/disk/egress,
webhooks fire on deploy/crash/usage events, and there is **no log drain and no
sidecar containers** — so nothing off-box can see this service's stdout. The
alerting therefore has to happen inside the container.

## What to alert on

Money-at-risk (these three, and only these):

| line                                | meaning                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `settle error:`                     | post-broadcast/unexpected failure — the transaction may have broadcast (funds moved) while settle reported failure and discarded the digest |
| `executed but payTo received … < …` | executed but underpaid                                                                                                                      |
| `settle failed on-chain …`          | executed, failed on-chain                                                                                                                   |

**Not** `settle rejected (…)` — a pre-broadcast rejection. It is benign, common,
and alerting on it will train you to ignore the channel.

These strings appear in three places: this table, the `case` in
`settle-alert.sh`, and the filter condition in `vector.toml`. Adding a fourth
line means editing all three.

## Option A — `settle-alert.sh` (no extra SaaS)

A POSIX-sh wrapper. Every line still goes to stdout so the platform's log
capture is unchanged; the three lines above also POST to a Slack webhook. Uses
only `node`, which the image already has — no bash, curl, jq, or wget.

Enable it **on the mainnet service only**:

1. Add one line to `deploy/facilitator/Dockerfile` (additive; the default `CMD`
   stays as it is, so the existing testnet service is unaffected):
   ```dockerfile
   COPY alerting/settle-alert.sh /usr/local/bin/settle-alert.sh
   ```
2. On the mainnet Railway service set the start command:
   ```
   /usr/local/bin/settle-alert.sh node_modules/.bin/tsx src/index.ts
   ```
3. Set `SLACK_WEBHOOK_URL` as a platform secret on that service.

Deliberately **not** done: a second `Dockerfile.mainnet`. That would duplicate
the `ARG UPSTREAM_COMMIT` literal, and hardening checklist item 11 depends on
that literal being a single source of truth for the deployed-commit chain.

Behaviour, verified locally:

- all lines reach stdout unchanged;
- the app's exit code is propagated on normal exit (Railway's restart policy
  still works);
- `SIGTERM`/`SIGINT` are forwarded to the facilitator, its graceful shutdown is
  allowed to finish, and **its** exit code is reported — not the `128+signo`
  that a naive `wait` returns, which an `ON_FAILURE` restart policy would read
  as a crash on every ordinary redeploy;
- the webhook POST runs in the background, so a slow or hanging Slack endpoint
  cannot stall the log drain and backpressure the facilitator's own writes;
- **at most one alert is in flight at a time.** Failures arriving while a POST
  is still running are dropped with a logged running total rather than forking
  a process per line, so a retry storm cannot fork-bomb the container. Two
  failures in the same instant therefore produce one Slack message plus
  `settle-alert: an alert is already in flight — dropped this one (total
dropped: N)` on stderr. Choose Option B if you need every event captured;
- the wrapper waits for the final in-flight POST before exiting, so the
  crash-time alert is not lost on shutdown;
- exactly the three money-at-risk lines alert — `settled …` and
  `settle rejected …` do not;
- `SLACK_WEBHOOK_URL` unset ⇒ transparent `exec` passthrough, no alerting;
- a failing or unreachable webhook logs `settle-alert: webhook failed: …` and
  never takes the facilitator down. It is **not** silent: a dead alert path must
  not look identical to "no failures".

## Option B — Vector in-container → Better Stack (recommended for production)

Searchable history, real alert routing, dedup. `vector.toml` in this directory
is the config; Vector reads the app's stdout over a pipe (again: a separate
Vector _service_ cannot see this service's stdout on Railway). Note the
`railway_stdout` sink takes `inputs = ["app"]` — the raw source, not the filter
— so Railway's log explorer still receives 100% of the output.

Env: `BETTERSTACK_INGESTING_HOST` and `BETTERSTACK_SOURCE_TOKEN` (secret).

Better Stack alert rule: query `alert:settle_failure`, threshold **count >= 1 in
5 minutes**, notify Slack + email.

## Verify before taking traffic

An untested alert path is not an alert path. On the deployed service, emit one
synthetic matching line (or point the start command at a script that echoes
`settle error: synthetic check`) and confirm the alert actually arrives. Then
remove it. Checklist item 8 is not satisfied until you have seen an alert fire.
