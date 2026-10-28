# Claude Code in the sandbox (design agreed with Deyao 2026-10-21; live on YYC AI (ai.yyc-internal.com) since 2026-10-21)

How YYC AI works: each conversation's agent is **Claude Code running inside that conversation's sandbox**, and the
staff UI is a fork of CloudCLI. Claude is trained on Claude Code running on one computer, with file tools and bash on
the same machine, CLAUDE.md and MCP config read from disk; this design gives it exactly that, inside the sandbox. It
replaced (2026-10-21) the first design, an agent loop on the server (claw per turn, bash relayed into the sandbox,
files synced back) with its own web UI; that code is gone (jarvis3 07e2e49), its tables keep their rows (docs/CHAT.md
"Postgres schema"). The runtime's parts (web, egress, tools, the sandbox agent, providers, config): docs/CHAT.md.

## Parts

1. **UI: a fork of CloudCLI** (siteboon/claudecodeui → DE0CH/claudecodeui, AGPL-3.0), running on the cluster,
   stateless (2 replicas, rolling deploys). Patched at its provider seam (`server/shared/interfaces.ts`,
   `server/modules/providers/README.md`), not at the filesystem:
   - one new provider whose `runtime` runs `claude` in the user's sandbox through the Agent SDK's
     `spawnClaudeCodeProcess` (stdin/stdout relayed) and records every streamed message in Postgres; `sessions`
     (list, history, search) read from Postgres; `sessionSynchronizer` none; `models` fixed (Sonnet 5.5); `auth`
     always signed in (egress holds the key); `mcp` fixed (our tools role); `skills` none.
   - the four file-reading providers (claude, codex, cursor, opencode) and the developer modules that need a local
     machine (git, shell, file tree, plugins, taskmaster, worktrees, browser-use, cli) are removed.
   - CloudCLI's SQLite tables move to our Postgres (Neon), same schema.
   - sign-in: Cloudflare Access (Google, the staff allowlist) in place of CloudCLI's own login.
2. **Agent: Claude Code inside the sandbox**, `cwd=/workspace`, a plain folder (no git: Claude Code works as well
   in a folder without version control). `CLAUDE.md`: the YYC instructions, a paragraph on sandbox release (only
   `/workspace` and the conversation carry over; installs, processes and everything else are gone), and: bulk file
   work (unpacking archives, installs, thousands of small files) goes in `/tmp`, only results in `/workspace` (each
   file write there is a network round trip, ~25 ms). The quota on `/workspace` is 1 GiB and 1,000 files (JuiceFS
   `quota set --capacity 1 --inodes 1000`); past it writes fail with `Disk quota exceeded` (EDQUOT, errno 122; the
   text is the OS's own), and `CLAUDE.md` says what that means: put caches, installs and bulk files (`.npm`,
   `node_modules`, virtualenvs, unpacked archives) in `/tmp` or the home folder, keep only results in
   `/workspace`. Usage is refreshed every few seconds, so a fast burst overshoots slightly (measured: 1,007 files
   before the cap held). MCP: our tools role.
   The staff member's message reaches Claude Code exactly as typed (plus the attachment blocks the UI strips back out
   of the history): nothing is prepended after a sandbox release, since the managed `CLAUDE.md` already says what
   survives one. Cleanup for messages saved before 2026-10-22: until then the UI put `[System note: your sandbox was
   reset since the last message: …]` in front of the first message after a release, and those transcripts still hold
   it; the fork strips that exact prefix when it serves history, titles and search (`server/modules/jarvis/jarvis-history.ts`).
   Model calls: `ANTHROPIC_BASE_URL` = egress `/x/claude` → OpenRouter with zero data retention, under the shared
   budget, with a short-lived token; the sandbox holds no real key. Licence: Claude Code's commercial terms,
   accepted by Deyao as a one-time exception for this instance.
