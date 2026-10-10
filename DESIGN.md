# Jarvis 3 — design

Status: design agreed 2026-10-08; v0.1 of the server, session image, app variant and deployment is
built (docs/), actions and approvals (docs/ACTIONS.md), and the Tier 0 web tools (docs/TOOLS.md). Jarvis 1 and Jarvis 2 (`DE0CH/jarvis2`) are separate projects and stay as they are;
Jarvis 3 is a new codebase.

## What Jarvis 3 is

A self-hosted agent platform for an **organisation**: people press "New task", an agent runs in its own
machine with the organisation's tools and skills loaded, and anything risky goes through policy and, where
needed, an approval. It is built for non-technical users: nobody but the organisation's admin ever sees
git, secret stores, harness permission prompts or infrastructure.

**One codebase, many instances.** Each organisation runs its own instance: a small company (an admin
and a few employees), or one person (a personal instance is an organisation with one member, its
owner as admin). There is no special "personal" mode.

The code lives in `DE0CH/jarvis3`. An instance deploys from it with its own config, kept in that
organisation's private instance repo (docs/DEPLOY.md).

**User data never mixes.** An instance holds its own organisation's people, documents, sessions and
secrets, and nothing of them reaches another instance or another app, whatever infrastructure they
share. No organisation's data goes into this repo.

## Instance isolation

