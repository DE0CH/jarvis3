# Jarvis 3 — design

Status: design agreed in conversation between Deyao and Claude, 2026-10-08. Nothing is built yet.
Jarvis 1 (claude-env `selfhost/`) and Jarvis 2 (`DE0CH/jarvis2`) are separate projects and stay as
they are; Jarvis 3 is a new codebase.

## What Jarvis 3 is

A self-hosted agent platform for an **organisation**: people press "New task", an agent runs in its own
machine with the organisation's tools and skills loaded, and anything risky goes through policy and, where
needed, an approval. It is built for non-technical users: nobody but the organisation's admin ever sees
git, secret stores, harness permission prompts or infrastructure.

**One codebase, many instances.** Each organisation runs its own instance:

- **KAMYEE** — Deyao's company: Deyao (admin) + three employees.
- **Deyao's personal instance** — logically a one-person company, Deyao as admin and only member.

There is no special "personal" mode: the personal instance is just an organisation with one member.

The code lives in `DE0CH/jarvis3` (Deyao's). An instance deploys from it with its own config.

**Never mix organisations.** Deyao works for more than one company. Each instance holds only its own
organisation's people, data, accounts and secrets. Nothing of one organisation (accounts, documents,
contacts, skills that name its business) goes into another's instance, env repo or prompts.

## Instance isolation

Instances share code only. Each has its own:

- server box and cluster, its own session-machine provider org, its own Cloudflare account/Access, its own
  GitHub org for its env repo, its own OpenRouter account, and billing;
- identity provider (KAMYEE: Google Workspace on `kamyeegroup.com`);
- org-env repo, secrets and archive storage.

A compromise of one instance never reaches another.

Current exceptions (Deyao, 2026-10-08): KAMYEE's accounts bill to Deyao's personal card for now, and
`kamyeegroup.com` stays registered in Deyao's own Cloudflare account. The first KAMYEE account created is
Google Workspace; the other provider accounts come later.

## Harness and models

- **Harness: OpenCode**, driven by a **Paseo** daemon in each session machine. There is no Claude Code harness
  and no Claude front end.
- **Models: OpenRouter only**, including the Claude models (`anthropic/claude-*`) through OpenRouter.
- **One OpenRouter key per user**, minted by the instance with a credit limit, so spend is capped,
  attributable and revocable per person.
- **Sessions run with OpenCode's permissions set to allow.** The machine is the sandbox: what a session may do
  is decided by what the machine holds, not by per-command prompts (see "Actions and approvals").

## Front end: one app, web + iOS

A fork of Paseo (Apache-2.0; Deyao's `DE0CH/paseo` already talks to Jarvis) with the Jarvis dashboard folded
in: one Expo app that is both the instance's web page and the iOS app. It holds sign-in, New task, the
session list and chat, the user's files, "My instructions & skills", Reset to company default, and the
approval queue.

**iOS distribution, KAMYEE:** only through KAMYEE's own Apple **organisation** developer account
(D-U-N-S number + public website), distributed privately as an **Apple Business custom app**. Staff use the
web page until that is in place. Not available: the Enterprise Program (Apple requires 100+ employees).

## Identity

- The instance's identity provider is the only login. KAMYEE: **Google Workspace**; groups map to roles
  (`admin`, `staff`, and more as needed). Suspending a Workspace account offboards that person from everything.
- Cloudflare Access sits in front of every hostname with the identity provider as its login. The app pairs
  each device once (identity login → per-device service token), as Jarvis 1's app does.
- **Every API call is authorised per user.** Access only says "this is a member"; the instance decides what
  that member may see and do. A user never sees, starts, messages or reads another user's sessions, files,
  wakeups or channels. The admin sees everything (staff are told this in writing).

## Employee view (for the admin to develop and debug)

The admin tests the staff experience with a **separate test identity**: an ordinary user in the
organisation's identity provider, in the staff group, with the same kind of licence a real employee has
(KAMYEE: `test-staff@kamyeegroup.com`, a paid Workspace Business Starter seat, so its own Gmail, Drive and
Calendar work too). The admin signs in as it in a second browser profile or on a second device and runs the
whole chain as staff do: identity login, Access, device pairing, the staff role and capabilities, and
approvals that arrive at the admin's own account. Jarvis 3 has no impersonation or "view as" mode.

## Environment layers (what a session loads)

1. **Org layer — the org-env repo** (KAMYEE: `kamyee-env` in KAMYEE's GitHub org; Deyao's instance: the
   successor of `claude-env`). Rules, skills, scripts. Only admins change it.
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
  sub-keys with hard spend caps wherever the provider supports them.
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
  - **Tier 3 change** — Face ID on the admin's phone, and only Deyao can approve. The approval shows exactly
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

- Machine provider and server host for each instance (KAMYEE's own accounts, created after Workspace).
- Role definitions and the first Tier 2 actions KAMYEE needs.
- Archive storage per instance.
- Whether the Jarvis 2 secrets-controller core is reused once it exists.
