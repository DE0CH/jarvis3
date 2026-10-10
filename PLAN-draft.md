# Jarvis 3: build plan for the first usable version (draft)

Status: draft of 2026-10-08, kept up to date with what was built (v0.1: `server/`, `session-image/`, `deploy/`, `infra/`, and the app in `DE0CH/jarvis3-app`). It follows `DESIGN.md` and does not reopen anything decided there. Sources read for the draft: `DESIGN.md`; Jarvis 1 (its self-hosted control plane: server, API, security notes, session image with its OpenCode harness and workspace layering); an earlier Paseo fork with a Jarvis integration and upstream `getpaseo/paseo`; and Jarvis 2's README and PLAN, for ideas only.

## 0. Findings that shape the plan

- **Two different Expo versions.** The Paseo app is on Expo SDK 54 with React Native 0.81. The Jarvis 1 dashboard is on Expo SDK 57 with React Native 0.86. The two apps can't simply be merged. One must be the base, and the other's screens get rewritten for that base's SDK.
- **An earlier Paseo fork had a small Jarvis integration** (pairing, a sync planner, a settings section, a few hooks in upstream files). It was iOS only and reached sessions through pairing offers over Paseo's public relay. Jarvis 3's app starts again from upstream in a new repo, `DE0CH/jarvis3-app`; the earlier fork is not used.
- **The Paseo daemon already has the auth hook needed to reach it through our own server.** It can take a password, and its WebSocket accepts a bearer token as a subprotocol (`paseo.bearer.<token>`), which works from a browser. So the app can reach each session's daemon through the instance server, without Paseo's relay and without a public web address per session.
- **Paseo's relay can be self-hosted.** It is a Cloudflare Worker with a Durable Object (`packages/relay`). This is a fallback option, not the plan.
- **Much of Jarvis 1 is reusable as logic, not as code paths:**
  - the Fly machine lifecycle (`fly.js`), pause by snapshot and destroy (`archive.js`, `paused.js`);
  - per-device Access service tokens (`devices.js`) and per-session scoped tokens (`sessiontoken.js`);
  - queued agent messages (`peer.js`, `harness-send`), the spend guard (`budget.js`), stall and idle detection;
  - the OpenCode + Paseo session harness and how it writes its instructions (`opencode-instructions.py`), and the repo-bundle delivery (`repobundle.js`).
  - Most of it assumes one user and Claude-shaped state. Jarvis 3 has no Claude harness, so the Claude-shaped status shim can go.

## 1. Repo layout and the one app

### Repositories