3. **Storage in the sandbox**

   | What | Paths | Lifetime | Where | On migration |
   |---|---|---|---|---|
   | base system | image (`/usr`, `/opt/py`, `/etc` as shipped) | per image | read-only image on the host disk, shared | nothing (same image on every host) |
   | persistent work | `/workspace` (quota: 1 GiB and 1,000 files, a plain folder), `~/.claude` | the conversation | JuiceFS (metadata: Neon Postgres; data: the Hetzner bucket), mounted by the host and bind-mounted in | nothing (destination mounts the same volume) |
   | installs and scratch | apt, pip, npm -g, `/tmp`, `~/.cache`, Docker's dir | the sandbox | host disk: Linux overlayfs (image as lowerdir, `/sbx/<id>/upper` as upperdir) + host dirs for `/tmp` and Docker, capped at 5 GiB (writes past it fail with ENOSPC) | file-level pre-copy: rsync rounds while it runs, the final delta while it is stopped, before the restore (docs/SANDBOX-VM.md "Scratch on migration") |
   | memory | processes | the sandbox | RAM | pre-copied by the gVisor fork |

   Writes past a quota fail with an error the agent sees; nothing destroys or crashes. JuiceFS counts written data
   against the quota when it commits it, so the write that crosses 1 GiB is cut short at the quota and the error comes
   on `close`/`fsync`. gVisor's gofer (directfs) passes a FUSE file's close error to the application since the fork's
   release `precopy-20261021.2` (`close` flushes a duplicate of the host file descriptor and returns its error, as on
   Linux; patch also in `chat/sandboxd/gvisor-patches/`): Python's `f.close()` and Node's `fs.writeFile` get EDQUOT
   ("Disk quota exceeded"), as `head`/`dd` do (verified 2026-10-21 in a real conversation's sandbox). The managed
   CLAUDE.md (`SANDBOX_RULES`, `chat/src/web/claude-code.ts`) still tells the model to check a large file's size after
   writing it; that rule is no longer needed, and only Deyao changes the prompt.
   runsc runs with `--overlay2=none` so scratch writes land as plain host files (today's `--overlay2=root:self` keeps
   the upper layer in gVisor's memory image, which is what OOM-killed a large sandbox on restore after a move).
4. **Sandbox lifecycle:** release = unmount and drop the sandbox; nothing to save (every `/workspace` and
   `~/.claude` write is already in storage). Scaler, placement, release rules, Rust sandboxd, egress allowlist,
   tools role, budget and Access stay as they are.

## Measurements

- **JuiceFS** (metadata on Neon from an m7i.large in eu-central-1: 2–5 ms per query; data in the Hetzner bucket;
  `--writeback`), 2026-10-21: creating 2,000 small files 58 s (local disk 1.8 s), about 25 ms per file create;
  `git add` of them 31 s (0.02 s); a warm `git status` 0.7 s. Caching helps reads, not metadata writes. Fine for
  the few files a turn writes; bulk work goes in `/tmp`. (Git was dropped from the design, so the git numbers are
  only for reference.)
- Migration with the scratch (2026-10-21, two m7i.large, docs/SANDBOX-VM.md "Scratch on migration"): 230 MB of
  installs and `/tmp` plus a 300 MiB process moved in 1.9 s (`send`), with 150 ms of the pause for the scratch's
  final delta; apt/pip/npm installs, whiteouts, `/workspace` files and running writers intact both ways.
- apt/pip installs with the gofer-backed host overlay (`--overlay2=none`) vs gVisor's internal overlay.
- Docker inside gVisor on a gofer-backed directory: overlay2 storage driver or a fall back to `vfs`.

## How it runs (YYC AI)

```
browser ─▶ Cloudflare Access ─▶ Worker yyc-ai (edge/worker.js) ─▶ tunnel yyc-ai ─▶ ui (2 pods: router + CloudCLI per person)
  ui ─ POST /internal/cc/sandbox ─▶ web ─▶ sandbox on an AWS burst host (sandboxd, gVisor) ─ /workspace, ~/.claude ◀─ JuiceFS
  ui ─ GET /proc (upgrade) ─▶ sandbox agent ─▶ claude ─▶ egress /x/claude ─▶ OpenRouter;  egress /x/tools/mcp ─▶ tools
  ui ─ /jfs (JuiceFS CSI) ─▶ the files panel (ws/<conversation>) and ~/.claude (users/<key>/claude)
```

- **UI** (DE0CH/claudecodeui `main`, AGPL-3.0; image `ghcr.io/de0ch/yyc-ai-ui:<fork commit 12>`, Deployment `ui` in
  DE0CH/YYC `yyc-ai/deploy/ui.yaml`): `jarvis/router.mjs` verifies the Access token (team domain, audience and
  `users` from the instance config), starts one CloudCLI server per signed-in person (HOME
  `/var/lib/cloudcli/home/<userKey>`, its `.claude` a symlink to `/jfs/users/<userKey>/claude`), proxies HTTP and
  WebSockets to it with `X-Jarvis-User`, stops idle ones; each person lives on one of the 2 replicas (rendezvous
  hashing, Service `ui-peers`). The server's Jarvis provider (`server/modules/jarvis/`) gets the conversation's
  sandbox from web and runs `claude` there through the agent's `/proc` (the SDK's `spawnClaudeCodeProcess`),
  touching it every minute while it runs; staff download the files Claude sent them (next section) from
  `/jfs/ws/<id>`.
- **Postgres for the UI:** Neon database `cloudcli` (project yyc-news-stream, the same compute as `jarvis` and the
  JuiceFS metadata database `jfs_yyc_ai`), one schema per person (`cc_<userKey>`).
- **JuiceFS volume `yyc-ai`:** metadata in Neon `jfs_yyc_ai`, data in the Hetzner bucket `yyc-ai-files` under
  `yyc-ai/`; mounted by every sandbox host at `/var/lib/sbx/jfs` and in the UI pods at `/jfs` (CSI driver).

## Sent files: Claude Code's SendUserFile

Claude hands a deliverable (a report, a chart, a spreadsheet) to the staff member with Claude Code's own built-in
tool **SendUserFile** (`{files: [paths], caption?, status: "normal"|"proactive", display?: "render"|"attach"}`; its
description tells the model to send deliverables, not scratch files, as they are produced). Nothing in the managed
CLAUDE.md mentions it (Deyao, 2026-10-21: the tool's own description is enough).
- **Enabled by** `CLAUDE_CODE_ATTACHMENTS_BY_PATH=1` in the sandbox env (`claudeCodeEnv`, `chat/src/web/claude-code.ts`).
  Read from Claude Code 2.1.304's bundle: the tool's `isEnabled` otherwise needs a first-party claude.ai login with
  the `allow_send_file` capability (a Remote Control session) and refuses a custom `ANTHROPIC_BASE_URL`; with the
  variable it is on (and not deferred behind ToolSearch) for any provider, and `call` only checks the paths and
  returns `{caption, attachments: [{path (absolute), size, media_type, isImage, pathValidated}]}` (no upload).
  Verified headless (`claude -p --output-format stream-json`): `SendUserFile` is in the init message's tools, the
  call and its result are in the stream and in the transcript (`toolUseResult` on the result line).
- **Kept by** copy-on-write snapshots (Deyao, 2026-10-28: a card must keep its file even when the agent later changes
  or deletes it). When the instance has an egress route named `sent-files` (`identity: true`, upstream the UI router's
  `/__jarvis/sent-files`), `claudeCodeEnv` adds Claude Code's managed settings (`JARVIS_CLAUDE_SETTINGS` →
  `/etc/claude-code/managed-settings.json`, root-owned, so the agent (uid 1000) can't change them) with a
  **PreToolUse hook on SendUserFile**, `/opt/agent/send-file-hook.mjs`, and `JARVIS_SENT_FILES_URL`. Claude Code
  waits for the hook before the tool runs: it POSTs `{toolUseId, files: [absolute paths]}` with the egress token to
  `/x/sent-files/snapshot`; egress adds `X-Jarvis-Conversation` / `X-Jarvis-Sandbox` as it verified them (a caller's
  own copies are dropped) and the route's own credential; the UI clones each file (`juicefs clone`: metadata only,
  about 0.1 s, data shared until either side changes) to `/jfs/sent/<conversation>/<toolUseId>/<path>`, outside the
  sandbox's view, and the cards read that copy. Anything but 200 makes the hook exit 2: the send is blocked and the
  model is told the files could not be saved, so a card never points at a file that was not kept. Only a delete in
  the same parallel batch of tool calls as the send could race it. Without the route, files are sent by path only.
- **Shown by** the fork (DE0CH/claudecodeui `src/modules/jarvis-files/SentFileCards.tsx`): each call is a set of
  download cards under the assistant's turn (name, size, a preview for images and PDFs unless `display: "attach"`),
  live and from history. The **檔案 (Files) panel** lists only sent files: `GET /api/jarvis/sessions/:id/files`
  reads the conversation's transcript (`server/modules/jarvis/jarvis-sent-files.ts`: calls with a result that is not
  an error, paths inside `/workspace`, newest send first), then opens each under `/jfs/ws/<id>` without following
  symlinks; a file gone since is left out. There is no table of its own: the transcript is the record.

