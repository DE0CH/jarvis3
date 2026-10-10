#!/bin/sh
# Keeps the bare mirror of the org-env repo at /data/org-env.git (config orgEnv.mirrorPath) fetched.
#   org-env-sync.sh once   clone or fetch, then exit (init container: the server starts with the mirror)
#   org-env-sync.sh loop   fetch every ORG_ENV_FETCH_SECONDS (default 300) (sidecar)
# ORG_ENV_URL: ssh://git@github.com/<org>/<repo>.git (with the read-only deploy key in
# /etc/org-env-key/identity) or an https URL of a public repo (no key).
set -eu
export HOME=/tmp
M=/data/org-env.git
: "${ORG_ENV_URL:?ORG_ENV_URL is not set (ConfigMap jarvis-instance)}"
if [ -s /etc/org-env-key/identity ]; then
  install -m 600 /etc/org-env-key/identity /tmp/org-env-key
  export GIT_SSH_COMMAND="ssh -i /tmp/org-env-key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/known-hosts/known_hosts -o StrictHostKeyChecking=yes"
fi
sync_once() {
  if [ -f "$M/HEAD" ]; then
    git -C "$M" remote set-url origin "$ORG_ENV_URL"
    git -C "$M" fetch --prune --quiet origin
  else
    rm -rf "$M.tmp"
    git clone --mirror --quiet "$ORG_ENV_URL" "$M.tmp"
    mv "$M.tmp" "$M"
  fi
  echo "org-env mirror at $(git -C "$M" rev-parse HEAD)"
}
case "${1:-once}" in
  once) sync_once ;;
  loop)
    trap 'exit 0' TERM INT # PID 1: stop at once when the pod stops
    while :; do
      sleep "${ORG_ENV_FETCH_SECONDS:-300}" &
      wait $!
      sync_once || echo "org-env fetch failed; retrying later"
    done ;;
  *) echo "usage: org-env-sync.sh once|loop" >&2; exit 2 ;;
esac
