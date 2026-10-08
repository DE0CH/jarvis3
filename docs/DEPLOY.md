# Deploying an instance (server only, v1 notes)

Deploy manifests (Kustomize base, Flux objects) are not written yet; this page records what the
server needs from a deployment so they can be.

## Process

`node --disable-warning=ExperimentalWarning server/src/main.ts` (Node ≥ 22.18; TypeScript runs by
type stripping, there is no build step). One process per instance; it holds the reverse channels of
all sessions in memory, so run exactly **one replica**. Listens on `PORT` (8080). `GET /api/health`
needs no identity (liveness probe). On SIGTERM it waits for running lifecycle jobs, then exits.

The tunnel (cloudflared or equivalent) must pass WebSocket upgrades and keep idle sockets open
(session channels ping every 30 s).

## State: one SQLite file, replicated

All instance state is one SQLite file (`JARVIS_DB`, WAL mode) on the server's volume. Schema
migrations run in code at start (`PRAGMA user_version`).

Replication to the instance's bucket is deployment config, Litestream-style: a sidecar continuously
streams the WAL to the bucket and restores the newest copy before the server starts when the volume
is empty. A Litestream config for this layout:

```yaml
# /etc/litestream.yml (sidecar; credentials from the same S3_* secrets, or separate ones)
dbs:
  - path: /data/jarvis.db
    replicas:
      - type: s3
        bucket: example-jarvis
        path: db
        endpoint: https://fsn1.your-objectstorage.com
        region: fsn1
        sync-interval: 10s
        retention: 720h
```

- init container: `litestream restore -if-db-not-exists -if-replica-exists /data/jarvis.db`
- sidecar: `litestream replicate`
- The bucket keeps the replica under `db/`, next to `snapshots/` and `archives/` (section 10 of
  docs/API.md). The database holds key material only sealed with `JARVIS_DB_KEY`, which is not in
  the bucket.

## The org-env mirror

The server reads the org-env tree from a bare mirror at `orgEnv.mirrorPath` with `git archive`. Keep
it fetched with a read-only deploy key (an init container plus a periodic `git fetch`); the pinned
`orgEnv.commit` must be present in it. The deploy key never reaches a session.
