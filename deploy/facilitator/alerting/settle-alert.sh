#!/bin/sh
# Wrap the facilitator so settle failures raise a Slack alert.
#
#   settle-alert.sh <command...>
#
# Every line still goes to stdout, so the platform's own log capture is
# unchanged. Only the money-at-risk lines alert:
#   "settle error:"                  post-broadcast/unexpected failure — funds
#                                    may have moved while settle reported failure
#   "executed but payTo received"    executed but underpaid
#   "settle failed on-chain"         executed, failed on-chain
# "settle rejected" is deliberately NOT matched: it is a pre-broadcast
# rejection, benign and noisy.
#
# These three strings are also matched in vector.toml (Option B) and tabulated
# in README.md. Change one, change all three.
#
# Env:
#   SLACK_WEBHOOK_URL  required to enable alerting; unset = plain passthrough
#   RAILWAY_ENVIRONMENT_NAME  optional, tagged into the message
#
# POSIX sh only (node:22-alpine has no bash, curl or jq). node — always present
# in this image — does the JSON encoding and the POST, so there is no dependency
# on which wget/curl variant the base image ships.
set -eu

[ "$#" -ge 1 ] || { echo "usage: settle-alert.sh <command...>" >&2; exit 2; }

# Alerting not configured: exec the command so this wrapper is fully transparent
# (same pid, same signals, same exit code).
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "settle-alert: SLACK_WEBHOOK_URL unset — running without alerting" >&2
  exec "$@"
fi

fifo="$(mktemp -u)"
mkfifo "$fifo"
cleanup() { rm -f "$fifo"; }
trap cleanup EXIT

# Reader: echo every line, alert on the money-at-risk ones.
#
# The POST runs in the background so a slow webhook cannot stall this drain and
# backpressure the facilitator's own writes — but at most ONE is in flight at a
# time. Unbounded forking would let a retry storm spawn a process per line; a
# burst instead drops the extras and says so, which is the right trade for an
# alert whose job is "tell me this is happening". Use Option B (Vector) when
# every event must be captured.
{
alert_pid=""
dropped=0
while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    *"settle error:"* | *"executed but payTo received"* | *"settle failed on-chain"*)
      if [ -n "$alert_pid" ] && kill -0 "$alert_pid" 2>/dev/null; then
        dropped=$((dropped + 1))
        echo "settle-alert: an alert is already in flight — dropped this one (total dropped: $dropped)" >&2
        continue
      fi
      # A webhook problem must never take down the facilitator — but it must not
      # be silent either, or a dead alert path looks exactly like "no failures".
      node -e '
        const body = JSON.stringify({
          text: "[sui-x402 facilitator][" + (process.env.RAILWAY_ENVIRONMENT_NAME || "unknown") + "] " + process.argv[1].slice(0, 500),
        });
        fetch(process.env.SLACK_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        })
          .then((r) => { if (!r.ok) console.error("settle-alert: webhook HTTP " + r.status); })
          .catch((e) => console.error("settle-alert: webhook failed: " + (e?.message ?? e)));
      ' "$line" || echo "settle-alert: could not run alert sender" >&2 &
      alert_pid=$!
      ;;
  esac
done <"$fifo"
# Let the last POST finish. Without this the wrapper can exit while the
# crash-time alert — the one that matters most — is still in flight.
[ -n "$alert_pid" ] && wait "$alert_pid" 2>/dev/null || true
} &
reader=$!

# Installed BEFORE the app is backgrounded: a signal arriving in the gap would
# otherwise hit sh's default disposition and never reach the facilitator. The
# body resolves $app when it fires, so it is safe that $app is not set yet.
trap 'kill -TERM "${app:-}" 2>/dev/null || true' TERM INT

"$@" >"$fifo" 2>&1 &
app=$!

# A signal interrupts `wait` and makes it return 128+signo while the facilitator
# is still shutting down. Reporting that would turn every ordinary SIGTERM
# redeploy into a "crash" for the platform's restart policy, so keep waiting
# until the child is actually reaped and report ITS exit code.
code=0
while :; do
  # Capture wait's status directly: after `if wait …; then … fi` the shell
  # reports the *if statement's* status, which silently loses the app's code.
  rc=0
  wait "$app" || rc=$?
  if [ "$rc" -ge 128 ] && kill -0 "$app" 2>/dev/null; then
    continue
  fi
  code=$rc
  break
done

wait "$reader" 2>/dev/null || true
exit "$code"
