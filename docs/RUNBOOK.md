# Runbook: one instance

How an admin brings up, upgrades, rebuilds and restores an instance. The shape of the deployment is in
[DEPLOY.md](DEPLOY.md). Every `infra/instance.py` step is a dry run unless given `--apply`: run it
without first and read what it would do. No step prints a secret.

`REPO` below is a checkout of the instance's private repo; `KEYS` is a private directory outside any
repo (mode 700) for the files the steps write.

## Bring-up

1. **Accounts** (DEPLOY.md "Accounts and tokens"): the Hetzner project, the Object Storage bucket and its
   credentials (Hetzner Console), the Cloudflare zone, the Google OAuth client for Access, the GitHub org
   with the private instance repo and the org-env repo, the Fly org, the OpenRouter organisation, the
   Workspace service account for the directory. Make the scoped `CF_DEVICE_TOKENS_API` token in the
   Cloudflare dashboard. A new GitHub org refuses deploy keys (422 "Deploy keys are disabled for this
   repository") until an owner allows them: `PATCH /orgs/<org>` with `deploy_keys_enabled_for_repositories=true`.
   Create the Fly app named in `machines.app` in the instance's Fly org (`POST /v1/apps` on the Machines
   API); the server doesn't.
2. **`instance.json` and `deploy/config.json`** in `REPO`, starting from
   `deploy/example-instance/`. Pin `jarvis3.ref` to a commit of DE0CH/jarvis3 and
   `jarvis3.serverImageTag` to the server image built from it (`ghcr.io/de0ch/jarvis3-server:<12 hex>`).
3. `infra/instance.py age-key REPO --out KEYS/age.key` — then store `KEYS/age.key` in the admin's
   password manager. A rebuild reuses it.
4. `infra/instance.py scaffold REPO` — `deploy/kustomization.yaml`, `deploy/instance.env`,
   `flux/sync.yaml`, `.sops.yaml`.
5. `infra/instance.py deploy-keys REPO --out-dir KEYS --apply` — read-only deploy keys on the instance
   repo (for Flux) and the org-env repo (for the server's mirror). If it fails after writing a key file, delete
   `KEYS/*-deploy-key*` before running it again.
6. `infra/instance.py cloudflare REPO --out KEYS/cloudflare.env --apply` — the Google Workspace login, the
   Access app (made before any DNS points at the tunnel), the session gate token, the tunnel and its DNS
   name. Copy the printed `access.audience` and `access.sessionGateClientId` into `deploy/config.json`.
   Without a Workspace yet (no `cloudflare.identityProvider`), the Access app takes the login methods the
   Cloudflare account already has, such as one-time PIN, and admits `cloudflare.allowedEmails`; pair it
   with `directory.kind: "static"` in `deploy/config.json`. With `cloudflare.accessScope: "zone"` the
   Access apps are made at the zone, for a token that has Access rights on the instance's zone only.
7. `infra/instance.py secrets REPO --apply KEY[=SRC]…` naming every key; for example:

   ```bash
   set -a; . KEYS/cloudflare.env; set +a        # TUNNEL_TOKEN, SESSION_GATE_CLIENT_SECRET
   JARVIS_DB_KEY=$(openssl rand -base64 32) \
   infra/instance.py secrets REPO --apply JARVIS_DB_KEY OPENROUTER_MANAGEMENT_KEY FLY_API_TOKEN \
     S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY CF_DEVICE_TOKENS_API SESSION_GATE_CLIENT_SECRET TUNNEL_TOKEN \
     GOOGLE_SERVICE_ACCOUNT_JSON=file:KEYS/directory-sa.json ORG_ENV_DEPLOY_KEY=file:KEYS/org-env-deploy-key
   ```

   Keep `JARVIS_DB_KEY` in the password manager too: the database's sealed keys are useless without it.
8. `infra/instance.py check REPO`, then commit and push `REPO`.
9. `infra/instance.py box REPO --age-key KEYS/age.key --flux-key KEYS/flux-deploy-key --apply` — the
   firewall (no inbound rules) and the server. cloud-init installs k3s and Flux and applies
   `flux/sync.yaml`; Flux then applies `./deploy`. The instance is up when
   `https://<hostname>/api/health` answers (a few minutes).
10. Delete `KEYS/cloudflare.env` and the deploy key files once they are in the password manager or
    the encrypted secrets.

## Deploying a change

Everything is a push to the instance repo; Flux applies it within a minute.

- **A new jarvis3 version:** set `jarvis3.ref` and `jarvis3.serverImageTag` in `instance.json`, run
  `scaffold`, commit, push. A new session image is `machines.image` in `deploy/config.json`.
- **Config:** edit `deploy/config.json`; the ConfigMap's name changes with its content, so the server
  restarts with it.
- **New org-env commit:** `orgEnv.commit` in `deploy/config.json`. The mirror fetches every 5 minutes;
  push the org-env commit first.
- **An extra app's manifests:** edit `apps/<name>/app/`, commit, push (DEPLOY.md, "Extra apps").
- **A new extra app:** add it to `instance.json` `apps`, put its manifests in `apps/<name>/app/`, run
  `scaffold`, `cloudflare --apply` (its Access app, tunnel and DNS; the token goes to the out file),
  `secrets REPO APP_<NAME>_TUNNEL_TOKEN=env:<var> --apply` with the token from that out file, commit,
  push, then
  rebuild the box: its namespace and Flux identity are made only at box creation. Back up the
  app's own data first if it moves from elsewhere; Litestream covers only the Jarvis 3 database.

## Rotating a secret

Run `instance.py secrets REPO --apply …` again with every key (it rewrites the whole file), commit and
push. An extra app's tunnel token (`APP_<NAME>_TUNNEL_TOKEN`) has a file of its own and can be
rewritten alone. The file's hash is an annotation on every pod template (`jarvis3/secrets-rev` in
`deploy/kustomization.yaml`), so the pods restart with the new values.

