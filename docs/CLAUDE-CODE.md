# Claude Code in the sandbox (design, agreed with Deyao 2026-10-21)

Replaces the chat runtime's agent loop on the server (claw per turn + jarvis-bash + workdir sync, docs/CHAT.md) and
its web UI. Claude is trained on Claude Code running on one computer, with file tools and bash on the same machine,
CLAUDE.md and MCP config read from disk; this design gives it exactly that, inside the sandbox.

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
   Model calls: `ANTHROPIC_BASE_URL` = egress `/x/model` → OpenRouter with zero data retention, under the shared
   budget, with a short-lived token; the sandbox holds no real key. Licence: Claude Code's commercial terms,
   accepted by Deyao as a one-time exception for this instance.
3. **Storage in the sandbox**

   | What | Paths | Lifetime | Where | On migration |
   |---|---|---|---|---|
   | base system | image (`/usr`, `/opt/py`, `/etc` as shipped) | per image | read-only image on the host disk, shared | nothing (same image on every host) |
   | persistent work | `/workspace` (quota: 1 GiB and 1,000 files, a plain folder), `~/.claude` | the conversation | JuiceFS (metadata: Neon Postgres; data: the Hetzner bucket), mounted by the host and bind-mounted in | nothing (destination mounts the same volume) |
   | installs and scratch | apt, pip, npm -g, `/tmp`, `~/.cache`, Docker's dir | the sandbox | host disk: Linux overlayfs (image as lowerdir, `/sbx/<id>/upper` as upperdir) + host dirs for `/tmp` and Docker, capped at 5 GiB (writes past it fail with ENOSPC) | file-level pre-copy: rsync rounds while it runs, the final delta while it is stopped, before the restore (docs/SANDBOX-VM.md "Scratch on migration") |
   | memory | processes | the sandbox | RAM | pre-copied by the gVisor fork |

   Writes past a quota fail with an error the agent sees; nothing truncates, destroys or crashes.
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
