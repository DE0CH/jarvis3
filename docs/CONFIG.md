# Instance configuration

An instance server reads one JSON file (path in `JARVIS_CONFIG`, default `/etc/jarvis/config.json`)
and its secrets from environment variables. Both live in the instance's own deploy repo (the secrets
SOPS-encrypted), never in this repo. A full example with placeholders:
[`deploy/example-config.json`](../deploy/example-config.json). The type is `Config` in
[`server/src/config.ts`](../server/src/config.ts); the server refuses to start on an invalid file.

## The file

| field | meaning |
|---|---|
| `instanceName` | short name; prefixes OpenRouter key names and device token names |
| `publicUrl` | `https://<host>`, no path. Sessions dial in here; the `Origin` guard compares against it |
| `access.teamDomain` | the Cloudflare Access team domain, e.g. `example.cloudflareaccess.com` |
| `access.audience` | the Access application's AUD tag |
| `access.sessionGateClientId` | client id of the ONE service token every session machine uses to pass Access. It identifies no user; with it, only `/api/session/*` and the channel work, and only with a session token |
| `directory.kind` | `google` (Workspace Directory API) or `static` |
| `directory.domain`, `.subject` | (google) the Workspace domain, and the admin user the read-only service account impersonates |
| `directory.groupRoles` | (google) group email → role |
| `directory.users` | (static) `[{email, name?, role, suspended?}]` — for a one-person instance |
| `directory.intervalSeconds` | poll interval, default 300 |
| `bootstrapAdmins` | emails that get the first admin role whatever their groups say (suspension still wins) |
| `roles` | role → `{openrouterMonthlyUsd, machineHoursPerMonth, admin?}`. `null` = no limit. Key order is the precedence when a user is in several mapped groups. At least one role has `admin: true` |
| `models`, `defaultModel` | the curated OpenRouter model list (`{id, label}`) and its default |
| `machines` | `kind: "fly"`: `app` (one per instance), `org`, `region`, session `image`, `guest` size, `rootfsGb`. `kind: "docker"` (CI and local runs only): `image`, `guest`, `socketPath`, `network`, `envOverrides`, `extraHosts` |
| `storage` | S3 endpoint, region, bucket (Hetzner Object Storage in the instance's own project) |
| `orgEnv.mirrorPath` | a bare mirror of the org-env repo kept fetched by the deployment (read-only deploy key) |
| `orgEnv.commit` | the full 40-hex commit every new session loads; changing it is a deploy |
| `daemonPath` | the Paseo daemon WebSocket path inside a session |
| `idleMinutes` | auto-pause after this long reported idle (0 = off) |
| `budget.monthlyUsd`, `budget.warnUsd` | instance-wide machine spend cap and warning (null = off; warn defaults to 80 %) |
| `devices.appScheme` | URL scheme that receives the pairing answer |
| `devices.cloudflareAccountId` | the account holding the device service tokens |
| `presignSeconds` | lifetime of snapshot upload/restore URLs, default 3600 |

## Secrets (environment)

| variable | what | scope it needs |
|---|---|---|
| `JARVIS_DB_KEY` | 32 random bytes, base64 — seals OpenRouter keys and daemon passwords in the database | — |
| `OPENROUTER_MANAGEMENT_KEY` | OpenRouter management (provisioning) key | create/update/delete API keys |
| `FLY_API_TOKEN` | Fly token for the instance's session app (with `machines.kind: "fly"`) | that app only |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | bucket credentials | the instance bucket |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (google directory) the service account key JSON | domain-wide delegation with `admin.directory.user.readonly` and `admin.directory.group.member.readonly` only |
| `CF_DEVICE_TOKENS_API` | Cloudflare API token | Access: Service Tokens edit, nothing else |
| `SESSION_GATE_CLIENT_SECRET` | secret of the session gate service token (handed to session machines) | — |

Other environment: `JARVIS_DB` (SQLite path, default `/data/jarvis.db`), `PORT` (default 8080),
`JARVIS_WEB_DIR` (the app's web build served at `/`; `/app/web` in the server image; unset = only
`/api`).

## Cloudflare Access setup (per instance)

- One Access application for the instance hostname, with the identity provider as its login and a
  policy admitting the organisation's domain, plus a **Service Auth** policy admitting service tokens
  (paired devices and the session gate).
- The session gate is one service token created once; its client id goes in
  `access.sessionGateClientId`, its secret in `SESSION_GATE_CLIENT_SECRET`.
