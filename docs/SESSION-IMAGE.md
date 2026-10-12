# The session image

`session-image/` builds the machine every task runs on: **OpenCode** (the agent, on OpenRouter),
driven by a **Paseo daemon**, plus **jarvis-agent**, which talks to the instance server. The server
side of the contract is docs/API.md sections 9 and 10; this page is the machine side.

Published by CI (`.github/workflows/session.yml`) as `ghcr.io/de0ch/jarvis3-session:<commit>` and
`:main`, only after the integration test passed on that exact image. An instance pins one tag in
`machines.image`.

## What is in it

| path | what |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim` + git, curl, python3, ripgrep, tini, tzdata; `opencode-ai` and `@getpaseo/cli` (versions are build args); trims in the same layer |
| `bin/jarvis-boot` | the entrypoint (under tini, as root): restore a snapshot, then `exec` jarvis-agent |
| `lib/agent.mjs` | jarvis-agent: layers, the daemon, the reverse channel, first prompt, status, the local socket |
| `lib/assemble.mjs` | LayerBundle → instructions file, skill folders, `opencode.json` (pure, unit-tested) |
| `lib/channel.mjs` | the session side of the reverse channel (unit-tested against a stand-in server and daemon) |
| `bin/jarvis-snapshot` | the snapshot command the server execs (`start` / `status`) |
| `bin/jarvis-remember` | the agent's "remember" command |
| `bin/jarvis-files` | the owner's files: `list`, `get <path>`, `save <file> [<path>]` |
| `bin/jarvis-search` | search the owner's tasks: `jarvis-search "<words>"`, `--read <task> --around <seq>` |
| `lib/transcript.mjs` | timeline entries → transcript entries, batching, one agent's sync (unit-tested) |
| `bin/jarvis-wakeup`, `bin/jarvis-post` | arm/list/cancel this task's wakeups; post to its channel (the shell twins of the plugin's tools) |
| `lib/wakeups.mjs` | wakeup requests from tool arguments, wall-clock times in the owner's zone, the inbox delivery (unit-tested) |
| `lib/opencode-plugin.mjs` | the locked-policy OpenCode plugin: guards and the `jarvis_*` tools ([ACTIONS.md](ACTIONS.md)) |
| `lib/policy.mjs` | the plugin's logic (guard matching, the agent-socket client, waiting, outcome texts; unit-tested) |
| `lib/web.mjs`, `bin/jarvis-web` | the Tier 0 web tools: what `web_search` / `web_fetch` and the `jarvis-web` command send, and how answers are written for the model |
| `lib/proxy.mjs` | the local proxy on `127.0.0.1:3128` (subuser chaining or the server relay) |

Size: ~870 MB unpacked (CI, 2026-10-08) (CI prints it on every run and fails above 3 GB; Fly refuses ~8 GB). The
biggest parts are OpenCode's binary (~180 MB) and the Paseo daemon with its dependencies (~300 MB).
The trims: OpenCode's two spare platform packages (it hard-links one into `bin/`), and Paseo's
bundled Claude Agent SDK binary (~250 MB; there is no Claude here).

## Boot

1. **Restore** (`jarvis-boot`, resume only): `JARVIS_RESTORE_URL` → download the tar.gz → unpack
   into `/home/jarvis`. Once per machine (marker in `/var/lib/jarvis`). A failed restore is logged
   and the task boots without its old state (docs/OPEN.md).
2. **Projects** (jarvis-agent, before anything else): `GET /api/session/projects` (docs/API.md
   section 17). Each repo is cloned into `~/workspace/<dir>` as user `jarvis`, only when that folder
   doesn't exist yet (a resumed task's snapshot already has it, with the agent's own changes). The
   token never goes into a URL or `.git/config`: the clone runs with the token in one env var (named
   by the repo's `tokenSecret`) and a credential helper that answers `x-access-token` + that
   variable, and the clone keeps a repo-local `credential.helper` that reads the same variable, which
   is a secret in the agent's environment, so the agent can pull and push. `GIT_CONFIG_*` from the
   machine env (a URL rewrite; tests only) is passed to the clones. The secrets (`env`) are merged
   into the daemon's env (below), never overriding a name the machine sets. The instructions get a
   "Projects" section after the platform preamble: each Project's name, its repo folders and its
   secret **names** (never values). A failed clone is logged and noted in that section, and a failed
   fetch (or a 409 for clashing secrets) is noted as missing Projects; the task starts either way.
3. **Layers** (jarvis-agent): `GET /api/session/bundle` and `GET /api/session/org-env.tar` with the
   gate service token + `Authorization: Bearer $JARVIS_SESSION_TOKEN`, retried with backoff.
   - the org-env tree → `/home/jarvis/org`, owned by root, read-only for the agent;
   - `~/.jarvis/instructions.md`: a short platform preamble (what the machine is, where things are,
     `jarvis-remember`), then every `bundle.instructions` entry **in the bundle's order** (org, role,
     personal instructions, personal notes, policy — policy last), each under a marked heading;
   - `~/.jarvis/skills/<name>/…`: one folder per `bundle.skills` entry under the name the server
     assigned; a renamed skill's `SKILL.md` front matter gets the new `name:` (OpenCode matches the
     folder name), and a `SKILL.md` without front matter gets one;
   - `~/.config/opencode/opencode.json`: `model` and `small_model` = `openrouter/$JARVIS_MODEL`,
     `instructions` = that one file, `skills.paths` = that folder, `share: disabled`,
     `autoupdate: false`, `plugin` = the root-owned policy plugin (`file:///usr/local/lib/jarvis/lib/opencode-plugin.mjs`), the OpenRouter provider with `apiKey: {env:OPENROUTER_API_KEY}` (the key is
     never written to disk) and the model declared with tool calling (so a slug models.dev lacks
     still works), and `permission`: `allow`, or with policy deny rules
     `{"*": "allow", "<perm>": {"*": "allow", "<pattern>": "deny"}}` (OpenCode: the last matching
     rule wins). For OpenCode permissions that take no patterns (`webfetch`, `websearch`,
     `todowrite`, `question`, `doom_loop`), a deny rule denies the whole permission.
   Everything here is rebuilt on every boot, so a resumed task loads the layers as they are now
   (including notes remembered in the task before the pause).
