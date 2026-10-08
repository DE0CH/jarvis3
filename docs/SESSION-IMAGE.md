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
| `Dockerfile` | `node:22-bookworm-slim` + git, curl, python3, ripgrep, tini; `opencode-ai` and `@getpaseo/cli` (versions are build args); trims in the same layer |
| `bin/jarvis-boot` | the entrypoint (under tini, as root): restore a snapshot, then `exec` jarvis-agent |
| `lib/agent.mjs` | jarvis-agent: layers, the daemon, the reverse channel, first prompt, status, the local socket |
| `lib/assemble.mjs` | LayerBundle → instructions file, skill folders, `opencode.json` (pure, unit-tested) |
| `lib/channel.mjs` | the session side of the reverse channel (unit-tested against a stand-in server and daemon) |
| `bin/jarvis-snapshot` | the snapshot command the server execs (`start` / `status`) |
| `bin/jarvis-remember` | the agent's "remember" command |

Size: ~1.4 GB unpacked (CI prints it on every run and fails above 3 GB; Fly refuses ~8 GB). The
biggest parts are OpenCode's binary (~180 MB) and the Paseo daemon with its dependencies (~300 MB).
The trims: OpenCode's two spare platform packages (it hard-links one into `bin/`), and Paseo's
bundled Claude Agent SDK binary (~250 MB; there is no Claude here).

## Boot

1. **Restore** (`jarvis-boot`, resume only): `JARVIS_RESTORE_URL` → download the tar.gz → unpack
   into `/home/jarvis`. Once per machine (marker in `/var/lib/jarvis`). A failed restore is logged
   and the task boots without its old state (docs/OPEN.md).
2. **Layers** (jarvis-agent): `GET /api/session/bundle` and `GET /api/session/org-env.tar` with the
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
     `autoupdate: false`, the OpenRouter provider with `apiKey: {env:OPENROUTER_API_KEY}` (the key is
     never written to disk) and the model declared with tool calling (so a slug models.dev lacks
     still works), and `permission`: `allow`, or with policy deny rules
     `{"*": "allow", "<perm>": {"*": "allow", "<pattern>": "deny"}}` (OpenCode: the last matching
     rule wins). For OpenCode permissions that take no patterns (`webfetch`, `websearch`,
     `todowrite`, `question`, `doom_loop`), a deny rule denies the whole permission.
   Everything here is rebuilt on every boot, so a resumed task loads the layers as they are now
   (including notes remembered in the task before the pause).
3. **Daemon**: `paseo daemon run --home ~/.paseo` as user `jarvis` in a restart loop, listening on
   `127.0.0.1:6767` with `PASEO_PASSWORD`, relay, web UI, dictation and voice off. Its env holds only
   HOME/PATH, the Paseo settings, the password and `OPENROUTER_API_KEY` (and `OPENROUTER_BASE_URL`
   when set): **not** the session token or the gate secret, so nothing the agent runs can read them.
4. **Channel**: one WebSocket to `$JARVIS_URL/api/session/channel` (`ws-open` / `ws-msg` / `ws-close`,
   `hello`, `ping` every 30 s; reconnects with backoff 1 s → 30 s). Each `ws-open` becomes a local
   socket to `ws://127.0.0.1:6767<path>` with the server's subprotocols (the first is
   `paseo.bearer.<password>`); frames are queued until it opens.
5. **First prompt** (create only, once per task — marker `~/.jarvis/first-prompt-sent`, kept in
   the snapshot): Paseo's client SDK creates the task's main agent
   (`provider: opencode/openrouter/<model>`, cwd `~/workspace`) with `JARVIS_FIRST_PROMPT`; its id is
   kept in `~/.jarvis/main-agent`.
6. **Status**: every 3 s jarvis-agent lists the daemon's agents over one local client connection;
   `busy` while any agent is `running`/`initializing` (or the first prompt is still being sent),
   else `idle`. A change (or a reconnect) → `POST /api/session/status`, with the main agent's title
   when it changed.

## Remember

`jarvis-remember "<note>"` (what the instructions tell the agent to run when the user says
"remember …") posts to jarvis-agent's unix socket `/run/jarvis/agent.sock`, which forwards to
`POST /api/session/notes` with the session token. The note lands in the owner's personal layer
(`source: session`, the task id) and is in the layers of every later task (and of this task after a
resume).

## Snapshot

`jarvis-snapshot start <run> <url>` writes `running` to `/run/jarvis/snapshots/<run>.status`,
starts a detached job and prints `started`. The job tars `/home/jarvis` (workspace, `~/.paseo`
agents, OpenCode's data in `~/.local/share/opencode`, `~/.jarvis` markers; not `org/`, the generated
layers or caches) to a temp file and PUTs it to the presigned URL (S3 needs a length, so not
streamed), then writes `ok <bytes>` or `failed <message>`. A tar exit code 1 (a file changed while
read, the daemon is live) still counts as a good archive. `jarvis-snapshot status <run>` prints the
status line.

## Environment

The server sets everything (docs/API.md section 10). Optional, for tests and local runs only:
`OPENROUTER_BASE_URL` (an OpenAI-compatible endpoint instead of OpenRouter; the local-Docker
provider sets it from `envOverrides`), `JARVIS_STATUS_MS`, `JARVIS_DAEMON_PORT`.

## Testing

- `cd session-image && npm test`: assembly and the channel relay (node:test, no Docker).
- `integration/`: the image end to end (see `integration/README` comments in
  `integration.test.ts`): `docker build -t jarvis3-session:test session-image`, then
  `cd integration && npm ci && npm test` (needs `server/` installed too, and Docker).
