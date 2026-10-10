# Deploying an instance

One instance = one Hetzner box running single-node k3s, reconciled by Flux from the instance's own
private deploy repo, with SOPS/age-encrypted secrets. The box has no open inbound port: the only way
in is a Cloudflare tunnel behind Cloudflare Access. The instance's state is one SQLite file that
Litestream streams to the instance's Hetzner Object Storage bucket. The model is Jarvis 2's box
(`DE0CH/jarvis2`: `infra/create.sh`, `cloud-init.sh`, `cloudflare.py`).

The step-by-step bring-up, rebuild, rotation and restore procedures are in [RUNBOOK.md](RUNBOOK.md).

## What runs on the box

```
Hetzner server (firewall: no inbound rules; sshd disabled)
└─ k3s (traefik and servicelb off, secrets encrypted at rest)
   ├─ flux-system      Flux; kustomize-controller --default-service-account=default
   │                   GitRepository "instance" (the private deploy repo, read-only deploy key)
   │                   Kustomization "instance" (./deploy, SOPS decryption, as flux-applier)
   └─ jarvis3          Pod Security "restricted"
      ├─ Deployment server (1 replica, Recreate, PVC "data" at /data)
      │    init  restore        litestream restore -if-db-not-exists -if-replica-exists
      │    init  org-env        clone the org-env repo as a bare mirror (/data/org-env.git)
      │          server         ghcr.io/de0ch/jarvis3-server (API + the app's web build), :8080
      │          litestream     litestream replicate -> s3://<bucket>/db
      │          org-env-fetch  git fetch every 5 minutes
      ├─ Deployment cloudflared (the tunnel; outbound only)
      └─ NetworkPolicies: ingress only cloudflared -> server:8080; no egress to 169.254.169.254
```

| Piece | Where it is defined |
|---|---|
| Namespace, `flux-applier` (admin in `jarvis3` only) | [`deploy/bootstrap/`](../deploy/bootstrap/), applied once by cloud-init, never by Flux |
| Server, Litestream, org-env mirror, tunnel, policies | [`deploy/base/`](../deploy/base/), used by each instance as a remote base pinned to a commit |
| Box creation, Cloudflare, deploy keys, SOPS secrets | [`infra/instance.py`](../infra/instance.py) + [`infra/cloud-init.sh`](../infra/cloud-init.sh) |
| A complete fake instance repo (`example.org`) | [`deploy/example-instance/`](../deploy/example-instance/) |
| CI-only overlay: MinIO bucket, fake secrets | [`deploy/smoke/`](../deploy/smoke/) |

Pinned versions: k3s and Flux in the instance's `instance.json`; Litestream (0.5.17), alpine/git and
cloudflared by digest in `deploy/base`; the server image by the 12-hex commit tag in `instance.json`.

### Why it is shaped this way

- **Nothing to log in to.** As in Jarvis 2, a box changes only through git; a box git can't fix is
  replaced. There is no SSH key, no reachable k8s API and no admin token anywhere.
- **A push can't escalate.** Flux applies the instance repo as `flux-applier`, which is `admin` inside the
  `jarvis3` namespace and nothing else. The namespace and that binding come from cloud-init, so the repo
  can't widen them, and kustomize-controller's default service account is the powerless `default`, so a
  Kustomization that names none can do nothing.
- **The user-data holds the age key and the Flux deploy key.** cloud-init turns them into Secrets and
  shreds its copies; Hetzner keeps serving user-data from the metadata service, so the namespace's pods
  have no route to `169.254.169.254`.
- **One replica, Recreate.** Session channels live in the server's memory, and two servers must never
  write the SQLite file at once.
- **Restore before start.** On an empty volume (a new box) the `restore` init container pulls the newest
  replica from the bucket before the server starts; on a volume that has the file it does nothing.
- **Any valid service token passes Access.** Paired devices get their service tokens from the server at
  runtime, so the Access app's service-auth policy admits any service token of the Cloudflare account.
  The server then accepts only the session gate and the devices it minted (docs/API.md section 1).
  In an account shared with other services, their service tokens also pass Access for this hostname and
  are refused by the server with 403.

## The private instance repo

Each instance has its own private repo in its organisation's GitHub org. This public repo holds no
instance's names, domains, emails or ids. The instance repo must contain exactly this
([`deploy/example-instance/`](../deploy/example-instance/) is a filled-in fake):

