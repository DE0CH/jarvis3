# Jarvis 3 instance API

The contract between an instance server (`server/`) and its clients: the app (web and iOS) and the
session machines. The request and response types are exported from
[`server/src/api-types.ts`](../server/src/api-types.ts); import them type-only
(`import type { TaskView } from "…/api-types.ts"`). Where this page and that module disagree, the
module is right and this page is a bug.

Base URL: `https://<instance host>` (the config's `publicUrl`). All bodies are JSON (UTF-8) unless
stated. Times are ISO-8601 UTC strings.

## 1. Authentication

Cloudflare Access sits in front of the whole hostname. The server does **not** trust that Access ran:
it verifies Access's JWT itself on every request (except `GET /api/health`).

- **JWT source:** the `Cf-Access-Jwt-Assertion` header (Access adds it), else the `CF_Authorization`
  cookie.
- **Checks:** RS256 signature against the team's keys (`https://<team>/cdn-cgi/access/certs`, cached
  1 h, refetched for an unknown `kid`), `iss` = `https://<access.teamDomain>`, `aud` contains
  `access.audience`, `exp` (5 s tolerance), `nbf` if present.
- **Who it is:**

| JWT carries | Caller | Accepted when |
|---|---|---|
| `email` (an identity login) | that user | the email is a user with status `active` |
| `common_name` = a paired device's client id | the device's user | the device is not revoked and its user is `active` |
| `common_name` = `access.sessionGateClientId` | a session | `Authorization: Bearer <session token>` matches a task whose state is `starting`, `running`, `idle`, `pausing` or `destroying` |
| `common_name` = anything else | nobody | never |

Client-sent identity headers (`x-access-email` and the like) are ignored.

**Cross-origin guard.** A request that is not `GET`/`HEAD`, and every WebSocket upgrade, is refused
with 403 when it carries an `Origin` header other than `publicUrl`. Native apps and sessions send no
`Origin`.

## 2. Authorisation

One function, `authorize(principal, target)` in `server/src/auth.ts`, decides every route and the
daemon proxy. Targets:

| target | who passes |
|---|---|
| `member` | any active user (identity login or device) |
| `owned` (a task, device, user record or personal layer of user U) | U, or an admin |
| `admin` | an admin (a user whose role has `admin: true` in the config) |
| `identity-login` | an active user signed in through the identity provider (not a device token, not a session) |
| `session` | a session principal (gate token + valid session token) |

### Status codes, in order of precedence

| status / code | when |
|---|---|
| 401 `unauthenticated` | no Access JWT, an invalid one, or (on `/api/session/*` and the channel) no valid session token |
| 403 `forbidden` | valid JWT but: unknown email, suspended or removed user, unknown or revoked device, a session credential on a non-session route, a foreign `Origin` |
| 404 `not_found` | the resource does not exist **or belongs to someone else**, or an admin-only route called by a non-admin. The body is identical in all these cases, so a 404 never reveals that something exists |
| 400 `bad_request` | malformed body or parameters |
| 409 `busy` | another lifecycle operation is running on the task |
| 409 `conflict` | the task's state does not allow this, or nothing to undo |
| 429 `machine_hours_cap`, `instance_budget`, `too_many_requests` | caps (section 6), pairing rate limit |
| 502 `upstream` | Fly, OpenRouter, Cloudflare, Google or S3 failed |
| 503 `unavailable` | the daemon proxy was opened while the task's session is not connected |

Error body (every non-2xx JSON answer):

```json
{ "error": { "code": "not_found", "message": "no such task" } }
```

### Who may call what

`O` = owner, `A` = admin, `M` = any active member, `S` = the session (its own task only).
`:id` in `/api/users/:id/…` may be `me`.