- `TUNNEL_TOKEN`, `SESSION_GATE_CLIENT_SECRET`: `ROTATE=1 instance.py cloudflare … --apply` mints new
  ones; the session gate change cuts off running sessions until they are resumed on new machines.
- Deploy keys: delete the old key on GitHub, run `deploy-keys` with a new `--out-dir`, then `secrets`
  (org-env key) or a rebuild (Flux key, which lives only on the box).
- The age key: a rebuild with a new `age-key`, after re-encrypting every secret to it.

## Rebuilding the box

The volume's only state is the SQLite file (replicated) and the org-env mirror (re-cloned).

1. Delete the server in the instance's Hetzner project.
2. `instance.py box REPO --age-key KEYS/age.key --flux-key KEYS/flux-deploy-key --apply` with the age key
   from the password manager and the Flux deploy key (make a new one with `deploy-keys` if it is gone).
3. On the empty volume the `restore` init container restores the newest replica before the server
   starts. Sessions dial in again on their own; paired devices keep working (their tokens are at
   Cloudflare, their records in the database).

## Restoring the database

- **Latest state onto a new box:** automatic (above).
- **Inspect or recover an older state** on a workstation with the bucket credentials:

  ```bash
  export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
  litestream ltx -config litestream.yml /data/jarvis.db          # the available points in time
  litestream restore -config litestream.yml -timestamp 2026-10-01T12:00:00Z -o ./jarvis.db /data/jarvis.db
  ```

  with `litestream.yml` = `deploy/base/litestream.yml` with the bucket's values filled in.
  Putting an older state back on a running box is not automated: there is no way into the box. It
  takes a rebuild after the replica in the bucket has been replaced by the restored file.

## Looking at things

There is no shell on the box. What the server answers through the tunnel (`/api/health`, the admin
routes) and the bucket's contents are what an admin can see; a box that misbehaves in a way git can't
fix is rebuilt.

Reading `https://<hostname>/api/health` through Access (any service token of the account passes; the
health route needs no user):

- `530`: no tunnel connector. cloud-init or Flux hasn't got as far as cloudflared (the first boot takes a
  few minutes), or the tunnel token is wrong.
- `502`: cloudflared is up (so Flux applied `./deploy`) but the server isn't ready: an init container
  failing (Litestream restore, the org-env clone) or the server exiting. With no `db/` objects in the
  bucket, Litestream never started, so the pod is still in its init containers. Reproduce the step
  off the box: `litestream restore` with `deploy/base/litestream.yml` and the bucket credentials, or a
  clone of the org-env repo with its deploy key.
- An extra app answering while the server doesn't tells you the box, Flux and the tunnels work.