| Path | What | Written by |
|---|---|---|
| `instance.json` | infra parameters: name, hostname, the jarvis3 commit and server image tag, Hetzner location/type/image, Cloudflare account id, zone id, Access team domain, Google Workspace IdP name and domain, allowed email domains, bucket endpoint/region/name, the instance and org-env repos, k3s and Flux versions | the admin |
| `deploy/config.json` | the server config ([CONFIG.md](CONFIG.md)); `orgEnv.mirrorPath` must be `/data/org-env.git` and `publicUrl`, `access.teamDomain`, `storage` must match `instance.json` (`instance.py check`) | the admin |
| `deploy/kustomization.yaml` | the remote base `github.com/DE0CH/jarvis3//deploy/base?ref=<commit>`, the two ConfigMaps, the server image tag | `instance.py scaffold` |
| `deploy/instance.env` | ConfigMap `jarvis-instance`: Litestream's bucket settings and `ORG_ENV_URL` | `instance.py scaffold` |
| `deploy/secrets.enc.yaml` | SOPS-encrypted Secrets `jarvis-secrets` (the server's secret env, CONFIG.md), `tunnel-token`, `org-env-deploy-key` | `instance.py secrets` |
| `flux/sync.yaml` | the Flux entry point: GitRepository `instance` + Kustomization `instance` (path `./deploy`, SOPS, `flux-applier`). Applied once by cloud-init | `instance.py scaffold` |
| `age.pub`, `.sops.yaml` | the box's age recipient; SOPS rule encrypting `data`/`stringData` of `deploy/*.enc.yaml` | `instance.py age-key` |

Not in the repo: the age private key (the admin's password manager) and the private halves of the
deploy keys (the Flux one goes into the box's user-data; the org-env one into `secrets.enc.yaml`).

Flux fetches the remote base and pulls `ghcr.io/de0ch/jarvis3-server` anonymously, so both need
DE0CH/jarvis3 and its packages to be public. Until then an instance needs a pull secret and a copy of
the base.

## Accounts and tokens an instance needs

| For | What | Scope |
|---|---|---|
| `instance.py box` | `HCLOUD_TOKEN` | read/write API token of the instance's own Hetzner project |
| `instance.py cloudflare` | `CLOUDFLARE_API_TOKEN` | Account: Access: Apps and Policies, Service Tokens, Organizations/Identity Providers (edit), Cloudflare Tunnel (edit); Zone: DNS (edit) on the instance's zone |
| `instance.py cloudflare` | `GOOGLE_IDP_CLIENT_ID`, `GOOGLE_IDP_CLIENT_SECRET` | an OAuth client (Web) in the organisation's own Google Workspace Cloud project, consent screen **internal**, redirect URI `https://<team domain>/cdn-cgi/access/callback` |
| `instance.py deploy-keys` | `GITHUB_TOKEN` | fine-grained, Administration: write on the instance repo and the org-env repo (to add read-only deploy keys) |
| the server (`CF_DEVICE_TOKENS_API`) | a Cloudflare API token made in the dashboard | Account: Access: Service Tokens (edit) only |
| the server and Litestream (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`) | Hetzner Object Storage credentials | the instance bucket; bucket and credentials are made in the Hetzner Console (the API has no credential endpoint) |

The other server secrets (CONFIG.md) come from the instance's Fly org, OpenRouter organisation and
Google Workspace service account.

## Testing

`.github/workflows/deploy.yml`, on every push touching `deploy/`, `infra/` or `server/`:

- `infra`: `python3 -m unittest discover -s infra/tests` — dry runs make no network call and print no
  secret, `--apply` against fake Hetzner/Cloudflare/GitHub APIs (order, idempotency, the out file's
  mode), scaffold reproduces the example repo, a real SOPS/age round trip, the rendered user-data
  parses; then the dry runs of every step with canary secrets in the environment.
- `manifests`: `kubectl kustomize` of bootstrap, base, the example instance (decrypted with its
  test-only age key, as Flux would) and the smoke overlay; `kubeconform -strict` with the Flux CRD
  schemas; both Deployments and the PVC present, no unpinned image.
- `smoke`: [`deploy/smoke/run.sh`](../deploy/smoke/run.sh) on a k3d cluster at the instance's k3s
  version, with the server image built from the commit: Pod Security admission, the init containers,
  the server's health, the org-env mirror, the NetworkPolicies (cloudflared gets through, another pod
  doesn't), and Litestream replicate-then-restore onto a new volume (same user ids after the restore).
  Runs locally too with docker, k3d and kubectl.

Not tested in CI: the real cloud APIs, the cloud-init run on a real Ubuntu box, Flux itself pulling
the instance repo.