| method | path | who |
|---|---|---|
| GET | `/api/health` | anyone (no JWT needed) |
| GET | `/api/me` | M |
| GET | `/api/devices/pair` | identity login only |
| GET | `/api/devices` | M (own devices); `?all=1`: A |
| DELETE | `/api/devices/:id` | O, A |
| GET | `/api/models` | M |
| POST | `/api/tasks` | M (creates a task owned by the caller) |
| GET | `/api/tasks` | M (own); `?userId=U`: O of U, A; `?all=1`: A |
| GET | `/api/tasks/:id` | O, A |
| POST | `/api/tasks/:id/pause` | O, A |
| POST | `/api/tasks/:id/resume` | O, A |
| DELETE | `/api/tasks/:id` | O, A |
| WS | `/api/tasks/:id/daemon` | O, A |
| GET | `/api/users` | A |
| GET | `/api/users/:id` | O, A |
| PATCH | `/api/users/:id/limits` | A |
| GET | `/api/users/:id/layer` | O, A |
| GET | `/api/users/:id/layers` | O, A |
| PUT | `/api/users/:id/layer/instructions` | O, A |
| PUT | `/api/users/:id/layer/skills/:name` | O, A |
| DELETE | `/api/users/:id/layer/skills/:name` | O, A |
| POST | `/api/users/:id/layer/notes` | O, A |
| DELETE | `/api/users/:id/layer/notes/:noteId` | O, A |
| POST | `/api/users/:id/layer/reset` | O, A |
| POST | `/api/users/:id/layer/undo` | O, A |
| GET | `/api/notices` | M (own notices) |
| GET | `/api/admin/budget` | A |
| POST | `/api/admin/directory/sync` | A |
| GET | `/api/session/bundle` | S |
| GET | `/api/session/org-env.tar` | S |
| POST | `/api/session/notes` | S |
| POST | `/api/session/status` | S |
| WS | `/api/session/channel` | S |

`server/test/authz.test.ts` checks this whole table for ten kinds of caller.

## 3. Identity and devices

### `GET /api/health` → `Health`
`{ "ok": true, "version": "0.1.0" }`

### `GET /api/me` → `UserDetail`

```json
{
  "user": { "id": "1bb0e5661a4b5508", "email": "alice@example.org", "name": "Alice", "role": "staff",
            "status": "active", "isAdmin": false, "createdAt": "2026-10-08T12:00:00.000Z" },
  "limits": { "openrouterMonthlyUsd": 20, "openrouterOverride": false, "machineHoursPerMonth": 10, "machineHoursOverride": false },
  "usage": { "month": "2026-10", "machineHours": 1.5, "machineHoursCapReached": false, "openrouterKey": true }
}
```

`limits` values are what is in force (the role's default, or the admin's per-user override); `null`
means no limit. `usage.openrouterKey` is false until the user's first task.

### `GET /api/devices/pair?state=…&name=…&model=…` → 302

Pairs the device that opened this URL in the system sign-in sheet (Jarvis 1's pattern): the identity
provider login happens in the sheet; the server mints a per-device Cloudflare Access service token for
the caller and answers with a redirect to the app's own scheme (`devices.appScheme` in the config):

- success: `<scheme>://paired?state=<state>&id=<device id>&clientId=<…>&clientSecret=<…>` (`PairResult`).
  The secret is shown this once and never stored by the server.
- failure: `<scheme>://paired?state=<state>&error=<message>&status=<http status>` — e.g. `403` when
  called with a device token, `429` within 30 s of the user's previous pairing.

`state` must match `[A-Za-z0-9_-]{16,64}` (else a 400 JSON error); `name` ≤ 80 and `model` ≤ 40
characters. A caller that is not an active member at all gets the JSON 401/403 instead of a redirect.

The app then sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every request; Access turns
them into a JWT whose `common_name` names the device.

### `GET /api/devices` → `DeviceList`
`{ "devices": [DeviceView…] }` — the caller's active devices; `?all=1` (admin) lists everyone's.

### `DELETE /api/devices/:id` → `{ "ok": true }`
Revokes the device: the server refuses its token at once and deletes it at Cloudflare.

## 4. Models

### `GET /api/models` → `ModelList`
`{ "models": [{ "id": "anthropic/claude-…", "label": "…" }], "default": "anthropic/claude-…" }` — the
instance's curated list.

## 5. Tasks

A task is one session machine running OpenCode under a Paseo daemon. States (`TaskState`):

```
            create                 channel connects        status idle
  (none) ─────────► starting ──────────────────► running ◄──────────────► idle
                       │ machine can't be made     │  status busy          │
                       ▼                           │ pause / idle timeout / cap / budget / offboarding
                     failed                        ▼                       │
                                                pausing ◄──────────────────┘
                                                   │ snapshot ok (or forced) → machine destroyed
                                                   ▼
                       resume ◄──────────────── paused
                       (→ starting, new machine restores the snapshot)

  any of starting/running/idle/paused/failed ── DELETE ──► destroying ──► archived (final)
```

One lifecycle operation at a time per task (`busy.kind`: `creating`, `pausing`, `resuming`,
`destroying`). Another operation meanwhile answers **409 `busy`**; it is never queued. Pause, resume
and destroy answer **202** at once with the task in its transitional state; poll `GET /api/tasks/:id`
(or the list) until `busy` is null.

### `TaskView`

```json
{
  "id": "7ce0326a5435ab61", "userId": "1bb0e5661a4b5508", "title": "Write the weekly report",
  "model": "anthropic/claude-…", "state": "running", "busy": null, "error": null, "pausedReason": null,
  "createdAt": "…", "updatedAt": "…", "connected": true
}
```

- `connected`: the session's reverse channel is up, so the daemon proxy can be opened.
- `error`: why the last operation failed (e.g. `pause failed, the task keeps running: …`), or null.
- `pausedReason`: `user`, `idle`, `machine_hours_cap`, `instance_budget` or `offboarded` while paused.

### `POST /api/tasks` (`CreateTaskRequest`) → 201 `TaskView`

```json
{ "prompt": "Draft the Q3 supplier summary", "model": "anthropic/claude-…", "title": "Q3 suppliers", "requestId": "a1b2c3" }
```

- `prompt`: required, 1..16000 characters. Handed to the session as its first message.
- `model`: optional, one of `GET /api/models` (default: the instance default).
- `title`: optional, ≤ 120 characters; default = the prompt's first line cut to 80.
- `requestId`: optional `[A-Za-z0-9_-]{1,64}`; a repeat by the same user returns the first task
  (status 201, same id) and creates nothing.

On the user's first task the server mints their OpenRouter key here (an OpenRouter failure = **502**,
no task is created). Refused with **429** when the user's machine-hour cap or the instance budget is
reached. The task comes back `starting` with `busy.kind = "creating"`; it becomes `running` when the
session dials in, or `failed` (with a notice) when no machine could be made.

