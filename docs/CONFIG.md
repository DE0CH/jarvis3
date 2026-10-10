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
| `roles` | role → `{openrouterMonthlyUsd, machineHoursPerMonth, admin?, toolsMonthlyUsd?, proxyMonthlyGb?}`. `null` = no limit. `toolsMonthlyUsd` (search + fetch, USD) is required once `tools.search` or `tools.fetch` is set, `proxyMonthlyGb` once `tools.proxy` is (a number, or an explicit `null`; a `subuser` proxy needs a number). Key order is the precedence when a user is in several mapped groups. At least one role has `admin: true` |
| `models`, `defaultModel` | the curated OpenRouter model list (`{id, label, images?}`) and its default; `images: true` = the model takes image input, so attached images go to it inline (otherwise only as files) |
| `machines` | `kind: "fly"`: `app` (one per instance, made by the operator and kept; the server never creates or deletes it, so `FLY_API_TOKEN` can be scoped to that app), `org`, `region`, session `image`, `guest` size, `rootfsGb`. `kind: "docker"` (CI and local runs only): `image`, `guest`, `socketPath`, `network`, `envOverrides`, `extraHosts` |
| `storage` | S3 endpoint, region, bucket (Hetzner Object Storage in the instance's own project) |
| `orgEnv.mirrorPath` | a bare mirror of the org-env repo kept fetched by the deployment (read-only deploy key); `/data/org-env.git` under the standard deployment (docs/DEPLOY.md) |
| `orgEnv.commit` | the full 40-hex commit every new session loads; changing it is a deploy |
| `daemonPath` | the Paseo daemon WebSocket path inside a session |
| `idleMinutes` | auto-pause after this long reported idle (0 = off) |
| `budget.monthlyUsd`, `budget.warnUsd` | instance-wide machine spend cap and warning (null = off; warn defaults to 80 %) |
| `devices.appScheme` | URL scheme that receives the pairing answer |
| `devices.cloudflareAccountId` | the account holding the device service tokens |
| `presignSeconds` | lifetime of snapshot upload/restore URLs, default 3600 |
| `suggestions` | optional; turns on "Suggest for everyone": `kind: "github"`, `repo` (`owner/name` of the org-env repo), `baseBranch` (default `main`), `apiUrl` (default `https://api.github.com`; a GitHub Enterprise Server's `https://<host>/api/v3`), `auth`: `{kind: "token"}` or `{kind: "app", appId, installationId}`. Absent: the app hides the button and the route answers 409 |
| `owner` | an admin's email: the only person who approves Tier 3 changes, with a passkey ([ACTIONS.md](ACTIONS.md)) |
| `tools` | optional; Tier 0 tools ([TOOLS.md](TOOLS.md)): `search`, `fetch`, `proxy`, each `{provider, credential?, baseUrl?, pricing?, settings?}` (`credential` names the environment variable with the organisation's key; `pricing`: `perCallUsd`, `perCreditUsd`, `perGbUsd`), and `monthlyUsd`, an instance-wide cap on search + fetch. A kind left out is off |
| `files` | optional: `maxFileBytes` (one file, default 50 MiB; Cloudflare's free plan refuses request bodies over 100 MB), `quotaBytes` (per person, default 1 GiB), `sessionSyncBytes` (how much of a person's files a session copies at boot, default 256 MiB; the rest on demand) — docs/API.md section 13 |
| `actions` | the broker's named actions, their policies and the environment variables holding their credentials ([ACTIONS.md](ACTIONS.md)) |
| `schedules` | optional limits on scheduled tasks ([API.md](API.md) section 15): `maxPerUser` (default 20), `minIntervalMinutes` (the shortest gap between two firings of one schedule, default 60), `missedGraceMinutes` (a firing the server missed while down still runs if at most this late, default 60) |
| `push` | optional; push notifications for notices ([API.md](API.md) section 16): `apns` `{teamId, keyId, bundleId, environment?}` (the iOS app; `environment` is the default for a token that doesn't say, `production`) and/or `webPush` `{subject, publicKey, allowedHosts?}` (`subject` a `mailto:` or `https:` URL, `publicKey` the VAPID public key, base64url). A channel left out is off |
| `wakeups` | optional limits on wakeups: `maxPerTask` (armed at once, default 20), `minCheckSeconds` (shortest check interval, default 60), `minIntervalMinutes` (shortest gap of a recurring wakeup, default 15) |

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
| `GITHUB_SUGGEST_TOKEN` | (`suggestions.auth.kind: "token"`) a fine-grained token | the org-env repo only: Contents (read and write), Pull requests (read and write) |
| `GITHUB_APP_PRIVATE_KEY` | (`suggestions.auth.kind: "app"`) the GitHub App's private key, PEM | an App installed on the org-env repo only, with Contents and Pull requests (write); the server asks GitHub for installation tokens narrowed to that repo and those two permissions |
| `APNS_KEY_P8` | (`push.apns`) the APNs auth key, the `.p8` file's contents | an Apple "Apple Push Notifications service" key of the team that owns the app; one key serves every app of the team |
| `VAPID_PRIVATE_KEY` | (`push.webPush`) the VAPID private key, base64url (`npx web-push generate-vapid-keys`) | — |

Tier 0 provider keys: the environment variables `tools.<kind>.credential` names (the server refuses
to start when one is missing). They stay on the server; scope each to the instance (a dedicated key
or sub-account of the provider where it has them).

Each action's credentials: the environment variables its `credentials` names (Tier 2 secrets; the
server refuses to start when one is missing).

Other environment: `JARVIS_DB` (SQLite path, default `/data/jarvis.db`), `PORT` (default 8080),
`JARVIS_WEB_DIR` (the app's web build served at `/`; `/app/web` in the server image; unset = only
`/api`).

## Cloudflare Access setup (per instance)

- One Access application for the instance hostname, with the identity provider as its login and a
  policy admitting the organisation's domain, plus a **Service Auth** policy admitting service tokens
  (paired devices and the session gate).
- The session gate is one service token created once; its client id goes in
  `access.sessionGateClientId`, its secret in `SESSION_GATE_CLIENT_SECRET`.

How an instance is deployed and operated: [`DEPLOY.md`](DEPLOY.md) and [`RUNBOOK.md`](RUNBOOK.md).
