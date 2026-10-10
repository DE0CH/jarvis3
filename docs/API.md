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
| 403 `forbidden` | valid JWT but: unknown email, suspended or removed user, unknown device, a session credential on a non-session route, a foreign `Origin` |
| 403 `device_revoked` | a paired device whose token was revoked (`DELETE /api/devices/:id`) while its user is still active: the app forgets the token and pairs again |
| 404 `not_found` | the resource does not exist **or belongs to someone else**, or an admin-only route called by a non-admin. The body is identical in all these cases, so a 404 never reveals that something exists |
| 400 `bad_request` | malformed body or parameters |
| 409 `busy` | another lifecycle operation is running on the task |
| 409 `conflict` | the task's state does not allow this, or nothing to undo |
| 429 `machine_hours_cap`, `instance_budget`, `tools_cap`, `too_many_requests` | caps (sections 6 and 12), pairing rate limit |
| 502 `upstream` | Fly, OpenRouter, Cloudflare, Google, S3 or a Tier 0 provider failed |
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
| GET | `/api/tasks/:id/archive` | O, A |
| POST | `/api/tasks/:id/pause` | O, A |
| POST | `/api/tasks/:id/resume` | O, A |
| DELETE | `/api/tasks/:id` | O, A |
| WS | `/api/tasks/:id/daemon` | O, A |
| any¹ | `/api/tasks/:id/daemon/http/*` | O, A |
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
| POST | `/api/users/:id/layer/suggest` | O, A |
| GET | `/api/suggestions` | M (own); `?userId=U`: O of U, A; `?all=1`: A |
| GET | `/api/notices` | M (own notices) |
| POST | `/api/notices/read` | M (own notices) |
| GET | `/api/approvals` | M (requests of own tasks); A: everyone's |
| GET | `/api/approvals/:id` | O (the task's owner), A |
| POST | `/api/approvals/:id/decide` | whoever the request's `approver` names (section 11) |
| POST | `/api/approvals/:id/passkey/options`, `/api/approvals/:id/passkey` | the instance owner |
| GET | `/api/passkeys`, DELETE `/api/passkeys/:id` | the instance owner |
| POST | `/api/passkeys/register/options`, `/api/passkeys/register` | the instance owner, identity login only |
| GET | `/api/pages/passkeys`, `/api/pages/approvals/:id` | the instance owner |
| GET | `/api/admin/budget` | A |
| POST | `/api/admin/directory/sync` | A |
| GET | `/api/admin/tools` | A |
| GET | `/api/session/bundle` | S |
| GET | `/api/session/org-env.tar` | S |
| POST | `/api/session/notes` | S |
| POST | `/api/session/status` | S |
| GET | `/api/session/actions` | S |
| POST | `/api/session/approvals` | S |
| GET | `/api/session/approvals/:id` | S (its own task's requests) |
| WS | `/api/session/channel` | S |
| GET | `/api/session/tools` | S |
| POST | `/api/session/tools/search`, `/api/session/tools/fetch` | S (spends its own task owner's allowance) |
| WS | `/api/session/proxy` | S (likewise) |

¹ `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`.

`server/test/authz.test.ts` checks this whole table for ten kinds of caller, except the owner-only
passkey routes, which `server/test/approvals.test.ts` covers (anyone but the owner gets 404).

## 3. Identity and devices

### `GET /api/health` → `Health`
`{ "ok": true, "version": "0.1.0" }`

### `GET /api/me` → `MeView`

A `UserDetail` plus `unreadNotices`, the number of the caller's notices not yet marked read
(section 6), and `features` (`InstanceFeatures`): `{ "suggestions": true }` when "Suggest for
everyone" is set up (section 7a).

```json
{
  "user": { "id": "1bb0e5661a4b5508", "email": "alice@example.org", "name": "Alice", "role": "staff",
            "status": "active", "isAdmin": false, "createdAt": "2026-10-08T12:00:00.000Z" },
  "limits": { "openrouterMonthlyUsd": 20, "openrouterOverride": false, "machineHoursPerMonth": 10, "machineHoursOverride": false },
  "usage": { "month": "2026-10", "machineHours": 1.5, "machineHoursCapReached": false, "openrouterKey": true },
  "unreadNotices": 0,
  "features": { "suggestions": true }
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
  "createdAt": "…", "updatedAt": "…", "connected": true, "agentId": "a3f1…"
}
```

- `connected`: the session's reverse channel is up, so the daemon proxy can be opened.
- `error`: why the last operation failed (e.g. `pause failed, the task keeps running: …`), or null.
- `pausedReason`: `user`, `idle`, `machine_hours_cap`, `instance_budget` or `offboarded` while paused.
- `agentId`: the Paseo agent on the task's daemon that is the task itself (the one the first prompt
  went to), as the session reports it; null until then. It stays the same across pause and resume,
  because a resumed daemon keeps its agents. The app opens this agent's chat.

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
`?force=1`, which destroys anyway (`error` then says so). A pause snapshot is deleted only once it,
or a newer state, is in the archive.

### `GET /api/tasks/:id/archive` → 302
For an `archived` task whose state is in the bucket: a redirect to a presigned GET of
`archives/<userId>/<taskId>/state.tar.gz`, valid 10 minutes. 409 `conflict` when the task isn't
archived or was destroyed without an archive. This is how an admin reads an offboarded person's
sessions. With `?link=1` the answer is 200 `ArchiveLink` `{ url, expiresAt }` instead of the
redirect (the iOS app sends its device headers, which a browser opening the redirect would not).

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

### `/api/tasks/:id/daemon/http/<path>` — HTTP to the daemon

The same relay for the daemon's HTTP routes, mainly file downloads (`GET
/api/tasks/:id/daemon/http/api/files/download?token=…`). Same checks as the WebSocket (404 for
someone else's task, 503 while the session is not connected, the `Origin` guard on anything but
`GET`/`HEAD`). `<path>` and the query go to the daemon unchanged.

- Towards the daemon: only `content-type`, `accept`, `range`, `if-none-match`, `if-modified-since`
  and `if-range` are passed, plus `authorization: Bearer <daemon password>` added by the server.
  Cookies and the client's own `authorization` never reach the daemon. Request bodies ≤ 1 MiB.
- Back to the app: only `content-type`, `content-length`, `content-disposition`, `content-range`,
  `accept-ranges`, `etag` and `last-modified`. Every answer is forced to be a download:
  `content-disposition: attachment` (an `inline` one is turned into `attachment`),
  `content-security-policy: sandbox; default-src 'none'`, `x-content-type-options: nosniff`,
  `cache-control: no-store`. What a daemon serves is the agent's output; on the instance's origin
  it must never run as a page with the user's Access cookie.
- No answer from the session within 60 s, or the session disconnecting before the answer started:
  502 `upstream`. A cut-off after the answer started ends the response early. When the app goes
  away, the session is told to abort the request (`http-cancel`). Revoking the user ends their
  requests too.

## 6. Users, limits and spend

### `GET /api/users` (admin) → `UserList`
`{ "users": [UserDetail…] }` for every user, any status.

### `GET /api/users/:id` → `UserDetail`

### `PATCH /api/users/:id/limits` (admin, `SetLimitsRequest`) → `UserDetail`

```json
{ "openrouterMonthlyUsd": 50, "machineHoursPerMonth": null, "toolsMonthlyUsd": 10, "proxyMonthlyGb": 2 }
```

A field left out is unchanged; a number (≥ 0) sets a per-user override; `null` removes the override
(the role default applies again). A changed OpenRouter limit is pushed to the user's key at once, a
changed proxy cap to the user's proxy sub-account (section 12).

**Spend rules.**

- **Model spend:** each user's OpenRouter key has a credit limit that OpenRouter itself resets at
  midnight UTC on the 1st of each month (`limit_reset: "monthly"`). The server never sees spend; the
  cap holds even if the server is down.
- **Machine hours:** the server counts each user's machine time per UTC calendar month (a run across
  the 1st is split). At the cap their live tasks are paused (`pausedReason: machine_hours_cap`), new
  tasks and resumes answer 429 `machine_hours_cap`, and the user and the admins get a notice (once
  per month and cap value: an admin who raises the cap is told again if the new one is reached).
  The cap is the role's `machineHoursPerMonth` or the admin's per-user override; an override
  below what the user already used pauses their tasks as the `PATCH` returns. Raising it doesn't
  restart anything: the user presses Start.
- **Instance budget:** every minute the server sums the hourly cost of all started machines and
  integrates it over the month. At `budget.monthlyUsd` every live task is paused
  (`instance_budget`), creates/resumes answer 429 `instance_budget`, admins (and the affected
  owners) get a notice; a warning notice goes to admins at `budget.warnUsd` (default 80 %). Resets on
  the 1st.

- **Web tools and proxy traffic:** section 12.

### `GET /api/admin/budget` (admin) → `BudgetView`
`{ month, spentUsd, capUsd, warnUsd, capped, ratePerHour, lastSampleAt }`

### `GET /api/notices` → `NoticeList`
The caller's last 100 notices, newest first: `{ id, kind, text, taskId, createdAt, read }`, `kind`
one of `machine_hours_cap`, `tools_cap`, `instance_budget`, `task_failed`, `offboarded`, `suggestion`.

### `POST /api/notices/read` (`MarkNoticesReadRequest`) → `MarkNoticesReadResult`
`{}` marks all the caller's notices read; `{ "upTo": "<notice id>" }` marks that notice and every
older one. Answers `{ "unreadNotices": n }`. A notice id that isn't the caller's is a 404.

### `POST /api/admin/directory/sync` (admin) → `SyncResult`
Runs the directory sync now (it also runs every `directory.intervalSeconds`, default 300):
`{ ok, error, added, updated, offboarded, reactivated }` (emails). A directory error or an empty
answer changes nothing (`ok: false`).

**Directory rules.** A directory user is a member when they are in a group mapped to a role
(`directory.groupRoles`; with several, the first role in `roles` order wins) or listed in
`bootstrapAdmins`. Suspended in the directory → status `suspended`; no longer a member → `removed`.
The static directory (`directory.users`) works the same way: `suspended: true` on an entry, or the
entry gone from the list, offboards that person at the next sync (the server reads its config at
start).

**Offboarding**, at once:

1. their open daemon sockets close (4403) and every route answers them 403;
2. their OpenRouter key is deleted and their devices' Access service tokens are revoked at
   Cloudflare (Access refuses those tokens from then on);
3. their personal layer, with every Reset/Undo version, is copied to
   `archives/<userId>/personal-layer.json` (plus `archives/<userId>/user.json`);
4. every task of theirs that isn't archived is archived and its machine destroyed, as `DELETE
   /api/tasks/:id` does (`task.json` gets `reason: "offboarded"`). A running machine always goes: if
   its final state can't be captured, the last pause snapshot is archived instead, or, with none, it
   is destroyed without an archive and `error` says so. A task without a machine whose archive fails
   stays as it is and is retried every minute, as are a key, device or layer copy that failed, and
   a task that was mid-operation.

Admins get an `offboarded` notice. The person's user record, personal layer (`GET
/api/users/:id/layer`), tasks (`GET /api/tasks?userId=…`) and archives (`GET
/api/tasks/:id/archive`) stay for the organisation and are visible to admins. A returning member is
reactivated; they pair their devices again, get a new key on their next task, and start with their
kept personal layer; their old tasks stay archived.

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

### `POST /api/users/:id/layer/suggest` (`SuggestRequest`) → 201 `SuggestionView`
"Suggest for everyone" (section 7a).

### `GET /api/users/:id/layers` → `LayerBundle`
A preview of exactly what that user's next session loads (section 8).

## 7a. Suggest for everyone

Part of a personal layer becomes a pull request on the organisation's org-env repo, for an admin to
review there. The server opens it with its own credential (CONFIG.md `suggestions`); no user or
session ever holds a GitHub credential.

`POST /api/users/:id/layer/suggest`, owner or admin (an admin suggests on the owner's behalf):

| body | the pull request |
|---|---|
| `{ "kind": "skill", "name": "invoices" }` | `skills/invoices/` becomes exactly the personal skill's files (files it lacks are deleted) |
| `{ "kind": "instructions" }` | the personal instructions, appended to `AGENTS.md` |
| `{ "kind": "note", "noteId": "…" }` | the note, appended to `AGENTS.md` as a bullet |

Optional `message` (≤ 4000) is quoted in the pull request's description, which also names whose
layer it came from. Branch `jarvis/suggest-<kind>-<name>-<id>` off `suggestions.baseBranch`.

- 404 for a skill or note that isn't in the layer; 409 `conflict` when the feature isn't set up,
  the instructions are empty, the same thing is already suggested and still open (the message has
  the link), 20 suggestions of the person are open, or the org-env repo already has exactly this;
  502 `upstream` when GitHub fails (nothing is recorded).
- Admins get a `suggestion` notice with the link.

### `GET /api/suggestions` → `SuggestionList`
Newest first: the caller's own; `?userId=U` (that user or an admin); `?all=1` (admin). Each
`SuggestionView` has `number`, `url` and `state` (`open`, `merged`, `closed`). Open pull requests
are re-read from GitHub when the listing comes more than 60 s after the last check, and by the
background loop every 5 minutes; the owner gets a `suggestion` notice when theirs is merged or
closed. A merge reaches sessions once the instance's `orgEnv.commit` is moved past it (a deploy).

## 8. Layers a session loads (`LayerBundle`)

| order | layer | from |
|---|---|---|
| 1 | org | org-env repo at the pinned commit: `AGENTS.md`, `skills/<name>/…` |
| 2 | role | `roles/<role>/AGENTS.md`, `roles/<role>/skills/<name>/…` |
| 3 | personal | the user's instructions, then their notes ("Things the user asked you to remember: …"), their skills |
| 4 | policy | `policy/AGENTS.md` (prefixed with the override preamble), `policy/skills/<name>/…`, `policy/deny.json`, `policy/guards.json` — loaded **last** |

- `instructions` are in load order; the session concatenates them in that order.
- **Skill names:** claimed in the order policy, org, role, personal. A skill whose name is already
  taken is renamed `<layer>-<name>` (then `-2`, `-3`…): nothing shadows a policy or org skill, and a
  role skill beats a personal one. `originalName` keeps the name as written.
- **Deny rules** (`[{ "permission": "bash", "pattern": "rm -rf *" }]`) come only from
  `policy/deny.json`; any other layer's permission settings are ignored. The session image turns them
  into OpenCode `deny` rules on top of its `allow` default.
- **Guards** (`guards`) come only from `policy/guards.json`: tool calls that stop for an approval
  before they run (section 11, [ACTIONS.md](ACTIONS.md)).

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
| `GET /api/session/actions` → `ActionCatalogue` | the broker's actions as this task sees them (section 11) |
| `POST /api/session/approvals` (`SessionApprovalRequest`) → 201 `ApprovalView` | file a request (section 11) |
| `GET /api/session/approvals/:id?wait=<s>` → `ApprovalView` | a request of this task; with `wait` (≤ 55 s) a long poll that answers as soon as it is settled |
| `POST /api/session/status` `{ "activity": "busy" \| "idle", "title"?, "agentId"? }` → `TaskView` | `idle` starts the auto-pause countdown (`idleMinutes`), `busy` stops it; `title` (≤ 120) renames the task; `agentId` (`[A-Za-z0-9._:-]{1,128}`) records the task's main agent |
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
| server → session | `{ "type": "http-req", "id", "method", "path", "headers": {}, "body_b64"? }` | make this HTTP request to `http://127.0.0.1:<daemon port><path>` with exactly these headers |
| session → server | `{ "type": "http-res", "id", "status", "headers": {} }`, then `{ "type": "http-data", "id", "data_b64" }`…, then `{ "type": "http-end", "id", "error"? }` | the daemon's answer, body in chunks of ≤ 256 KiB; `error` when the request failed |
| server → session | `{ "type": "http-cancel", "id" }` | the app went away: abort request `id` |
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
| `JARVIS_PROXY` | only with a `subuser` proxy provider and a proxy cap above 0: JSON `{host, port, username, password, targeting}` of the owner's own capped sub-account (section 12); jarvis-agent keeps it out of the agent's environment |

Nothing else: no organisation provider tokens, no storage credentials, no Access identity of any person.

The local-Docker provider (CI and local runs only) can set or replace env values per machine
(`machines.envOverrides`): `JARVIS_URL` as the containers reach the server, and
`OPENROUTER_BASE_URL`, which the image honours as an OpenAI-compatible endpoint in place of
OpenRouter (the integration test's stub). A production machine never gets it.

The image's side (boot sequence, layout, what is kept in a snapshot) is in
[`SESSION-IMAGE.md`](SESSION-IMAGE.md).

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

## 11. Actions and approvals

DESIGN "Secrets and capabilities" and "Actions and approvals"; how an operator configures them:
[ACTIONS.md](ACTIONS.md). Types: `ActionView`, `ApprovalView`, `SessionApprovalRequest`,
`DecideRequest`, `PasskeyView` in `server/src/api-types.ts`.

A session files a **request**; the server decides who must answer it, puts it in the one queue,
gives the approver(s) an in-app notice (`approval_needed`), and the session long-polls until it is
settled. Kinds:

| kind | what the session sends | who decides (`approver`) |
|---|---|---|
| `action` | `{action, params, reason?}`: run a named broker action | `auto` when the action's policy allows it (allow-list, threshold), else the action's `approval` (`self` / `admin`); a Tier 3 action: `owner` |
| `guard` | `{rule, tool, input, reason?}`: a tool call matched a locked-policy guard | the rule's `approval` (`self` / `admin`); the session can't choose it |
| `access` | `{action, reason}`: the task's role lacks an action | `admin`; approve with `grantScope: "task"` or `"role"` (never for a Tier 3 action) |
| `question` | `{question, options?}`: "ask the boss" | `admin`; approve with the answer in `note` |

`self` = the task's owner (one tap, for their own accounts); `admin` = any admin, including from
their own task; `owner` = the instance owner (config `owner`) with a passkey.

States: `pending` → `approved` → (actions) `executing` → `done` | `failed`; or `denied`; or
`cancelled` when the task is paused or destroyed before a decision. An approved action runs on the
server with credentials the session never sees; its `result` (or `error`) goes back to the agent.
`preview` is exactly what will happen (summary, fields, the full body). A decision tells the task's
owner with an `approval_decided` notice when someone else made it. `MeView.pendingApprovals` counts
what the caller can decide now.

Errors a session meets: 400 for a bad action name or parameters (the message says what to fix),
403 `capability_missing` when the role lacks the action (file an `access` request), 409 for an
access request the task already has.

### `GET /api/approvals[?pending=1][&taskId=…]` → `ApprovalList`
Newest first. Staff see their own tasks' requests, an admin everyone's; `pending=1` keeps only what
the caller can decide now.

### `GET /api/approvals/:id` → `ApprovalView`
`canDecide` and `decideWith` (`tap` or `passkey`) say what the caller can do.

### `POST /api/approvals/:id/decide` (`DecideRequest`) → `ApprovalView`
`{decision: "approve" | "deny", note?, grantScope?}`. 403 when the caller isn't the approver, 409
once decided. A Tier 3 request is denied with a tap but approved only with a passkey (400 here).

### Tier 3: passkeys

The owner registers a passkey per device (WebAuthn, user verification required: Face ID, Touch ID
or the device PIN; RP ID = the `publicUrl` host), only on an identity login, so a paired device's
token can't add one. A Tier 3 request carries `changeHash` = sha256 of the canonical JSON of
`{v, instance, approval, action, type, params, summary}`; the WebAuthn challenge is
`sha256("jarvis3-tier3\n" + changeHash + "\n" + nonce)`, so the signature covers exactly the change
shown. The server recomputes the hash from the stored request before signing and keeps the assertion
as the approval's proof.

| route | does |
|---|---|
| `GET /api/passkeys` → `PasskeyList` | the owner's passkeys |
| `POST /api/passkeys/register/options` → WebAuthn creation options | start adding one (challenge valid 5 min) |
| `POST /api/passkeys/register` `{response, name?}` → 201 `PasskeyView` | finish; the owner gets a `passkey_added` notice |
| `DELETE /api/passkeys/:id` | remove one |
| `POST /api/approvals/:id/passkey/options` → `PasskeyApprovalOptions` | the request options, the change and its hash |
| `POST /api/approvals/:id/passkey` `{response}` → `ApprovalView` | the signed approval; the challenge is single-use |

The app doesn't call WebAuthn itself: it opens two small server pages on the instance's origin
(the web app navigates to them, the iOS app opens them in the system sign-in sheet as pairing does):

- `GET /api/pages/passkeys?return=<url>`: add a passkey on this device;
- `GET /api/pages/approvals/:id?return=<url>`: the change, its fingerprint, Approve with Face ID or Deny.

`return` must be a path on the instance or the app's scheme (`devices.appScheme`); anything else is
dropped. The pages send `frame-ancestors 'none'` and a script-only-inline CSP.

## 12. Tier 0 tools

Web search, page fetching and proxies, metered or capped per user ([TOOLS.md](TOOLS.md)).

`UserDetail.tools` (`UserToolsView`, absent when the instance has no Tier 0 tool):
`{ month, web: {capUsd, override, spentUsd, calls, capReached} | null, proxy: {mode, capGb, override, usedGb, capReached} | null }`.
`MeView.features.tools` says which tools are on.

### `GET /api/admin/tools` (admin) → `ToolsAdminView`
The configured providers and this month's totals: `{ month, search, fetch, proxy, web: {spentUsd, calls, capUsd, capReached}, proxyUsedGb }`.

### Session routes (session token)

| route | does |
|---|---|
| `GET /api/session/tools` → `SessionToolsView` | which tools the task has, the owner's allowance and use |
| `POST /api/session/tools/search` (`WebSearchRequest`) → `WebSearchResponse` | `{query, numResults? 1..20, textChars? 0..20000, since? YYYY-MM-DD, includeDomains?, country?}` |
| `POST /api/session/tools/fetch` (`WebFetchRequest`) → `WebFetchResponse` | `{url, render?, premium?, country?, format? html\|text}`; the body is cut at 2 MiB (`truncated`) |
| `WS /api/session/proxy?host&port[&country][&session]` | one proxy tunnel (relay providers): first a text frame `{"ok":true}` (or `{"ok":false,status,error}` and a close), then binary both ways; closed with 4029 at the GB cap |

Errors: 429 `tools_cap` (the owner's or the instance's monthly cap; nothing was sent to the
provider), 409 `conflict` (the tool isn't set up), 502 `upstream` (the provider failed; not charged),
400 for a malformed request (before any spend). The first refusal per month and cap leaves a
`tools_cap` notice for the user and the admins.

