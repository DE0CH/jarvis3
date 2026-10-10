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

6. **Offboarding archives and destroys every session of the person** (DESIGN "Offboarding"; API.md
   section 6). A running machine is destroyed even when its final snapshot fails: the last pause
   snapshot is archived instead, or the task is archived without its state. Cutting the person off
   wins over keeping that last state. A task with no machine is never destroyed without its
   archive; it is retried every minute. Alternative: keep a machine whose snapshot failed running
   (without its key) until an admin decides.
34. **The personal layer is copied to the bucket at offboarding** (`archives/<userId>/`), in
    addition to staying in the database, so the archive holds everything of the person in one
    place. A returning member keeps their layer.

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
    Fly implementation has passed one manual run against real Fly ([FLY-E2E.md](FLY-E2E.md)); CI
    still covers only Docker.

## Spend

13. **OpenRouter monthly reset is native.** OpenRouter's key API (checked 2026-10-08) takes
    `limit_reset: "monthly"` and resets usage at midnight UTC on the 1st, so the server does no
    resetting. Keys are created with `include_byok_in_limit: true` and named
    `<instanceName>: <email>` in the instance's own OpenRouter account.
14. **Machine hours** count from the machine's start to its destroy (including the time a pause
    snapshot takes), from the server's own records, not from Fly's bill.
15. **Budget rates** are Jarvis 1's Fly rates (shared/performance CPU + RAM); volumes and bandwidth
    are not counted (sessions use no volumes).
16. **Notifications are in-app notices plus push** (API.md section 16); no email.

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

## HTTP relay (v0.2)

32. **No backpressure on relayed downloads.** The session sends a file in base64 chunks as fast as
    the daemon reads it, and the server writes each to the app's response without waiting for it
    to drain, so a slow client makes the server buffer the rest in memory. Fine for documents; a
    multi-GB download through a slow phone link would need flow control (a `http-more` credit
    frame) first.
33. **Revoked versus suspended.** A revoked device of an active user answers 403 `device_revoked`;
    once the user is suspended or removed, their devices (revoked too) answer 403 `forbidden`, so
    the app can tell "pair again" from "no access".

## Suggest for everyone (v0.3)

35. **A suggestion targets the org layer only**: a skill goes to `skills/<name>/`, instructions and
    notes are appended to `AGENTS.md`. Moving it into a role (`roles/<role>/…`) is the reviewing
    admin's edit on the pull request. Alternative: a target picker in the app.
36. **Instructions and single notes can be suggested too**, not only skills (DESIGN names skills).
37. **State is polled, not pushed**: GitHub webhooks would need a public, un-Accessed route. The
    server re-reads open pull requests every 5 minutes and on a listing older than 60 s.
38. **A merge doesn't reach sessions by itself**: sessions load the pinned `orgEnv.commit`, which a
    deploy moves. The notice on merge says so.
## Actions and approvals (v0.4)

39. **The guard plugin is defence in depth.** The agent's user owns `~/.config/opencode`, so a
    determined agent could drop the plugin from its own config. What must never happen without an
    approval goes behind a named action: its credential never enters the machine. Moving OpenCode's
    config to a root-owned path (`OPENCODE_CONFIG`) would close the gap once OpenCode's own writes
    there are checked.
40. **Tier 3 requests come only from admin-role tasks**; an access request can never grant a Tier 3
    action. Only the configured `owner` approves, with a user-verified passkey.
