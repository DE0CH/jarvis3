#!/bin/bash
# The deploy smoke test (CI: .github/workflows/deploy.yml; locally: needs docker, k3d, kubectl).
# Builds the server image from this checkout (a stand-in web build), makes a k3d cluster on the k3s
# version the example instance pins, applies deploy/bootstrap + deploy/smoke and checks:
#   - every pod passes Pod Security "restricted" (they are admitted at all)
#   - the server comes up behind its init containers (Litestream restore, org-env clone) and answers
#   - the org-env mirror is a bare clone at the remote's HEAD
#   - the NetworkPolicies: cloudflared may reach the server, any other pod may not
#   - Litestream replicates to the bucket, and a NEW volume is restored from it (same user ids)
set -euo pipefail
cd "$(dirname "$0")/../.."
CLUSTER=${CLUSTER:-jarvis3-smoke}
K3S=$(python3 -c 'import json;print(json.load(open("deploy/example-instance/instance.json"))["versions"]["k3s"].replace("+","-"))')
NS=jarvis3
k() { kubectl -n "$NS" "$@"; }
step() { echo; echo "== $*"; }
dump() {
  step "state on failure"
  k get pods -o wide || true
  k get events --sort-by=.lastTimestamp | tail -40 || true
  for c in restore org-env server litestream org-env-fetch; do echo "-- $c"; k logs deploy/server -c "$c" --tail=60 || true; done
  k logs job/make-bucket --tail=20 || true
}
trap 'dump' ERR

step "server image (stand-in web build)"
mkdir -p server/web-dist
[ -s server/web-dist/index.html ] || echo '<!doctype html><title>smoke</title>' > server/web-dist/index.html
docker build -q -t ghcr.io/de0ch/jarvis3-server:smoke server

step "k3d cluster on rancher/k3s:$K3S"
k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER" --image "rancher/k3s:$K3S" --k3s-arg '--disable=traefik@server:0' --wait --timeout 180s
k3d image import -c "$CLUSTER" ghcr.io/de0ch/jarvis3-server:smoke

step "bootstrap + instance"
kubectl apply -k deploy/bootstrap
kubectl apply -k deploy/smoke
k wait --for=condition=complete job/make-bucket --timeout=180s
k rollout status deploy/server --timeout=300s

step "health through a port-forward"
k port-forward deploy/server 18080:8080 >/tmp/pf.log 2>&1 &
PF=$!
for i in $(seq 1 30); do curl -fsS localhost:18080/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS localhost:18080/api/health | grep -q '"ok":true'
test "$(curl -s -o /dev/null -w '%{http_code}' localhost:18080/api/me)" = 401
kill $PF

step "cloudflared was admitted (it crash-loops on the fake token, which is expected)"
for i in $(seq 1 30); do [ -n "$(k get pods -l app=cloudflared -o name)" ] && break; sleep 2; done
test -n "$(k get pods -l app=cloudflared -o name)"

step "org-env mirror"
k exec deploy/server -c server -- git -C /data/org-env.git rev-parse --is-bare-repository | grep -q true
k exec deploy/server -c server -- git -C /data/org-env.git cat-file -e 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d

step "network policies"
# the probe that plays cloudflared would be adopted (and deleted) by cloudflared's ReplicaSet
k delete deploy cloudflared --wait=true
probe() { # $1 = pod label app value; prints the HTTP code or "blocked"
  k run "probe-$1-$RANDOM" --rm -i --quiet --restart=Never --labels="app=$1" --image=ghcr.io/de0ch/jarvis3-server:smoke \
    --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"ghcr.io/de0ch/jarvis3-server:smoke","command":["node","-e","fetch(\"http://server:8080/api/health\",{signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status),()=>console.log(\"blocked\"))"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'
}
test "$(probe cloudflared | tail -1)" = 200
test "$(probe intruder | tail -1)" = blocked

step "Litestream: replicate, then restore onto a new volume"
uid() { k exec deploy/server -c server -- node --disable-warning=ExperimentalWarning -e 'const {DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/jarvis.db",{readOnly:true}).prepare("SELECT group_concat(id) AS i FROM (SELECT id FROM users ORDER BY email)").get().i)'; }
BEFORE=$(uid)
echo "user ids before: $BEFORE"
test -n "$BEFORE"
sleep 30 # sync-interval is 10 s
k scale deploy/server --replicas=0
k wait --for=delete pod -l app=server --timeout=120s
k delete pvc data --wait=true
kubectl apply -k deploy/smoke
k rollout status deploy/server --timeout=300s
AFTER=$(uid)
echo "user ids after restore: $AFTER"
test "$BEFORE" = "$AFTER"

trap - ERR
step "smoke test passed"
