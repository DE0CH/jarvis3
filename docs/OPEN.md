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
12. **Local-Docker MachineProvider** (`server/src/docker.ts`, `machines.kind: "docker"`) runs the
    integration test and local runs; it is not for production (a container is not a microVM). The
    Fly implementation is ported from Jarvis 1 but still untested against real Fly.

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

## Session image (v0.1)

23. **The daemon password rides on a Paseo compatibility path.** The server proxies the app's
    socket with `paseo.bearer.<password>` as a subprotocol; Paseo marks header/subprotocol auth
    `COMPAT(headerAuth)`, "remove after 2027-03-24", in favour of the password in the client's
    `hello` message. Before Paseo drops it, the server's proxy (or the session's channel agent) must
    put the password into the client's first `hello` frame instead. Pin Paseo until then.
24. **A platform preamble comes before the org layer.** The image puts a short fixed text first in
    the instructions (what the machine is, where the org-env tree is, how to `jarvis-remember`), so
    every org gets the remember command without writing it. It is the lowest-precedence text; the
    org can contradict it.
25. **A failed restore boots an empty task.** If the snapshot download or unpack fails on resume,
    the machine logs it and starts without the old state (the conversation is lost for that
    machine, the snapshot is still in the bucket). Alternative: don't dial in, so the task stays
    `starting` and an admin can look. There is no route for a session to report a boot error.
26. **Deny rules on pattern-less OpenCode permissions** (`webfetch`, `websearch`, `todowrite`,
    `question`, `doom_loop`) deny the whole permission, whatever the pattern says.
27. **The session token stays out of the agent's processes.** jarvis-agent (root) holds it; the
    Paseo daemon, OpenCode and every shell the agent runs (user `jarvis`) get only the OpenRouter
    key and the daemon password. `jarvis-remember` reaches the server through jarvis-agent's local
    socket. The integration test checks this. Anything on the machine can still ask jarvis-agent to
    add a note, which is the point of the command.
28. **Paseo gives OpenCode 30 s to start** (hard-coded). On a slow shared CPU OpenCode's first start
    can miss it, so the image runs it once before the daemon starts, and the first prompt is retried.
    Fly's `shared-cpu-2x` with 2 GB is what the example config uses; smaller is untested.
29. **The snapshot is the whole home directory** (minus the org-env tree, generated layers and
    caches), taken while the daemon runs. OpenCode's SQLite files are copied live; SQLite recovers
    from that, but a write mid-copy could lose the last moments. Pausing the daemon's agents first
    would make it exact.
30. **MinIO for CI comes from Chainguard** (`cgr.dev/chainguard/minio`): the `minio/minio` images
    are no longer published on Docker Hub or Quay. `MINIO_IMAGE` overrides it.
31. **The session image is pushed to GHCR only after the integration test passes on it**, tagged
    with the commit (12 hex) and `main`. The package is private until the repo goes public, so an
    instance needs a pull credential until then (Fly: a registry auth on the app).
