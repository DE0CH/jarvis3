#!/usr/bin/env bash
# Build the app's web export (DE0CH/jarvis3-app, variant jarvis3) at the commit pinned in
# APP_COMMIT and put it in server/web-dist/, where server/Dockerfile picks it up.
#
#   scripts/build-web.sh                 # clone the app repo into a temp dir
#   APP_DIR=../jarvis3-app scripts/build-web.sh   # use an existing checkout (must be at APP_COMMIT)
#
# Needs Node 22 and about 6 GB of RAM (Metro). CI does the same in .github/workflows/server.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
commit=$(tr -d '[:space:]' < APP_COMMIT)
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "APP_COMMIT must be a full commit id" >&2; exit 1; }

if [[ -n "${APP_DIR:-}" ]]; then
  app=$(cd "$APP_DIR" && pwd)
  head=$(git -C "$app" rev-parse HEAD)
  [[ $head == "$commit" ]] || { echo "$APP_DIR is at $head, APP_COMMIT is $commit" >&2; exit 1; }
else
  app=$(mktemp -d)/jarvis3-app
  git clone --filter=blob:none "${APP_REPO:-https://github.com/DE0CH/jarvis3-app.git}" "$app"
  git -C "$app" checkout --detach "$commit"
fi

(cd "$app" && ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund && npm run build:app-deps)
(cd "$app/packages/app" && NODE_OPTIONS=--max-old-space-size=6144 npm run build:web:jarvis3)

rm -rf server/web-dist
cp -R "$app/packages/app/dist-jarvis3" server/web-dist
echo "$commit" > server/web-dist/.app-commit
echo "web build of $commit in server/web-dist/"
