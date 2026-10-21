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
2. **Agent: Claude Code inside the sandbox**, `cwd=/workspace`, a git repo made when the workspace is first made
   (invisible to staff). `CLAUDE.md`: the YYC instructions, plus a paragraph on sandbox release (only `/workspace`
   and the conversation carry over; installs, processes and everything else are gone). MCP: our tools role.
   Model calls: `ANTHROPIC_BASE_URL` = egress `/x/model` → OpenRouter with zero data retention, under the shared
   budget, with a short-lived token; the sandbox holds no real key. Licence: Claude Code's commercial terms,
   accepted by Deyao as a one-time exception for this instance.
3. **Storage in the sandbox**

   | What | Paths | Lifetime | Where | On migration |
   |---|---|---|---|---|
   | base system | image (`/usr`, `/opt/py`, `/etc` as shipped) | per image | read-only image on the host disk, shared | nothing (same image on every host) |
   | persistent work | `/workspace` (1 GiB quota, git), `~/.claude` | the conversation | JuiceFS (metadata: Neon Postgres; data: the Hetzner bucket), mounted by the host and bind-mounted in | nothing (destination mounts the same volume) |
   | installs and scratch | apt, pip, npm -g, `/tmp`, `~/.cache`, Docker's dir | the sandbox | host disk: Linux overlayfs (image as lowerdir, `/sbx/<id>/upper` as upperdir) + host dirs for `/tmp` and Docker, capped at 5 GiB (writes past it fail with ENOSPC) | file-level pre-copy (rsync-style while running, final delta in the pause) |
   | memory | processes | the sandbox | RAM | pre-copied by the gVisor fork |

   Writes past a quota fail with an error the agent sees; nothing truncates, destroys or crashes.
   runsc runs with `--overlay2=none` so scratch writes land as plain host files (today's `--overlay2=root:self` keeps
   the upper layer in gVisor's memory image, which is what OOM-killed a large sandbox on restore after a move).
4. **Sandbox lifecycle:** release = unmount and drop the sandbox; nothing to save (every `/workspace` and
   `~/.claude` write is already in storage). Scaler, placement, release rules, Rust sandboxd, egress allowlist,
   tools role, budget and Access stay as they are.

## Measurements to make before building on them

- git on JuiceFS from an AWS host (init/add/commit/status on ~2,000 files, cold and warm cache) vs local disk.
  Fallbacks if too slow: `.git` on scratch with a push to a bare repo on JuiceFS after each turn; or all of
  `/workspace` on scratch with a sync after each turn.
- apt/pip installs with the gofer-backed host overlay (`--overlay2=none`) vs gVisor's internal overlay.
- Docker inside gVisor on a gofer-backed directory: overlay2 storage driver or a fall back to `vfs`.
