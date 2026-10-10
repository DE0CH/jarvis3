#!/usr/bin/env bash
# The real-Fly end-to-end run (docs/FLY-E2E.md). Needs in the environment:
#   FLY_API_TOKEN              a Fly token for the session app (an app-scoped token is enough)
#   FLY_ORG, FLY_APP           the instance's existing session app (the run never creates or deletes it)
#   OPENROUTER_MANAGEMENT_KEY  an OpenRouter management (provisioning) key; the run mints one
#                              user key with a USD 1 limit and deletes it at the end
#   SESSION_IMAGE              a pinned session image, e.g. ghcr.io/de0ch/jarvis3-session:<12 hex>
# Optional: E2E_FLY_REGION (lhr), E2E_MODEL (google/gemini-2.5-flash-lite), E2E_KEY_LIMIT_USD (1),
#   E2E_REPORT=<file> (the JSON report).
# Needs node >= 22.18, git, cloudflared and versitygw on PATH. Prints no secret.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
for tool in node git cloudflared versitygw; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH (docs/FLY-E2E.md)" >&2; exit 2; }
done
for v in FLY_API_TOKEN FLY_ORG FLY_APP OPENROUTER_MANAGEMENT_KEY SESSION_IMAGE; do
  [ -n "${!v:-}" ] || { echo "missing env $v" >&2; exit 2; }
done
[ -d "$here/../server/node_modules" ] || (cd "$here/../server" && npm ci --silent)
[ -d "$here/node_modules" ] || (cd "$here" && npm ci --silent)
cd "$here"
exec timeout --kill-after=60 45m node --disable-warning=ExperimentalWarning fly-e2e.ts
