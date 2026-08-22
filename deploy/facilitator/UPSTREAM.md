# Upstream pin — reference facilitator

| | |
|---|---|
| Repo | https://github.com/DrVelvetFog/sui-x402-facilitator |
| License | Apache-2.0 © UIG Studios LLC |
| Pinned commit | `37bb8f7920bd602f9c209cab36b38f226cd1c3ea` |
| Commit date | 2026-08-07 ("fix(rpc): match only genuine tx-lookup misses in the replay guard") |
| Pinned on | 2026-08-22 |
| Vendored as | git submodule at `deploy/facilitator/upstream` — **unmodified** |

Rule: we never edit files under `upstream/`. All deploy config (Dockerfile,
Fly/Railway manifests, env) lives beside it in `deploy/facilitator/`.

## Update procedure

```sh
cd deploy/facilitator/upstream
git fetch origin && git log --oneline HEAD..origin/main   # review the diff first
git checkout <new-sha>
cd ../../..
git add deploy/facilitator/upstream
# then: update the table above, rebuild the image, re-run the smoke test
# (docs/facilitator-runbook.md), refresh packages/core/fixtures/ if /supported changed.
```

## Fresh clone

```sh
git submodule update --init deploy/facilitator/upstream
```
