# Jarvis 3 box bootstrap (infra/instance.py box prepends a shebang and the variables below). Blank Ubuntu
# -> single-node k3s -> Flux reconciling the instance repo's ./deploy. After this the box takes changes only
# from git: no SSH (sshd disabled, and the firewall has no inbound rules at all), no k8s API from outside.
# A box git can't fix is replaced, not repaired (docs/RUNBOOK.md).
# Injected: K3S_VERSION FLUX_VERSION AGE_KEY (Flux decrypts the instance's SOPS secrets with it)
#           FLUX_KEY (read-only deploy key of the instance repo) KNOWN_HOSTS (github.com)
#           BOOTSTRAP_YAML (deploy/bootstrap of jarvis3) SYNC_YAML (the instance repo's flux/sync.yaml)
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
exec > >(tee -a /var/log/jarvis3-bootstrap.log) 2>&1
echo "=== jarvis3 bootstrap $(date -u +%FT%TZ) ==="
apt-get update -y && apt-get install -y --no-install-recommends ca-certificates curl
systemctl disable --now ssh.socket ssh.service 2>/dev/null || true

curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC="server --disable traefik --disable servicelb --secrets-encryption" sh - || exit 1
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
for i in $(seq 1 60); do kubectl get nodes 2>/dev/null | grep -q ' Ready' && break; sleep 5; done

case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) echo "unknown arch"; exit 1 ;; esac
curl -sfL "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /usr/local/bin flux || exit 1
flux install --timeout 5m || exit 1
# a Kustomization that names no service account applies as the powerless `default`, never as the controller
kubectl -n flux-system patch deployment kustomize-controller --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--default-service-account=default"}]'
kubectl -n flux-system rollout status deployment/kustomize-controller --timeout=120s

printf '%s\n' "$BOOTSTRAP_YAML" | kubectl apply -f - || exit 1
umask 077
printf '%s\n' "$AGE_KEY" > /root/age.agekey
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey=/root/age.agekey
shred -u /root/age.agekey
printf '%s\n' "$FLUX_KEY" > /root/identity
printf '%s\n' "$KNOWN_HOSTS" > /root/known_hosts
kubectl -n flux-system create secret generic instance-repo --from-file=identity=/root/identity --from-file=known_hosts=/root/known_hosts
shred -u /root/identity /root/known_hosts
printf '%s\n' "$SYNC_YAML" | kubectl apply -f - || exit 1
echo "bootstrap COMPLETE $(date -u +%FT%TZ)" > /var/log/jarvis3-bootstrap.done
# the user-data holds the age key and the deploy key: shred cloud-init's copies once this script (one of
# them) has finished. Pods can't fetch it again from the metadata service (deploy/base/network.yaml).
nohup sh -c 'sleep 20; shred -u /var/lib/cloud/instance/user-data.txt* /var/lib/cloud/instance/scripts/part-* 2>/dev/null' >/dev/null 2>&1 &
exit 0