## Sharing: a read-only link, 「繼續對話」, 「停止分享」

The previous YYC AI frontend's "Sharing and continuing" (Deyao, 2026-10-21; removed from jarvis3 in 07e2e49), rebuilt
in the fork (Deyao, 2026-10-22): `server/modules/jarvis/jarvis-shares.ts` (+ `.routes.ts`), `src/modules/jarvis-share/`.
- **Share** (「分享」: a button in the conversation's header on every screen, and the ⋯ menu of each conversation in the
  list): a sheet with 「已登入 YYC AI 的同事可以查看這段對話（只讀）」, 「複製連結」, 「分享連結」 where the device has a
  share sheet (`navigator.share`; the iOS app's web view has none, so it copies), and the conversation's live links,
  each with 「複製」 and 「停止分享」. Every copy makes a **new snapshot link** `/s/<id>` (16 random bytes, base64url) of
  the conversation as it is then; a turn still running is left out; later messages never show on an earlier link.
  400 「暫時未有可分享的內容。」 before the first answer.
- **Audience:** instance staff only. `/s/<id>` and `/api/jarvis/shares/*` go through Cloudflare Access and the router's
  `users` check like every page, and are served by the **viewer's own** CloudCLI process, which reads the shared
  table. Not public.
- **The shared page** shows what the owner sees (messages with their images, tool steps, sent-file cards) read-only,
  under 「<name> 分享的對話（只讀）」 (name = the owner's address before the @, as before). Downloads
  (`/api/jarvis/shares/:id/files/raw`) only of files Claude sent (SendUserFile) and uploads (`uploads/`), never other
  workspace files or symlinks. Revoked, or the conversation deleted: 「此連結已失效。」 (404).
- **繼續對話** (the page's one action; the UI never says fork or copy): a new conversation of the viewer's, same title,
  at the top of their list: Claude Code's transcript re-written under a new session id and new message ids (every
  old id replaced, `forkedFrom` dropped: no parent; the session row is written before the file, so the transcript
  watcher never lists it twice), its session folder
  (sub-agent transcripts, saved tool output) and every `/workspace` file of the snapshot. Not carried over: the sandbox
  (the first message starts a new one), a running turn, spend. Making a link takes a few seconds (it copies the
  workspace on JuiceFS; measured 6.4 s for a small conversation).
- **Data:** table `cc_shared.shares` (id, owner, owner_name, session_id, title, dir, files, created_at, revoked_at) in
  the `cloudcli` database, made on first use by any user's process (no migration step; old pods never touch it); the
  snapshot under `/jfs/users/<owner key>/shares/<id>/` (`messages.json` = the history the UI showed,
  `transcript.jsonl`, `session/`, `ws/` = a copy of the workspace, at most its 1 GiB quota), which no sandbox mounts.
  「停止分享」 and deleting the conversation set `revoked_at` and delete that folder. The old chat UI's `shares`,
  `blobs`, `blob_grants` tables in `jarvis` are not used.

## Warming: typing starts a host

With no AWS host up, a conversation's first message waits for one to boot (about 2 minutes). So typing warms it:
the composer (`src/modules/chat/hooks/useChatComposerState.ts` and `src/modules/chat/utils/jarvisWarm.ts` in the
fork) calls the server's `POST /api/jarvis/warm {sessionId?}` when the user types, at most once per 30 s per
conversation (a new chat counts as one conversation until it has an id); the server
(`server/modules/jarvis/jarvis-warm.routes.ts`, only in Jarvis mode, throttled the same way) answers at once and forwards it to
web's `POST /internal/cc/warm {owner, conversation?}`. Web makes nothing: when the conversation has no live sandbox it
records a demand hint (kv `sandbox_demand:<owner>`, counted 2 minutes) and the scaler, every 5 s, starts an AWS host
when no host has a free slot (docs/SANDBOX-VM.md, "Scaler"). A warm that is never followed by a message costs at most
the host's minimum lifetime: an empty host goes once it is 15 minutes old, as any other. A warm does not reset a live
sandbox's idle time and does not make the sandbox itself (that waits for the message, and takes seconds on a ready
host).

Measured 2026-10-21 (no host up, a fresh conversation, "Reply with just the word: ready", Sonnet 5.5, time from send
to the reply): cold 111.5 s; typing 30 s before sending 76.5 s; typing 90 s before sending 12.1 s. Then a host,
`active` 36–45 s after launch, still fetched the sandbox image from the gateway (about 45 s) before its first sandbox,
because its AMI held an older image. With the AMI holding the pinned image (DE0CH/YYC workflow `yyc-ai-ami`,
docs/SANDBOX-VM.md "Operations"), measured the same way at 18:52 UTC: cold 79.6 s = host active after 45.4 s, sandbox
placed 5 s later (no fetch: the gateway sent < 1 MB over wg0, the image is 1.6 GB), ready 9 s later, reply 15 s later.

## Deploying a change

- **The fork (UI or its server):** push to DE0CH/claudecodeui `main`; its `jarvis-image` workflow builds
  `ghcr.io/de0ch/yyc-ai-ui:<commit 12>`; set that tag as `newTag` of `yyc-ai-ui` in DE0CH/YYC
  `yyc-ai/deploy/kustomization.yaml` and push. The `ui` pods roll one at a time (the router waits for running chats).
- **jarvis3 (web, egress, tools, the sandbox image):** push to `main`; the `chat` workflow tests and pushes
  `jarvis3-chat` and `jarvis3-sandbox` `:<commit 12>`; in DE0CH/YYC bump the base `?ref=`, the `jarvis3-chat` tag and
  `sandbox.image` in `config.json`. New sandboxes get the new image; running ones keep theirs.
- **sandboxd or the host image:** its own workflow and an AMI bake (docs/SANDBOX-VM.md).

## Rolling back the cut-over

The public name serves the UI because of two switches in DE0CH/YYC: `yyc-ai/infra/cloudflare.py` `UI_CUTOVER = True`
(the tunnel's origin name → `ui`) and `yyc-ai/edge/worker.js` `UNDER_CONSTRUCTION = false`.
- To take YYC AI offline: `UNDER_CONSTRUCTION = true` and redeploy the Worker (`cloudflare.py … --dns`).
- The old chat UI no longer exists in jarvis3 `main`. Bringing it back means pinning DE0CH/YYC to jarvis3 2156d8a (its
  chat and sandbox images, the `model` route and `s3` in config.json, the web-env S3 keys) and `UI_CUTOVER = False`;
  its data is still in Postgres and the bucket's `jarvis/` prefix.

## Cost (YYC)

- **Model calls:** OpenRouter key `yyc-chat`, per token, under the shared budget (config `budget`, USD 30 from
  2026-10-21) and the key's USD 50/month cap. Every call is a row in `egress_log` with OpenRouter's own cost.
- **Sandbox hosts:** AWS m7i.xlarge burst hosts (YYC's AWS account, eu-central-1) only while sandboxes run: USD
  0.2415/hour + IPv4 USD 0.005/hour + 40 GB gp3, each holding up to 12 sandboxes; a host is terminated once empty and
  15 minutes old; at most 3. A conversation's first message with no host up waits for a host to boot (about 40 s).
- **Fixed:** the UI pods, web, egress and tools on the existing Hetzner cluster (no extra nodes); Neon databases
  `cloudcli` and `jfs_yyc_ai` on the existing compute; JuiceFS data in the existing bucket (storage and requests).
- DE0CH/YYC `EXPENSES.md` has the evidence for each.