4. **Files** (jarvis-agent): `GET /api/session/files`, then each file, newest first, up to
   `JARVIS_FILES_SYNC_BYTES`, into `~/files/<path>` (owned by `jarvis`, modification time = the
   file's `updatedAt`). A fresh copy every boot; not in the snapshot; a failure is logged and the
   boot goes on.
5. **Daemon**: `paseo daemon run --home ~/.paseo` as user `jarvis` in a restart loop (a restored
   `paseo.pid` is removed first: the old machine's pid can belong to another process here), listening on
   `127.0.0.1:6767` with `PASEO_PASSWORD`, relay, web UI, dictation and voice off. Its env holds only
   HOME/PATH, the Paseo settings, the password and `OPENROUTER_API_KEY` (and `OPENROUTER_BASE_URL`
   when set, `JARVIS_PROXY_URL` with a Tier 0 proxy, and the task's Project secrets): **not** the session token or the gate secret, so nothing the agent runs can read them.
   The daemon answers `/api/health` before it accepts WebSockets (it restores its agents first
   and answers 503 meanwhile), so jarvis-agent waits until its own client gets through before it
   dials in: a task is `running` only once the app's socket can reach the daemon.
6. **Channel**: one WebSocket to `$JARVIS_URL/api/session/channel` (`ws-open` / `ws-msg` / `ws-close`,
   `hello`, `ping` every 30 s; reconnects with backoff 1 s → 30 s). Each `ws-open` becomes a local
   socket to `ws://127.0.0.1:6767<path>` with the server's subprotocols (the first is
   `paseo.bearer.<password>`); frames are queued until it opens. Each `http-req` becomes a `fetch`
  to `http://127.0.0.1:6767<path>` with the server's headers (the server has added the daemon's
  bearer); the answer goes back as `http-res`, `http-data` chunks of ≤ 256 KiB and `http-end`, and
  `http-cancel` aborts it.
7. **First prompt** (create only, once per task — marker `~/.jarvis/first-prompt-sent`, kept in
   the snapshot): the attachments (`JARVIS_ATTACHMENTS`) are copied from `~/files` (or downloaded)
   into `~/workspace/attachments/` (a clashing name gets `-2`, `-3`…), and a paragraph naming them
   is appended to the prompt. Paseo's client SDK creates the task's main agent
   (`provider: opencode/openrouter/<model>`, cwd `~/workspace`) with that text, and, when
   `JARVIS_MODEL_IMAGES=1`, with the attached images (PNG, JPEG, GIF, WebP ≤ 5 MiB, at most 5)
   inline for the first three attempts (`opencode.json` then declares the model's image input);
   later attempts leave the images out (a model without image input). Its id is kept in
   `~/.jarvis/main-agent`.
8. **Inbox** (after the first prompt): a long poll of `GET /api/session/inbox?wait=50`. New
   messages (wakeup prompts, docs/API.md section 15, and the owner's messages from the app, section 5,
   which arrive exactly as written) wait until the main agent is neither
   `running`/`initializing` nor holding a pending permission, then go to it as **one** user
   message (several queued ones joined), and are acked. Sending while the agent is mid-turn would
   interrupt it (Paseo's default), and a message must never land as the answer to something the
   agent is waiting on, so delivery only ever starts a new turn. The ids handed over are kept in
   `~/.jarvis/inbox-delivered` (in the snapshot), so a crash between delivery and ack doesn't
   deliver twice. With no main agent (archived, or the first prompt never made one) the message
   starts a new main agent. The server doesn't idle-pause a task while it has an unacked message.
9. **Status**: every 3 s jarvis-agent lists the daemon's agents over one local client connection;
   `busy` while any agent is `running`/`initializing` (or the first prompt is still being sent),
   else `idle`. A change (or a reconnect) → `POST /api/session/status`, with the main agent's id
   (on a reconnect, and when it first exists) and its title when it changed.

## Transcript sync

jarvis-agent sends its agents' timelines to `POST /api/session/transcript` (docs/API.md section 14):
when the agents go idle, every 30 s (`JARVIS_TRANSCRIPT_MS`) while they work, and on
`POST /transcript-sync` on its socket, which `jarvis-snapshot` calls (≤ 25 s) before it packs. Per
agent it probes the tail of the timeline; when the last entry changed it reads from just before the
last entry the server holds ("after" that cursor, projected, 200 per page) and posts in batches
(≤ 200 entries, ≤ 600 kB). A new timeline epoch sends everything again. A failure is logged and
retried at the next run.

## Files and search from the shell

`jarvis-files` and `jarvis-search` (run by the agent as `jarvis`) talk to jarvis-agent's socket, like
`jarvis-remember`:

| socket route | does |
|---|---|
| `GET /files` | `GET /api/session/files`, each marked `local` when `~/files/<path>` has it |
| `POST /files/get` `{path}` | downloads it into `~/files/<path>` |
| `PUT /files/<path>` | streams the body to `PUT /api/session/files/<path>`; `jarvis-files save` reads the file as `jarvis`, so it can only save what the agent's user can read |
| `GET /search?q=…` | `GET /api/session/search` |
| `GET /tasks/:id/transcript?…` | `GET /api/session/tasks/:id/transcript` |
| `POST /transcript-sync` | sync the transcripts now (`jarvis-snapshot`) |

## Remember

`jarvis-remember "<note>"` (what the instructions tell the agent to run when the user says
"remember …") posts to jarvis-agent's unix socket `/run/jarvis/agent.sock`, which forwards to
`POST /api/session/notes` with the session token. The note lands in the owner's personal layer
(`source: session`, the task id) and is in the layers of every later task (and of this task after a
resume).

## Wakeups and channel posts

The plugin's `jarvis_wakeup` / `jarvis_wakeups` / `jarvis_post` tools and the `jarvis-wakeup` /
`jarvis-post` commands go through jarvis-agent's socket like the rest:

| socket route | forwards to |
|---|---|
| `GET /wakeups`, `POST /wakeups` | `GET` / `POST /api/session/wakeups` |
| `DELETE /wakeups/:name` | `DELETE /api/session/wakeups/:name` |
| `POST /posts` | `POST /api/session/posts` |

Times without an offset (`2026-10-12T09:00`, `09:00` = the next one, a bare date = 09:00) are wall
clock in `JARVIS_TIME_ZONE`, the owner's zone as their app last reported it; the daemon's env also
has it as `TZ`, so `date` in the agent's shell is local time. The preamble tells the agent to arm a
wakeup and end its turn rather than wait, and to post results worth keeping.

## Approvals

The policy plugin runs inside OpenCode (user `jarvis`) and reaches the server only through
jarvis-agent's socket, which adds the session token:

| socket route | forwards to |
|---|---|
| `GET /guards` | the bundle's `guards` (kept in memory from boot) |
| `GET /actions` | `GET /api/session/actions` |
| `POST /approvals` | `POST /api/session/approvals` |
| `GET /approvals/:id?wait=<s>` | `GET /api/session/approvals/:id?wait=<s>` (≤ 55 s) |

`tool.execute.before` matches every tool call against the guards; a match files a `guard` request
and blocks the call until it is settled: approved runs it, anything else throws, so the tool fails
with the reason. The four tools file `action`, `access` and `question` requests the same way. The
waits have no time limit (people take their time); stopping the agent aborts them, and a paused
task cancels its pending requests on the server. `@opencode-ai/plugin` (for its `tool` helper and
zod) is pinned to the image's OpenCode version.

## Web tools and the proxy

Tier 0 ([TOOLS.md](TOOLS.md)). At boot jarvis-agent reads `GET /api/session/tools`; when the
instance has a tool, the preamble gets a paragraph on it and `~/.jarvis/skills/jarvis-web/` the
built-in skill. The socket forwards `GET /tools`, `POST /tools/search` and `POST /tools/fetch` to the
server's metered routes (100 s timeout: a rendered fetch is slow, and Cloudflare cuts a proxied
request at 100 s). With a proxy, jarvis-agent listens on `127.0.0.1:3128` and the daemon's env gets
`JARVIS_PROXY_URL`; the proxy's upstream login (`JARVIS_PROXY`, subuser providers) stays in
jarvis-agent's own environment.

## Snapshot

`jarvis-snapshot start <run> <url>` writes `running` to `/run/jarvis/snapshots/<run>.status`,
starts a detached job and prints `started`. The job first asks jarvis-agent to sync the transcripts
(above), then tars `/home/jarvis` (workspace with its `attachments/`, `~/.paseo` agents, OpenCode's
data in `~/.local/share/opencode`, `~/.jarvis` markers; not `org/`, `files/`, the generated layers or
caches) to a temp file and PUTs it to the presigned URL (S3 needs a length, so not
streamed), then writes `ok <bytes>` or `failed <message>`. A tar exit code 1 (a file changed while
read, the daemon is live) still counts as a good archive. `jarvis-snapshot status <run>` prints the
status line.

## Environment

The server sets everything (docs/API.md section 10). Optional, for tests and local runs only:
`OPENROUTER_BASE_URL` (an OpenAI-compatible endpoint instead of OpenRouter; the local-Docker
provider sets it from `envOverrides`), `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
(passed to Project clones), `JARVIS_STATUS_MS`, `JARVIS_TRANSCRIPT_MS`, `JARVIS_DAEMON_PORT`.
The wakeup/post commands honour `JARVIS_AGENT_SOCKET` and `JARVIS_LIB` (their tests point them at a
stand-in).

## Testing

- `cd session-image && npm test`: assembly, Project clones (a local repo, the credential helper), the channel relay, the policy plugin, the web tools and
  the wakeup/post commands and inbox delivery against a stand-in agent socket, and the local proxy
  (node:test, no Docker).
- `integration/`: the image end to end (the header of `integration.test.ts` lists the checks):
  `docker build -t jarvis3-session:test session-image`, then `cd server && npm ci`, then
  `cd integration && npm ci && npm test` (needs Docker; `SESSION_IMAGE` picks another tag).
- `integration/fly-e2e.sh`: the same chain on real Fly Machines and a real model, run by hand
  ([FLY-E2E.md](FLY-E2E.md)).
