# Actions, guards and approvals (operator guide)

How an instance's admin sets up what stops for an approval. The design is DESIGN.md "Secrets and
capabilities" and "Actions and approvals"; the routes are [API.md](API.md) section 11.

Two mechanisms stop an agent:

- **Named actions** (the broker): Tier 2 and Tier 3 operations that need a credential the session
  machine must never hold. The server holds the credential and runs the action itself, after the
  action's policy or a person approves it. Configured in the instance config (`actions`).
- **Guards** (the locked-policy hook): tool calls the agent *can* make with what its machine holds
  (its own accounts, Tier 0/1 tools) but that are outward-facing, like a CLI that sends mail from
  the user's own mailbox. A guard stops the call until someone approves it. Configured in the
  org-env repo (`policy/guards.json`).

There are no other prompts: OpenCode runs with `allow`.

## Named actions (`actions` in the config)

```json
"owner": "it-admin@example.org",
"actions": {
  "support_email": {
    "type": "smtp.send",
    "label": "Email from the support mailbox",
    "description": "Replies to customers",
    "roles": ["*"],
    "approval": "admin",
    "auto": { "allowList": ["*@example.org"] },
    "settings": { "host": "smtp.example.org", "port": 465, "security": "tls", "from": "support@example.org", "fromName": "Example Support" },
    "credentials": { "user": "SUPPORT_SMTP_USER", "password": "SUPPORT_SMTP_PASSWORD" }
  },
  "set_budget": { "type": "instance.set_budget", "label": "Change the instance budget", "roles": ["admin"] }
}
```

| field | meaning |
|---|---|
| key | the action's name (`[a-z0-9_]{1,64}`); the agent calls it by this name |
| `type` | a built-in type (below) |
| `label`, `description` | what people and the agent see |
| `roles` | roles whose tasks have it (`"*"` = all). Others can ask for access |
| `approval` | who approves when no auto rule matches: `self` (the task's owner, for actions on their own accounts), `admin` (default), or `auto` (never asks). Ignored for Tier 3 types, which always need the owner |
| `auto.allowList` | auto-approve when every subject matches (`x@example.org` exactly, `*@example.org` a whole domain); for `smtp.send` the subjects are all recipients |
| `auto.below` | auto-approve when the call's amount is under this number (types with an amount) |
| `settings` | type-specific |
| `credentials` | credential name → environment variable on the server. The server refuses to start when one is missing. Keep them in the instance's SOPS secrets, like every other server secret |

`owner` (an admin's email) is the only person who can approve Tier 3 actions.

### Built-in types

| type | tier | params | settings / credentials |
|---|---|---|---|
| `smtp.send` | 2 | `to` (≤ 20), `cc`, `subject` (one line), `text` | `host`, `port`, `security` (`tls`, `starttls`, `none` for a local relay only), `from`, `fromName`; credentials `user`, `password` |
| `instance.set_budget` | 3 | `monthlyUsd` (number or null) | none. Overrides `budget.monthlyUsd` until changed again |

A new type is a file in `server/src/actions/` implementing `ActionType` (params, `validate`,
`preview`, optional `subjects`/`amount` for the policy, `run`) and one line in its registry. Keep
`preview` complete: it is what the approver sees, and the only thing they agree to.

### Tier 3

Tier 3 types change the instance itself. Only tasks of an admin role can ask for them (an access
request can't grant one), and only the owner approves, with a passkey that requires user
verification. The owner adds the passkey once per device from the app (Settings → Passkey), signed
in with the identity provider (a paired device's token can't add one). The approval signs a hash of
exactly the change shown.

## Guards (`policy/guards.json` in the org-env repo)

```json
[
  { "id": "own-mail", "tool": "bash", "match": "\\bgmail-send\\b", "approval": "self", "label": "Send an email from your own mailbox" },
  { "id": "public-post", "tool": "*", "match": "api\\.social\\.example", "approval": "admin", "label": "Post publicly" }
]
```

| field | meaning |
|---|---|
| `id` | `[a-z0-9][a-z0-9-]{0,63}`, unique |
| `tool` | the OpenCode tool (`bash`, `webfetch`, `edit`, …) or `*` |
| `match` | a regular expression, case-insensitive, searched in the bash command (for `bash`) or in the tool call's JSON arguments |
| `approval` | `self` or `admin` |
| `label` | what the approver sees as the summary; the full command is shown below it |

Only the policy layer can define guards. A guard is defence in depth: the agent's user owns its
OpenCode config and could in principle remove the plugin, so anything that must never happen
without approval belongs behind a named action, whose credential the machine never holds.

## In the session

The image's OpenCode plugin (`session-image/lib/opencode-plugin.mjs`) gives the agent four tools,
`jarvis_actions`, `jarvis_action`, `jarvis_request_access` and `jarvis_ask_boss`, and applies the
guards. Each waits for the decision, then tells the agent the outcome; a denial is final.