1. **`DE0CH/jarvis3`** (code only; no organisation's names, people or secrets):
   - `server/`: the instance server (API, authorisation, session lifecycle, key minting, layer store, the WebSocket proxy to session daemons).
   - `session-image/`: the session machine image (OpenCode + Paseo daemon, an outbound tunnel agent, the layer assembler, the "remember" helper).
   - `APP_COMMIT`: the `DE0CH/jarvis3-app` commit the server image ships. CI checks that commit out, builds its web export (variant `jarvis3`), and the server image serves it at the instance's root (`server/src/web.ts`).
   - `deploy/base/`: a Kustomize base for one instance (namespace, server Deployment with Litestream and the org-env mirror, tunnel, Flux objects). Instances use it as a remote base, pinned to a commit or tag.
   - `deploy/example-instance/`: a fake instance (`example.org`) used by the docs and by CI.
   - `infra/`: scripts that create an instance's box, Cloudflare tunnel/DNS/Access and SOPS secrets from one instance config file (dry-run by default).
   - `docs/`: DESIGN, PLAN, API, SECURITY and an instance bring-up runbook.
   - `.github/workflows/`: server and session images to GHCR, unit tests, the integration test, deployment checks.
2. **`DE0CH/jarvis3-app`**: upstream `getpaseo/paseo` with full history plus the `jarvis3` build variant:
   - All Jarvis code lives under `packages/app/src/jarvis3/` and `packages/app/src/app/(jarvis)/`.
   - Hooks into upstream files stay few and are listed in its `JARVIS3.md`.
3. **Per instance, in that organisation's own GitHub org:**
   - **The instance deploy repo** (for example `<org>-jarvis`, private): Flux manifests that use `jarvis3/deploy/base` at a tag, the instance config (hostname, Google Workspace domain, group-to-role map, model list, caps, provider IDs) and SOPS-encrypted secrets. Only admins can write to it.
   - **The org-env repo** (for example `<org>-env`): rules, skills, scripts, and the role and locked-policy folders (section 2).
   - Instance config stays out of `DE0CH/jarvis3`: this repo is public and holds no organisation's data. The instance deploy repo can also add other multi-user apps to the instance's box (docs/DEPLOY.md, "Extra apps").

### What is reused and what is new

| Piece | Source | How |
|---|---|---|
| Chat, agent stream, composer, host runtime | Paseo upstream | As-is, inside the fork |
| Pairing a device, Keychain token, refusal handling | The earlier fork's pairing, Jarvis 1 `auth.native.ts` and `devices.js` | Adapted: the pairing answer now names a user |
| Fly lifecycle, pause snapshot, archive, restore | Jarvis 1 `fly.js`, `archive.js`, `paused.js` | Ported to the new server and made per-user. Claude-only paths dropped |
| Session harness (`harness-opencode.sh`, `harness-send`, `opencode-instructions.py`, the `workspace-layer.sh` idea) | Jarvis 1 session image | Rewritten smaller: OpenCode only, `permission: allow` always. The Claude-shaped status shim, tmux mirror and Discord parts are dropped |
| Outbound tunnel agent (`cf-tunnel/agent.js` protocol) | Jarvis 1 | Reused as the session-to-server reverse channel, ending at our server instead of a Cloudflare Worker |
| Spend guard, idle auto-pause | Jarvis 1 `budget.js`, the auto-pause loop | Ported; made per user |
| Users, roles, ownership, authorisation | none | **New** |
| Per-user OpenRouter keys | none | **New** |
| Org, role and personal layer assembly, personal layer store, Reset/Undo | none | **New** (it extends the `workspace-layer.sh` idea) |
| Google Workspace directory sync (groups to roles, suspension) | none | **New** |
| Dashboard screens (task list, New task, My instructions & skills, Reset, Notices) | Jarvis 1 `NewSession` and cards as reference | **New screens** in `DE0CH/jarvis3-app`, written for Expo 54 using Paseo's own UI components |

### One Expo app (web and iOS)

- **Paseo is the base.**
  - Chat is the product's core, and it is Paseo's. It is the biggest and fastest-moving code, so it is the part that must stay easy to merge from upstream.
  - The Jarvis dashboard's useful surface for staff is small (task list, New task, instructions, Reset, later the approvals queue). It is cheaper to rewrite those screens on Expo 54 than to move Paseo onto Expo 57.
  - Jarvis 1's Radix kit is not ported. The Jarvis screens use Paseo's components, so the app looks like one app.
- **A build variant gates all Jarvis behaviour.** A new variant (`APP_VARIANT=jarvis3`, with bundle ID, scheme and an `extra.jarvis` instance URL) turns on the Jarvis code for both iOS and web.
  - On web the instance URL is the page's own origin, so one web bundle serves every instance.
  - The iOS build needs an instance URL per instance, because the bundle IDs differ per Apple team.
- **What the Jarvis variant changes in Paseo, each as a small hook:**
  - The home route shows the Jarvis task list instead of Paseo's host and project list.
  - Hosts come only from the instance, never from manual pairing or QR codes.
  - Staff don't see provider/model internals (only the curated model list), the git and review panels, the terminal, host settings or daemon pairing.
  - The WebSocket factory sends the device's credentials. On web, the browser's Access cookie on the same origin does this.
- **Keeping upstream easy to merge:**
  - All new code goes in `packages/app/src/jarvis3/` and new route files under `src/app/(jarvis)/`. Upstream files get only one-line hooks or gated imports.
  - Each hook is listed in `JARVIS3.md` with the reason for it.
  - Upstream's Expo SDK is never upgraded in the app repo; upgrades come only with upstream.
  - Upstream comes in by hand, when wanted: merge it on a new branch, run the checks, open a PR. No automatic updates, and never a force-push.
- **How the app reaches a session's daemon.**
  - Each task is a Paseo "host" with a direct WebSocket endpoint at `wss://<instance>/api/tasks/<id>/daemon`.
  - The server checks that the caller owns the task (or is an admin), then forwards the connection to that session's daemon over the session's reverse tunnel. It adds the daemon password on the way, so the client never holds it.
  - The Paseo relay and the per-session `<id>-s` web addresses are not used.
  - Paseo's direct host can't take a full `wss` URL with a path, so each task gets a pseudo-endpoint that one hook in the URL builders turns into the proxy URL (`JARVIS3.md`). The daemon's HTTP (file downloads) goes through `/api/tasks/<id>/daemon/http/*` the same way.

## 2. The minimum first version

**Goal:** a staff member and the organisation's test identity (DESIGN, "Employee view") each sign in with the identity provider (Google Workspace) through Cloudflare Access, press New task, and chat with an OpenCode session on OpenRouter. Authorisation is per user, each user has their own capped OpenRouter key, and the org, role and personal layers are loaded, with Reset.

### In scope

**Identity and authorisation**
- Cloudflare Access sits in front of the instance hostname, with Google Workspace as its only login. The server checks Access's JWT itself (team domain and audience from config) and takes the email, or, for a paired device, the service token's client ID.
- **Directory sync.** A read-only Google Directory API poll every few minutes maps Workspace groups to roles (`admin`, `staff`) and detects suspended users.
  - An unknown or suspended email gets a 403 from the server, even if Access let it through.
  - Suspension (or leaving the mapped groups, or the static list) offboards the person: their OpenRouter key and devices are revoked, their sessions archived to the bucket and destroyed, and their personal layer and archives kept for the organisation, visible to admins (docs/API.md section 6).
- **Device pairing** works as in Jarvis 1 (identity login, then a per-device Access service token). The server records which user each token belongs to. Web uses the Access cookie.
- **Every API route and the daemon proxy go through one authorisation function:** owner or admin may act on a resource, nobody else.
  - Responses for another user's resource are a uniform 404, so they don't reveal that the resource exists.
  - The admin sees everything. The written notice to staff is outside the software.
- **Session-scoped tokens** (Jarvis 1's `SESSION_API_TOKEN` pattern). A session can only:
  - fetch its own layer bundle;
  - write "remember" notes into its owner's personal layer;
  - report its status.
  
  A session never holds an admin-capable credential or any Access token.

**Tasks (sessions)**
- **New task.** The user writes the first prompt and optionally picks a model from the instance's curated OpenRouter list. The server creates a machine with:
  - the user's OpenRouter key;
  - the session token;
  - the layer bundle reference;
  - the daemon password.
- The **task list** shows the user's own tasks: starting, running, idle, paused or archived, each with a title.
- **Chat** is Paseo's own UI on the task's host.
- **Idle auto-pause:** snapshot to archive storage, then destroy the machine. **Resume** creates a new machine from the snapshot, as in Jarvis 1. **Destroy** archives first, then deletes.
- **Spend:**
  - per-user model spend is capped by the OpenRouter key limit;
  - per-user machine hours per month are counted against a cap per role, with an admin override per person; at the cap the user's sessions pause and the user and the admins get a notice; the admin's Users page shows each person's use and cap;
  - an instance-wide machine budget guard is ported from `budget.js`.

**Per-user OpenRouter keys**
- The instance holds one OpenRouter provisioning key. On a user's first task it creates a key named after the user, with a monthly limit taken from that role's config.
- It stores only the key's hash/ID and the key itself, encrypted at rest.
- An admin can change a user's limit; offboarding deletes the key.
- Verify that OpenRouter's key-creation API supports a monthly limit reset; if not, the server resets limits on the 1st itself.

**Environment layers.** On each boot the session image builds a workspace in this order:
1. **Org layer:** the org-env repo at a pinned commit. The server hands it over as a bundle (Jarvis 1's repo-bundle pattern), so no GitHub token is in the machine.
2. **Role layer:** `roles/<role>/` in the org-env repo (instructions and skills).
3. **Personal layer:** pulled from the server with the session token.
4. **Locked policy:** `policy/` in the org-env repo, loaded last.
   - It is the only layer allowed to set OpenCode deny rules.
   - Its instructions say they override everything else.
   - A personal or role skill may not shadow an org skill name; a clashing name is renamed with a prefix.
   - Approval-required actions are enforced by the broker and the guard plugin (v0.4, docs/ACTIONS.md); v1 had only instructions plus OpenCode deny patterns.

OpenCode gets all of this through generated `instructions` and skill folders, as `opencode-instructions.py` and `workspace-layer.sh` do today.

**Personal layer**
- It is stored by the server, not in git: instructions (one text), skills (name plus files) and notes (a list).
- The agent adds notes when the user says "remember …", using a small `jarvis-remember` command in the image that calls the server with the session token.
- The app has a "My instructions & skills" screen to read, edit and delete entries.
- **Reset to company default** archives the current personal layer as a numbered version and starts empty. **Undo** restores the latest archived version. Running sessions keep what they booted with; the screen says the change applies from the next task.

**Suggest for everyone** (built after v0.1)
- On a personal skill, the instructions or a note, the user (or an admin) taps Suggest for everyone; the server opens a pull request on the org-env repo with a repo-scoped token or a GitHub App installation token it holds (docs/API.md section 7a). The admin sees it in the app with its link and state.

**App**
- Web is served by the instance server. The iOS build is made only by `DE0CH/jarvis3-app`'s CI, for testing (see deferrals).

### Deferred, explicitly

- (Built in v0.4, docs/ACTIONS.md: the broker with named Tier 2/3 actions and per-action policy, the locked-policy guard plugin, the approvals queue with self-confirm, admin approval, access requests and "ask the boss" as in-app notices, and Tier 3 approval by the owner with a passkey. Still deferred: push notifications, more action types per instance.)
- iOS distribution: the organisation's Apple organisation account, the Apple Business custom app, and TestFlight for staff. Staff use the web page.
- Tier 1 OAuth (staff Gmail, Drive and Calendar), the user files tab, first-prompt attachments, transcript search, scheduled tasks, wakeups and channels.
- Tier 0 tools other than OpenRouter (search, scraping, proxies). In v1, org-level Tier 0 keys can be put in a role-scoped secret set by the admin, but per-user sub-keys come later.
- Reusing the Jarvis 2 secrets-controller core (DESIGN "Open").

## 3. Per-instance deployment

**What each instance needs**
- **Server host:** one small Linux box running the instance server, the tunnel and the database, in that organisation's own cloud account.
- **Cluster or not:** DESIGN says each instance has its own "server box and cluster". The plan follows Jarvis 1: single-node k3s with Flux and SOPS, reconciled from the instance deploy repo (decision 2 below confirms the details).
- **Session machine provider:** its own org or account, an API token held only by the server, and a per-org machine cap and budget.
- **Cloudflare:**
  - a zone for the instance hostname, Access with the Google Workspace identity provider, and a tunnel;
  - an Access policy (Workspace domain plus the service tokens for paired devices);
  - an API token scoped to Access service tokens only, for device pairing.
- **Identity provider:** a Google Workspace domain, the groups `jarvis-admin` and `jarvis-staff`, and a service account with read-only Directory access (domain-wide delegation, user and group-member read scopes only).
- **GitHub org:** the org-env repo and the instance deploy repo, plus a read-only deploy key or GitHub App installation for the server's org-env access.
- **OpenRouter account:** a provisioning key held only by the server (on the organisation's own account, or for a while on the operator's, DESIGN "Instance isolation"), billing and an account-level cap.
- **Archive storage:** an S3-compatible bucket for snapshots, archives and personal-layer versions, with credentials held by the server only.
- **Secrets:** an age key for SOPS (kept in the admin's password manager), the server's database encryption key and the k8s admin token. Infrastructure credentials (Tier 3) are never readable by any session.

**Per instance, outside this repo.** Which accounts an organisation has, which are hosted inside an operator's accounts for now, its identity domain and test identity, and its role definitions live in that organisation's private instance repo (docs/DEPLOY.md lists what it holds). Still open per instance (DESIGN "Open"): role definitions and the first Tier 2 actions (`admin` and `staff` are enough for v1), and whether the Jarvis 2 core is reused.

## 4. Decisions made before coding

1. **Server stack.**
   - (a) TypeScript on Node: port only the needed Jarvis 1 libraries to TS, and share API types with the app.
   - (b) Plain JavaScript on Node/Express, copying Jarvis 1's libraries nearly as-is.
   - (c) Go, in the style of Jarvis 2's core.
   - **Recommendation: (a).** The app, Paseo and its client package are all TypeScript, and shared types make the authorisation tests and the app-server contract checkable. Jarvis 1's libraries port with little change.
2. **Cluster shape.**
   - (a) Single-node k3s with Flux and SOPS, as in Jarvis 1.
   - (b) Docker Compose on one box, with systemd and SOPS-decrypted env files.
   - (c) A managed platform for the server (for example a Fly app).
   - **Recommendation: (a).** DESIGN already says "server box and cluster", and Jarvis 1's bring-up scripts, Flux layout and security hardening (scoped `flux-applier`, the Pod Security guardrail) exist. v1 runs only the server, the tunnel and Flux.
3. **Session machine provider.**
   - (a) Fly Machines, in a Fly org per instance.
   - (b) Hetzner Cloud VMs.
   - (c) Pods on the instance cluster.
   - **Recommendation: (a), behind a small provider interface** (create, start, destroy, exec, list), with a local-Docker implementation for CI. Jarvis 1's lifecycle code, snapshot pause and budget guard are built for Fly; a microVM per session gives the isolation DESIGN assumes; and boot takes seconds. (b) boots slowly. (c) breaks "the machine is the sandbox" on a single node.
4. **Server host.**
   - (a) A Hetzner Cloud box in the instance's own Hetzner project.
   - (b) A small VM at the same provider as the machines.
   - (c) A Fly app (only if the cluster decision is (c)).
   - **Recommendation: (a).** It is cheap, it is what Jarvis 1 uses, and the bring-up scripts exist.
5. **How the app reaches session daemons.**
   - (a) The session dials out to the server, and the server proxies the app's WebSocket after the ownership check.
   - (b) A self-hosted Paseo relay on the instance's Cloudflare, with the server handing pairing offers only to owners.
   - (c) A public hostname per session behind Access.
   - **Recommendation: (a).** It is the only option where authorisation is checked on every connection and revoking a user takes effect at once. It also works with any machine provider and in CI. (b) uses long-lived pairing secrets, and (c) brings back Jarvis 1's per-origin problems.
6. **Where personal layers (and other instance state) are stored.**
   - (a) SQLite on the server's volume, continuously replicated to archive storage, with versions for Reset/Undo.
   - (b) Postgres.
   - (c) Objects in the archive bucket only.
   - **Recommendation: (a).** One file covers users, devices, tasks, keys, spend counters and layers. Replication gives point-in-time recovery, and it is simple at four users. Jarvis 1 already uses SQLite for search.
7. **How OpenRouter keys are minted.**
   - (a) A key per user, created lazily at the first task, monthly limit per role, an admin override per user.
   - (b) A key per user created at directory sync.
   - (c) A key per session with a share of the user's budget.
   - **Recommendation: (a).** It matches DESIGN (one key per user), avoids keys for people who never use Jarvis, and the limit lives in OpenRouter, so the cap holds even if the server is down.
8. **Roles from Google Workspace.**
   - (a) A Directory API poll with a read-only service account.
   - (b) The groups claim from Access's identity (Google Workspace identity provider with groups).
   - (c) An email-to-role list in instance config.
   - **Recommendation: (a).** It also detects suspension (offboarding) within minutes, which (b) only sees at the next login. Keep (c) as an admin bootstrap override.
9. **Cloudflare account.** Decided: the instance's own Cloudflare account, or the operator's while the organisation is hosted there, on a hostname of the organisation's domain.
10. **Archive storage.**
    - (a) Hetzner Object Storage in the instance's Hetzner project.
    - (b) Cloudflare R2 in the instance's Cloudflare account.
    - (c) A Hetzner Storage Box over WebDAV, as in Jarvis 1.
    - **Recommendation: (a) or (b)**, depending on decision 9. Both are S3-compatible with per-bucket keys. (c) ties the code to WebDAV and Jarvis 1's layout.
11. **App UI kit.**
    - (a) Jarvis screens built with Paseo's components.
    - (b) Port Jarvis 1's Radix-style kit into the fork.
    - **Recommendation: (a)**, for one consistent look, a smaller fork and an easier rebase.
12. **Model list and defaults.**
    - (a) A curated list in instance config, with one default (for example an `anthropic/claude-*` model through OpenRouter).
    - (b) Any OpenRouter model with tool calling.
    - **Recommendation: (a).** Non-technical users, predictable spend, and each model checked against OpenCode's model list as in the `openrouter-sessions` skill.
13. **Image visibility.**
    - (a) A public `DE0CH/jarvis3` and public GHCR images, with no instance data in them.
    - (b) Private, with a pull secret per instance.
    - **Recommendation: (a).** CI on a public repo gets free macOS runners for the app, and instances need no GitHub credential just to pull images.

## 5. Test strategy (CI only, never anyone's own devices)

**Unit tests (every push)**
- **Server:**
  - the authorisation matrix: every route and the daemon proxy, as owner, another staff member, admin, a suspended user, an unknown email, a revoked device token and a session token;
  - Access JWT checks with test-signed tokens (wrong audience, expired, missing email);
  - the directory-sync mapping (groups, suspension and its effects);
  - OpenRouter key minting, limit changes and revocation against a fake OpenRouter;
  - spend counters and pause at the cap;
  - layer assembly order, the shadowing rule and locked-policy precedence;
  - personal-layer edit, Reset, Undo and versioning;
  - the snapshot pause and resume state machine against a fake provider (in the style of Jarvis 2's `fakefly`).
- **App:** typecheck, vitest for the Jarvis planner and stores (as `jarvis-plan.test.ts` does today), and upstream's own tests, so a rebase that breaks Paseo is caught.

**Integration (every push, under 15 minutes)**
- Build the server and session images. Run the server with the local-Docker machine provider, a fake OpenRouter (an OpenAI-compatible stub that returns scripted assistant and tool-call turns) and a fake Access (test JWTs signed by a CI key).
- Check the full chain without a browser: New task, the machine boots, the layers are in the workspace in the right order, the daemon dials in, the proxied WebSocket chat round-trips, "remember" lands in the personal layer, then pause, resume (same conversation) and destroy (archive written to a MinIO container).

**End-to-end in a browser (every push)**
- Playwright against the integration stack, on the web build pinned in `APP_COMMIT`, with three identities: admin, staff A and staff B (the stand-in for the test identity). It checks:
  - A creates and chats with a task;
  - B can't see it in the list and gets 404 on the direct URL and the daemon WebSocket;
  - the admin sees both;
  - Reset and Undo;
  - the spend cap message.
- Screenshots in light and dark, phone and wide.

**Nightly, against real services**
- The same Playwright suite against a staging instance: an example org on a Cloudflare test hostname, with Access service tokens mapped to test users.
- It uses a real OpenRouter key with a hard USD 1 limit and the cheapest tool-calling model, and real Fly machines in a dedicated staging org with a low budget cap.
- The real Google login is not automated (Google blocks headless sign-in). The Google Workspace path is checked once by the admin signing in as the test identity in a second browser profile, which is DESIGN's employee view.

**iOS (on pushes to the fork that touch the app)**
- On `DE0CH/jarvis3-app`'s macOS runner: simulator build of the `jarvis3` variant, then Maestro flows against the staging instance using an end-to-end device token passed as launch arguments. The flows check paired, task list, open a task, send a message, see a reply.
- No TestFlight upload until distribution is decided. Never a person's own phone.

**Upstream merges (by hand)**
- When upstream is merged into `DE0CH/jarvis3-app` (on a branch, never a force-push), that repo's CI runs typecheck, unit tests and the web e2e; `APP_COMMIT` here moves to the merged commit only once that is green.