### `GET /api/tasks` → `TaskList`
Newest first. The caller's own tasks; `?userId=U` (that user or an admin); `?all=1` (admin).

### `GET /api/tasks/:id` → `TaskView`

### `POST /api/tasks/:id/pause` → 202 `TaskView`
Allowed from `starting`, `running`, `idle` (else 409 `conflict`). Snapshot to the bucket, then the
machine is destroyed and the session token dies. If the snapshot fails the task goes back to its
previous state with `error` set and the machine keeps running.

### `POST /api/tasks/:id/resume` → 202 `TaskView`
Allowed from `paused` (else 409). A new machine is created that restores the snapshot; the
conversation continues. Refused with 429 at a cap, 409 when the owner is no longer active. A machine
that can't be made leaves the task `paused` with `error` set.

### `DELETE /api/tasks/:id` → 202 `TaskView`
Allowed from every state but `archived`. Archives first (a running machine uploads its final state; a
paused task's snapshot is moved), writes `task.json`, then destroys the machine; final state
`archived`. If archiving fails the task returns to its previous state with `error` set, unless
`?force=1`, which destroys anyway (`error` then says so).

### `WS /api/tasks/:id/daemon` — the chat

A WebSocket to the task's Paseo daemon, relayed through the server. On every upgrade the server
verifies the caller (section 1), runs `authorize` (owner or admin, else the HTTP 404 answer), and
needs the session connected (else HTTP 503). It then asks the session's channel to open
`daemonPath` on the local daemon and relays frames both ways, text as text and binary as binary.

- The server adds `paseo.bearer.<daemon password>` as the first subprotocol towards the daemon. The
  client never holds the password; a `paseo.bearer.*` protocol the client offers is dropped, and the
  subprotocol answered to the client is the first non-bearer one it offered (or none).
- The socket closes with 1001 when the session disconnects or the task is paused/destroyed, and with
  **4403** when the user's access is revoked (suspension, removal).
- Browsers use the Access cookie (same origin); the iOS app sends its device credentials as headers.

## 6. Users, limits and spend

### `GET /api/users` (admin) → `UserList`
`{ "users": [UserDetail…] }` for every user, any status.

### `GET /api/users/:id` → `UserDetail`

### `PATCH /api/users/:id/limits` (admin, `SetLimitsRequest`) → `UserDetail`

```json
{ "openrouterMonthlyUsd": 50, "machineHoursPerMonth": null }
```

A field left out is unchanged; a number (≥ 0) sets a per-user override; `null` removes the override
(the role default applies again). A changed OpenRouter limit is pushed to the user's key at once.

**Spend rules.**

- **Model spend:** each user's OpenRouter key has a credit limit that OpenRouter itself resets at
  midnight UTC on the 1st of each month (`limit_reset: "monthly"`). The server never sees spend; the
  cap holds even if the server is down.
- **Machine hours:** the server counts each user's machine time per UTC calendar month (a run across
  the 1st is split). At the cap their live tasks are paused (`pausedReason: machine_hours_cap`), new
  tasks and resumes answer 429 `machine_hours_cap`, and the user and the admins get a notice (once
  a month).