41. **Passkeys are added only on an identity login** (not with a paired device's token) and only by
    the owner; every addition leaves a notice. Recovery when the owner loses every device: an admin
    with database access deletes the `passkeys` rows, and the owner adds a new one after signing in.
42. **Passkey UI is two server pages** (`/api/pages/…`) rather than native code in the app: one
    WebAuthn implementation for Safari and iOS, and the RP ID is the instance host, which needs no
    Associated Domains per instance. A native module would need them.
43. **An admin may approve an admin-level request from their own task** (a one-admin instance
    needs it). Self-confirm requests can only be decided by the task's owner, not by an admin.
44. **Waiting has no deadline.** A request stays pending until someone decides, or the task is
    paused or destroyed (then it is cancelled). While the agent waits its turn is running, so the
    task counts as busy and is not idle-paused: the machine (and its machine hours) keeps running
    until the decision. A deadline per kind would bound that cost.
45. **Approvals notify through notices** (`approval_needed`, `approval_decided`), which are pushed
    (points 75-80).
46. **One mailbox per `smtp.send` action.** Sending as each user from their own mailbox is Tier 1
    (their own OAuth) and comes with Tier 1; until then a `self` guard on the user's own mail CLI
    covers it.

## Tier 0 tools ([TOOLS.md](TOOLS.md))

47. **Search and fetch are server-metered, even where a provider could mint per-user keys** (Exa's
    Team Management API, Tavily Enterprise). A reservation against the cap before each call makes
    the cap as hard as a provider's, and the key never leaves the server. A provider's own per-user
    key could be added behind the server as a second guard (the server would hold the user's key and
    call with it), once an account has the feature enabled.
48. **One allowance for search and fetch together** (`toolsMonthlyUsd`, USD), and a separate GB cap
    for proxies (`proxyMonthlyGb`), because proxy sub-accounts are capped in GB by the provider.
49. **A proxy provider outage doesn't stop a task**: it starts without a proxy (logged), and the next
    task tries the sub-account again.
50. **The relay limits tunnel ports to 80, 443, 8080 and 8443**; SSH, SMTP and the like through the
    organisation's proxy would need a deliberate change.
51. **Relayed traffic passes through the instance server** (and its Cloudflare tunnel). Fine for
    page-sized traffic; bulk downloads through a relay provider cost the server's bandwidth. A
    subuser provider keeps that traffic off the server.
52. **The ledger keeps no query text or URL**, only tool, provider, cost, bytes and month, so usage
    views can't leak what someone looked up.
53. **Sub-account use is read every 15 minutes**, so the shown GB lag; the provider's own allocation
    is what stops traffic, not the shown figure.

## Files, attachments and transcript search (v0.5)

54. **Files are one folder per person**, not named stores shared between people or chosen per task
    (Jarvis 1's content stores). Sharing a file with a colleague, or org-wide files, would need an
    owner model beyond "a person's own"; until then the org-env repo holds what everyone shares.
55. **A session gets a copy of the files, not a mount.** `~/files` is copied at boot (newest
    first, up to `files.sessionSyncBytes`) and never synced back; the agent saves a result
    explicitly with `jarvis-files save`. Two-way sync would need conflict rules between a task's
    copy, the app and other tasks. A file changed in the app during a task reaches it only with
    `jarvis-files get`.
56. **Uploads stream through the server**, not straight from the app to the bucket with a presigned
    PUT: that would need CORS on the bucket and a second origin the app talks to. The cost is the
    server's bandwidth, and Cloudflare's 100 MB request limit caps a single file (default limit
    50 MiB). Downloads are presigned links straight from the bucket.
57. **Attachments are files.** The app uploads them into the person's files
    (`attachments/<requestId>/…`) before creating the task; they stay there (visible in the Files
    tab, deletable) rather than in a staging area that is cleaned up (Jarvis 1's `.uploads`).
58. **Images go to the model inline only when the config says it takes images** (`models[].images`;
    without it OpenCode refuses them with "this model does not support image input"), and always
    as files; after three failed attempts to start the agent
    with them (a model without image input), the first prompt goes without the inline images (the
    files are still in `~/workspace/attachments/`).
59. **Transcript search is keyword only** (SQLite FTS5, trigram): no embeddings, so nothing leaves
    the instance and nothing is billed. Jarvis 1's search adds semantic matching through
    OpenRouter embeddings; that could be added per instance later (a per-instance key and a
    re-embed job).
60. **The session pushes its transcript; the server never reads snapshots.** A task paused or
    archived before v0.5 is not in the index until it is resumed (its whole timeline is sent then).
    Archived tasks from before v0.5 stay unsearchable; indexing them would mean unpacking each
    archive's OpenCode data on the server.
61. **The index holds the conversation as text in the database** (up to 8000 characters per
    entry), so it is in the Litestream replica too. Tool output is trimmed to about 1 KB per call.
62. **An agent may search its owner's other tasks** (`jarvis-search`), not only the app: the same
    scope as the owner's own search. It is a fifth session right (docs/OPEN.md #2), limited to the
    owner's data.
63. **Offboarding keeps a person's files and transcripts** for the organisation (admins can list,
    download and search them), like their personal layer and archives.

## Scheduled tasks, wakeups and channels (v0.5)

64. **A scheduled run is a new task**, started like New task (DESIGN: "a prompt to run as a new
    task"), not a message into an older task. A recurring job that should keep its conversation is
    a recurring (`cron`) wakeup of that task instead.
65. **One run of a schedule at a time.** A firing while the previous run's task is still starting,
    running, idle or pausing is skipped (`skipped_overlap`), so a slow run can't pile up machines.
    Runs that end paused stay as ordinary paused tasks; nothing deletes them. Alternative: archive a
    run's task automatically once it posted its result.
66. **Spend limits on schedules.** A schedule fires at most every 60 minutes (config
    `schedules.minIntervalMinutes`), a person has at most 20, and every firing checks the owner's
    machine-hour cap and the instance budget first (skipped runs are recorded, the owner is told
    when the outcome changes). A missed firing (server down) runs if at most 60 minutes late, else
    it is recorded as `missed`; there is no catch-up of several missed runs.
67. **Condition checks run on the server, so they are declarative HTTP checks only**: HTTPS GET to
    a public address, no credentials or headers, no redirects, plain-text conditions (no regular
    expressions, which could stall the server). Jarvis 1 ran a session-supplied script on the
    control plane with the session's own secrets; here the server holds Tier 3 credentials, so
    agent-written code never runs on it. A condition that needs a credential (an email reply, a
    private CI run) is a timed or recurring wakeup instead: the task looks, then re-arms.
    Alternative: run check scripts in a small throwaway machine per check, at machine-hour cost.
68. **Wakeups resume a paused task, whatever paused it** (idle, the owner pressing Pause), unless
    a cap or the budget stops it; then the message waits and the owner is told once. A wakeup
    belongs to its task: destroy, a failed start and offboarding cancel it.
69. **Delivery is a new user message to the task's main agent, only between turns.** Paseo can
    interrupt or steer a running turn but has no queue, so the session waits until the agent is
    idle (and has no pending permission), then sends all waiting messages as one. The prompt
    starts with a header naming the wakeup, so the agent knows where it came from. At least once:
    the session keeps the delivered ids in its snapshot so a crash between send and ack doesn't
    repeat it.
70. **Channels are per task**, inside the app (no Discord). A post gives the owner a
    `channel_post` notice; reading the channel marks both read. An admin can read every channel
    without marking it read for its owner. No attachments yet: posts are markdown text; a file
    goes in the task's files once those exist. At most 60 posts an hour per task.
71. **The person's time zone comes from the app** (`X-Time-Zone` on every call, the latest kept).
    A schedule stores its own zone (the form defaults to the device's), so moving abroad doesn't
    move a schedule; wakeups default to the person's current zone.
72. **Cron in a zone follows classic cron**: a wall-clock time skipped by a spring-forward change
    doesn't fire that day, and one repeated by a fall-back change can fire twice (only for
    schedules with minutes in the repeated hour, typically 01:00–02:00).
73. **The owner can arm a wakeup from the app, time only, and only the owner** (`POST
    /api/tasks/:id/wakeups`). Cron and condition wakeups stay the agent's: they need the agent to
    know what it is waiting for. An admin can see and cancel a person's wakeups but not arm one, since
    it would spend the owner's machine hours and add a message to their conversation. Alternative:
    let admins arm too (the `owned` rule), or offer the repeat picker of the schedule form.
74. **Uploads are one streamed request** (no chunked or resumable upload). The server streams the
    body to the bucket and allows a request 2 hours; the app streams from the file. A cut-off
    upload starts again from the beginning, and Cloudflare's 100 MB request limit still caps one
    file (#56). S3 multipart behind a chunked upload route would lift both, at the cost of
    tracking unfinished uploads.


## Push notifications (v0.6)

75. **Direct APNs and Web Push, no Expo push service.** The instance holds its own keys (APNs `.p8`,
    VAPID) and sends itself, so nothing about an organisation's notices passes a third party
    beyond Apple's and the browsers' own push services. The cost: an instance needs an Apple
    developer team's APNs key for its app (DESIGN "iOS distribution").
76. **A push carries no private content**: a fixed title per kind, a fixed body, the unread count,
    and ids. The lock screen never shows a notice's text; the app fetches it after the tap. A
    richer preview would need encrypted content (a Notification Service Extension on iOS).
77. **Kinds are coarser than notice kinds** (nine push kinds), with `question` split out of
    `approval_needed` so "ask the boss" can be muted without muting approvals. Every kind is on by
    default; turning push on for a device is the opt-in.
78. **A Web Push endpoint must be on a known push service** (FCM, Mozilla, Apple, Windows by
    default), because the server POSTs to whatever a member registers. Another browser's service
    needs `push.webPush.allowedHosts`.
79. **One push a minute per kind and task** (in memory, so a restart may let one more through):
    a task posting 60 times an hour doesn't buzz a phone 60 times.
80. **Registering an address that exists moves it to the caller** rather than refusing: on a shared
    computer or a phone that changed hands, the last person to turn push on gets the pushes. An
    APNs token comes only from a paired device and dies with the device's revocation.