**What may share infrastructure.** Infrastructure for things only the operator uses (a one-person
instance, the operator's own experiments) stays separate from everything else. Things with other
users (a multi-user instance, another multi-user app of the operator's) may share infrastructure,
provided user data never mixes between them: an instance's box may also run such an app, in its own
namespace with its own data, its own tunnel hostname and Access app, and neither can reach the
other's data (docs/DEPLOY.md, "Extra apps"). Billing may be shared (for example OpenRouter on the
operator's own account, below).

Why the line falls there: an instance with other users must be stable and well designed and must not
break under them, while the operator's own setup is where new infrastructure gets tried, and an
experiment may break everything. An experiment must never be able to take down the tools used to fix
things, so the two never share infrastructure. Once Jarvis 3 is stable the operator moves onto an
instance of it too (dogfooding); until then the operator's experimental infrastructure (Jarvis 1 and
Jarvis 2) stays separate.

By default each instance has its own:

- server box and cluster, its own session-machine provider org, its own Cloudflare Access apps, its own
  GitHub org for its env repo and its own OpenRouter provisioning key (as its own accounts, or as
  separate spaces inside an operator's accounts, below);
- identity provider (for example the organisation's Google Workspace);
- org-env repo, secrets and backup and archive storage.

**Hosting inside an operator's accounts.** A multi-user instance's provider resources may live, for a
while, in the provider accounts and orgs of the person who operates it, with shared billing: a GitHub
org for the organisation, a separate Hetzner project, Access apps for the organisation's own hostname
in the operator's Cloudflare account, the session machines in a Fly app of their own inside one of the
operator's Fly orgs, and the provisioning key on the operator's own OpenRouter account. Every key the
instance server holds is scoped to the instance's own pieces (its project, its zone's Access apps, its
Fly app, its bucket), never account-wide, with one exception: an OpenRouter provisioning key can list
and delete every key on the account, so it is held by the instance server only, like the other Tier 3
credentials. The instance still mints each user's OpenRouter key with its monthly limit from it. A Fly
org's budget and machine caps also cover the instance's app when they share the org. Which accounts a
given instance uses is recorded in its private instance repo, not here. Moving to the organisation's own
accounts later costs:

- GitHub: add owners to the org. Hetzner: rebuild the box from git and copy the bucket and SQLite file. Fly: nothing
  to move (machines are disposable).
- Cloudflare: every staff device signs in and pairs again once (service tokens belong to the account).
- OpenRouter: staff keys are re-minted by the server from the new account's provisioning key; credit doesn't move.
- iOS: TestFlight builds don't transfer between developer accounts; after the app moves to the organisation's own
  account, staff install it once more.

Never under a personal account, even for a while: the Google Cloud project for staff OAuth (Tier 1)
lives inside the organisation's Workspace, so the app is "internal". Under a personal account it
would be "external": Gmail scopes need Google's verification and a paid security assessment, and in
testing mode the logins expire every 7 days.

## Harness and models

- **Harness: OpenCode**, driven by a **Paseo** daemon in each session machine. There is no Claude Code harness
  and no Claude front end.
- **Models: OpenRouter only**, including the Claude models (`anthropic/claude-*`) through OpenRouter.
- **One OpenRouter key per user**, minted by the instance with a credit limit, so spend is capped,
  attributable and revocable per person.
- **Sessions run with OpenCode's permissions set to allow.** The machine is the sandbox: what a session may do
  is decided by what the machine holds, not by per-command prompts (see "Actions and approvals").

## Front end: one app, web + iOS

Paseo (Apache-2.0) with the Jarvis dashboard folded in, in its own repo `DE0CH/jarvis3-app`: one Expo app that is both the instance's web page and the iOS app. It holds sign-in, New task, the
session list and chat, the user's files, "My instructions & skills", Reset to company default, and the
approval queue.

**iOS distribution:** TestFlight on the operator's developer account while the organisation is hosted
there (see "Instance isolation"); then the organisation's own Apple **organisation** developer account
(D-U-N-S number + public website), distributed privately as an **Apple Business custom app**. Not
available to a small company: the Enterprise Program (Apple requires 100+ employees).

## Identity

- The instance's identity provider is the only login, for example **Google Workspace**; groups map to
  roles (`admin`, `staff`, and more as needed). Suspending a Workspace account offboards that person from everything.
- Cloudflare Access sits in front of every hostname with the identity provider as its login. The app pairs
  each device once (identity login → per-device service token), as Jarvis 1's app does.
- **Every API call is authorised per user.** Access only says "this is a member"; the instance decides what
  that member may see and do. A user never sees, starts, messages or reads another user's sessions, files,
  wakeups or channels. The admin sees everything (staff are told this in writing).

## Employee view (for the admin to develop and debug)

The admin tests the staff experience with a **separate test identity**: an ordinary user in the
organisation's identity provider, in the staff group, with the same kind of licence a real employee has
(for example `test-staff@example.org` with a paid Workspace seat, so its own Gmail, Drive and Calendar
work too). The admin signs in as it in a second browser profile or on a second device and runs the
whole chain as staff do: identity login, Access, device pairing, the staff role and capabilities, and
approvals that arrive at the admin's own account. Jarvis 3 has no impersonation or "view as" mode.

## Environment layers (what a session loads)

1. **Org layer — the org-env repo** (in the organisation's GitHub org, for example `<org>-env`).
   Rules, skills, scripts. Only admins change it.
2. **Locked policy** — rules no other layer can override (which actions need approval, what is forbidden).
3. **Role layer** — what a role's sessions get (skills, capabilities).
4. **Personal layer** — per user, stored by the instance (not in git): the user's own instructions, skills
   and "remember this" notes. The agent writes to it when the user says "remember…"; the app shows it as a
   plain list to read and delete from.

Buttons:

- **Reset to company default** — archives the personal layer (undoable) and starts empty.
- **Suggest for everyone** — on a personal skill: opens a pull request on the org-env repo for an admin.

## Secrets and capabilities

Principle: **raw secrets never enter a staff session; capabilities do.** Users never choose secret stores; a
user's role determines what their machines hold.

- **Tier 0 — always on, never asked about.** Search, scraping, proxies, OpenRouter, document tools. Per-user
  sub-keys with hard spend caps wherever the provider supports them; otherwise the server meters the calls with
  the organisation's key, which never enters a machine (search, fetch and proxies: docs/TOOLS.md).
- **Tier 1 — the user's own accounts.** Their Workspace mail, Drive, Calendar via OAuth consent they give
  once. Theirs, so they act freely (outward actions still confirm, below).
- **Tier 2 — shared company assets.** Bank, company card, registrar, admin consoles, customer-data exports.
  Never in a machine's env. A **broker** holds them and exposes named actions (`pay_invoice(vendor, amount)`,
  `export_customers(fields)`), each with a policy: auto under a threshold / on an allow-list, otherwise an
  admin approval.
- **Tier 3 — infrastructure.** The instance's own servers, keys, identity-provider admin, org-env write,
  billing. Admin only, never in any staff role; enforced in the core, not by convention.

## Actions and approvals

- No harness permission prompts. Only outward-facing or irreversible actions stop, via the broker or a
  locked-policy hook: sending mail outside the company, paying, deleting shared files, posting publicly,
  contacting a person, data leaving the company.
- Three kinds of stop:
  - **Self-confirm** — one tap by the user, for actions on their own accounts. The prompt shows exactly what
    will happen ("Send this email to x@y.com", with a preview).
  - **Admin approval** — one tap by an admin in the app: money over the threshold, a new vendor, data leaving
    the company, a capability the role lacks. No Face ID: the signed-in, paired device is enough.
  - **Tier 3 change** — Face ID on the owner's phone, and only the instance's owner can approve. The approval shows exactly
    the change being signed.
- **Asking for access:** a session that needs something its role lacks files a request with a reason. The
  admin grants it for that session or for the role. Over time roles settle and requests become rare.
- **Ask the boss:** for judgement calls the agent drafts a question; the admin answers in the app.
- All approvals land in one queue in the app, plus a notification.

## Spend

Per-user monthly caps on model spend (the OpenRouter key limit) and on machine time; the instance pauses a
user's sessions at their cap and tells them and the admin.

## Offboarding

Suspend the person in the identity provider → Access refuses them; the instance revokes their sub-keys,
archives and destroys their sessions, and keeps their personal layer and archive for the organisation.

## Open

- When an organisation hosted in an operator's accounts moves to accounts of its own (per instance).
- Role definitions and the first Tier 2 actions (per instance).
- Archive storage per instance.
- Whether the Jarvis 2 secrets-controller core is reused once it exists.

## Implementation decisions (2026-10-08)

- Server: TypeScript on Node.
- Each instance's server: single-node k3s + Flux + SOPS.
- Session machines: Fly Machines, one Fly org per instance (behind a small provider interface, local Docker in CI).
- The app reaches a session's agent through the instance server: the session dials out, the server checks
  ownership on every connection and forwards the chat. No Paseo relay, no per-session web addresses.
- Instance state: one SQLite file on the server's volume, continuously replicated to the instance's bucket.
- Per-user OpenRouter keys: minted on the user's first task, monthly limit per role, admin override per
  person, deleted at offboarding.
- Code and container images are public; no organisation's data lives in this repo (instance config and
  org-env live in each organisation's own GitHub org).
- App: the repo DE0CH/jarvis3-app, made from upstream getpaseo/paseo (upstream comes in by merge, by hand, when wanted; no automatic updates, never a force-push). Jarvis screens use Paseo's own components. The instance server serves its web build at the instance's root; the build is pinned by commit (`APP_COMMIT`).
- Roles: a read-only Google service account polls the Workspace directory every few minutes (groups →
  roles, suspended users cut off within minutes).
- Cloudflare Access and tunnel: in the instance's Cloudflare account (or the operator's, while hosted there), on the
  organisation's own hostname.
- Storage: Hetzner Object Storage in the instance's own Hetzner project.
- Models: a curated list per instance with one default, each checked against OpenCode tool calling.