- **Instance budget:** every minute the server sums the hourly cost of all started machines and
  integrates it over the month. At `budget.monthlyUsd` every live task is paused
  (`instance_budget`), creates/resumes answer 429 `instance_budget`, admins (and the affected
  owners) get a notice; a warning notice goes to admins at `budget.warnUsd` (default 80 %). Resets on
  the 1st.

### `GET /api/admin/budget` (admin) → `BudgetView`
`{ month, spentUsd, capUsd, warnUsd, capped, ratePerHour, lastSampleAt }`

### `GET /api/notices` → `NoticeList`
The caller's last 100 notices, newest first: `{ id, kind, text, taskId, createdAt }`, `kind` one of
`machine_hours_cap`, `instance_budget`, `task_failed`, `offboarded`.

### `POST /api/admin/directory/sync` (admin) → `SyncResult`
Runs the directory sync now (it also runs every `directory.intervalSeconds`, default 300):
`{ ok, error, added, updated, offboarded, reactivated }` (emails). A directory error or an empty
answer changes nothing (`ok: false`).

**Directory rules.** A directory user is a member when they are in a group mapped to a role
(`directory.groupRoles`; with several, the first role in `roles` order wins) or listed in
`bootstrapAdmins`. Suspended in the directory → status `suspended`; no longer a member → `removed`.
Either way, at once: their open daemon sockets close (4403), their live tasks are paused (the machine
is destroyed even if the snapshot fails), their OpenRouter key is deleted and their devices are
revoked. Their tasks, archives and personal layer are kept. A returning member is reactivated; they
pair their devices again and get a new key on their next task.

## 7. Personal layer

Stored by the server per user: `instructions` (one text), `skills` (name + files), `notes`. Changes
apply from the next session a user starts; running sessions keep what they booted with.

### `GET /api/users/:id/layer` → `PersonalLayerView`

```json
{
  "instructions": "Answer in German.",
  "skills": [{ "name": "invoices", "files": { "SKILL.md": "…", "refs/vendors.md": "…" } }],
  "notes": [{ "id": "a1…", "text": "My manager is Dana.", "createdAt": "…", "source": "session", "taskId": "7ce0…" }],
  "versions": [{ "version": 2, "createdAt": "…", "reason": "reset" }],
  "updatedAt": "…"
}
```

### `PUT /api/users/:id/layer/instructions` `{ "text": "…" }` → `PersonalLayerView`
≤ 64000 characters; `""` clears.

### `PUT /api/users/:id/layer/skills/:name` `{ "files": { "SKILL.md": "…", … } }` → `PersonalLayerView`
Creates or replaces. `name` matches `[a-z0-9][a-z0-9-]{0,63}`; files: 1..50, relative paths of
`[A-Za-z0-9._-]` segments (no `.`/`..`), text only, ≤ 256 KiB in total, must include `SKILL.md`. At
most 50 personal skills.

### `DELETE /api/users/:id/layer/skills/:name` → `PersonalLayerView` (404 if absent)

### `POST /api/users/:id/layer/notes` `{ "text": "…" }` → 201 `PersonalNote`
1..4000 characters (trimmed); at most 500 notes (409 beyond).

### `DELETE /api/users/:id/layer/notes/:noteId` → `PersonalLayerView` (404 if absent)

### `POST /api/users/:id/layer/reset` → `ResetResult`
"Reset to company default": the current layer is archived as the next numbered version (reason
`reset`) and the layer starts empty. `{ "version": 3, "layer": PersonalLayerView }`; `version` is
null when the layer was already empty (nothing archived).

### `POST /api/users/:id/layer/undo` → `PersonalLayerView`
Restores the latest version. If the layer has content (added since the Reset), that content is first
archived as a new version (reason `undo`), so nothing is lost and a second Undo swaps back. Versions
are never deleted. 409 `conflict` when there is no version.

### `GET /api/users/:id/layers` → `LayerBundle`
A preview of exactly what that user's next session loads (section 8).

## 8. Layers a session loads (`LayerBundle`)

| order | layer | from |
|---|---|---|
| 1 | org | org-env repo at the pinned commit: `AGENTS.md`, `skills/<name>/…` |
| 2 | role | `roles/<role>/AGENTS.md`, `roles/<role>/skills/<name>/…` |
| 3 | personal | the user's instructions, then their notes ("Things the user asked you to remember: …"), their skills |
| 4 | policy | `policy/AGENTS.md` (prefixed with the override preamble), `policy/skills/<name>/…`, `policy/deny.json` — loaded **last** |

