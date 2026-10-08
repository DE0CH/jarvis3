# Open points and choices made while building the server (v0.1)

Where DESIGN.md / PLAN-draft.md left a point open or ambiguous, the server took the option closest to
DESIGN.md and recorded it here. Each item can be revisited; none is hard to change yet.

## Identity and access

1. **How sessions pass Cloudflare Access.** PLAN says a session holds no Access token; DESIGN says
   Access sits in front of every hostname. Both can't hold for an outbound session dial-in. Chosen:
   one shared **session gate** service token (`access.sessionGateClientId`) that identifies no user.
   With it the server honours only `/api/session/*` and the channel, and only together with a valid
   per-task session token; on every other route it is a 403. Alternative: an Access bypass path for
   `/api/session/*` authenticated by the session token alone.
2. **Session token rights.** PLAN lists three (fetch its layer bundle, add notes, report status). The
   reverse channel needs a fourth: the session opens its own channel with the same token. It still
   reaches nothing but its own task.
3. **Admin-only routes answer 404 to non-admins**, the same uniform 404 as "not yours", so the admin
   surface isn't discoverable.
4. **Revoked device whose Cloudflare delete failed.** The server marks the device revoked first and
   refuses it from then on; if deleting the token at Cloudflare fails, it is logged and not retried
   (the token still passes Access but gets a 403). A retry queue could clean these up.
5. **Leaving every mapped group (or the directory) = offboarding**, status `removed`, same effects as
   suspension. A directory error or an empty answer changes nothing.

## Offboarding

6. **v1 pauses, it does not archive and destroy.** The task asked for "pause that user's sessions"
   (PLAN's minimal offboarding); DESIGN's full offboarding archives and destroys them. Pausing is
   forced: the machine is destroyed even when the snapshot fails. Archiving a departed person's
   paused tasks is a later step (an admin can already DELETE them).

## Tasks and machines

7. **Snapshot contract** (`jarvis-snapshot start|status`, docs/API.md section 10) is defined here and
   must be implemented by the session image.
8. **Restore URL in the machine env.** A resumed machine gets a presigned GET URL valid
   `presignSeconds` (1 h). If Fly restarts the machine (on-failure policy) after that, the restore
   fails. Alternative: the session fetches its restore through the server with its session token
   (a fifth session right).
9. **First prompt in the machine env** (`JARVIS_FIRST_PROMPT`, ≤ 16000 characters). Fly's limit on
   env size has not been checked against real Fly. Alternative: deliver it down the channel once the
   daemon is up.
10. **A `failed` task can only be destroyed** (no retry); the user starts a new task.
11. **One server replica.** Session channels live in the process's memory.
12. **No local-Docker MachineProvider yet.** PLAN wants one for CI integration runs; tests use the
    in-memory fake. The Fly implementation is ported from Jarvis 1 but untested against real Fly.

## Spend

13. **OpenRouter monthly reset is native.** OpenRouter's key API (checked 2026-10-08) takes
    `limit_reset: "monthly"` and resets usage at midnight UTC on the 1st, so the server does no
    resetting. Keys are created with `include_byok_in_limit: true` and named
    `<instanceName>: <email>` in the instance's own OpenRouter account.
14. **Machine hours** count from the machine's start to its destroy (including the time a pause
    snapshot takes), from the server's own records, not from Fly's bill.
15. **Budget rates** are Jarvis 1's Fly rates (shared/performance CPU + RAM); volumes and bandwidth
    are not counted (sessions use no volumes).
16. **Notifications are in-app notices only** (`GET /api/notices`); no push or email yet.

## Layers

17. **Org-env is served as a tar, not a git bundle.** PLAN mentions Jarvis 1's repo-bundle pattern;
    a session needs the tree, not history, and a tar needs no Git in the path. `GET
    /api/session/org-env.tar` plus the assembled `GET /api/session/bundle`.
18. **Org-env layout** chosen: `AGENTS.md`, `skills/<name>/`, `roles/<role>/AGENTS.md`,
    `roles/<role>/skills/<name>/`, `policy/AGENTS.md`, `policy/skills/<name>/`, `policy/deny.json`.
19. **Skill-name precedence:** policy > org > role > personal; a clash renames the later one
    `<layer>-<name>`. PLAN only said personal/role may not shadow org; the policy (locked, "may not be
    shadowed") is put above org, and role above personal.
20. **Undo never loses content.** Undo restores the latest version; whatever was added since the
    Reset is archived first as a new version (reason `undo`), so a second Undo swaps back. Versions
    are never deleted.
21. **Personal layer and its versions live in the SQLite file** (replicated with it), not as objects
    in the bucket.

## Models

22. **Model curation is config only.** The server accepts exactly the configured models; checking
    each against OpenCode tool calling is a curation step outside the server.