- `instructions` are in load order; the session concatenates them in that order.
- **Skill names:** claimed in the order policy, org, role, personal. A skill whose name is already
  taken is renamed `<layer>-<name>` (then `-2`, `-3`…): nothing shadows a policy or org skill, and a
  role skill beats a personal one. `originalName` keeps the name as written.
- **Deny rules** (`[{ "permission": "bash", "pattern": "rm -rf *" }]`) come only from
  `policy/deny.json`; any other layer's permission settings are ignored. The session image turns them
  into OpenCode `deny` rules on top of its `allow` default.

## 9. Session-facing routes

Called by the session machine with the gate service token (`CF-Access-Client-Id` /
`CF-Access-Client-Secret` = `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` from its env) **and**
`Authorization: Bearer $JARVIS_SESSION_TOKEN`. A session token only ever reaches its own task and its
owner's personal layer; it can do nothing else.

| route | does |
|---|---|
| `GET /api/session/bundle` → `LayerBundle` | the assembled layers for the task's owner and role |
| `GET /api/session/org-env.tar` → `application/x-tar` | the org-env tree at the pinned commit (the "bundle"; no Git credential in the machine) |
| `POST /api/session/notes` `{ "text" }` → 201 `PersonalNote` | "remember …": a note in the owner's personal layer (`source: "session"`, `taskId`) |
| `POST /api/session/status` `{ "activity": "busy" \| "idle", "title"? }` → `TaskView` | `idle` starts the auto-pause countdown (`idleMinutes`), `busy` stops it; `title` (≤ 120) renames the task |
| `WS /api/session/channel` | the reverse channel (below) |

### The reverse channel

The session's channel agent keeps one WebSocket open to `wss://<instance>/api/session/channel`
(same credentials as above). A newer connection for the same task replaces the older one (closed with
1012). The first connection moves the task from `starting` to `running`. Frames are JSON text
(`ServerToSessionFrame` / `SessionToServerFrame`):

| direction | frame | meaning |
|---|---|---|
| server → session | `{ "type": "ws-open", "id", "path", "protocols": [...], "headers": {} }` | open `ws://127.0.0.1:<daemon port><path>` with these subprotocols (the first is `paseo.bearer.<password>`); queue frames until it is open |
| both | `{ "type": "ws-msg", "id", "text" }` or `{ "type": "ws-msg", "id", "data_b64" }` | one frame of stream `id` (binary as base64) |
| both | `{ "type": "ws-close", "id", "code"?, "reason"? }` | stream `id` ended |
| session → server | `{ "type": "hello", "agent": "<version>" }`, `{ "type": "ping" }` | `ping` is answered with `{ "type": "pong" }`; send one every 30 s |

## 10. Session machine contract

What the server gives a machine (env) and expects from the session image (built next):

| env | value |
|---|---|
| `JARVIS_URL` | `publicUrl` |
| `JARVIS_TASK_ID` | the task id |
| `JARVIS_SESSION_TOKEN` | this machine's session token (only its sha256 is stored; a new one per machine) |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | the session gate service token (passes Access, identifies no user) |
| `OPENROUTER_API_KEY` | the owner's capped OpenRouter key |
| `JARVIS_MODEL` | the task's model |
| `PASEO_PASSWORD` | the daemon password (stable for the task's life) |
| `JARVIS_DAEMON_PATH` | where the channel agent opens proxied sockets |
| `JARVIS_FIRST_PROMPT` | first create only |
| `JARVIS_RESTORE_URL` | resume only: presigned GET of the snapshot (valid `presignSeconds`, default 1 h) |

Nothing else: no provider tokens, no storage credentials, no Access identity of any person.

**Snapshot command.** The image provides `/usr/local/bin/jarvis-snapshot`:

- `jarvis-snapshot start <run> <presigned PUT url>` — start, detached, a tarball of the session's
  state (workspace, Paseo daemon home, OpenCode data) uploaded with one `PUT` to the URL; print
  `started` and return at once (Fly's exec is cut off at about 60 s).
- `jarvis-snapshot status <run>` — print `running`, `ok <bytes>` or `failed <message>`.

The server polls `status` every 3 s for up to 15 minutes, then checks the object exists. On boot with
`JARVIS_RESTORE_URL` the image downloads and unpacks that tarball before starting the daemon.

Bucket layout (server credentials only):

```
snapshots/<taskId>/state.tar.gz            the pause snapshot
archives/<userId>/<taskId>/state.tar.gz    the final state, written by Destroy
archives/<userId>/<taskId>/task.json       {id, userId, title, model, createdAt, archivedAt}
```
