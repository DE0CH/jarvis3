# Tier 0 tools: web search, page fetching, proxies

DESIGN "Secrets and capabilities", Tier 0: always on, never asked about, with per-user hard monthly
caps. Every session gets them without a prompt or an approval; the organisation's provider keys
never enter a machine.

## How a cap stays hard

| tool | how it is capped | what the machine holds |
|---|---|---|
| web search | **server-metered**: the server calls the provider with the organisation's key | nothing |
| page fetch | **server-metered**, the same way | nothing |
| proxy, `subuser` providers (IPRoyal) | **per-user sub-account**: the provider stops it at its GB allocation | the owner's own capped sub-account login, in jarvis-agent's env only |
| proxy, `relay` providers (Evomi, any HTTP proxy) | **server-metered relay**: the server opens every tunnel with the org login and counts the bytes | nothing |

**Metering.** Before a search or fetch goes out, the server reserves the most that call can cost
(the adapter's `maxCostUsd`: list price times the dearest options asked for) against the user's
monthly cap and, if set, the instance's (`tools.monthlyUsd`), in one SQLite transaction. A call
that doesn't fit is refused with 429 `tools_cap` and never reaches the provider, so concurrent calls
can't overshoot together. After the call the reservation is settled with the real cost (Exa's
`costDollars`, ScrapingBee's `Spb-cost` credits, Tavily's `usage.credits`; a flat price for Brave),
never more than was reserved; a failed call costs nothing. Reservations left by a crash count at
their reserved cost.

**Sub-accounts.** On the owner's first task the server creates a sub-account named
`<instanceName>-<userId>` with the month's cap in GB, sealed in the database like the OpenRouter
key. The provider has no monthly reset, so the server sets the available GB itself: at the month's
turn back to the full cap, and at once when an admin changes the cap (cap minus this month's use).
Use is read back every 15 minutes. Offboarding deletes the sub-account (IPRoyal returns its unused
GB to the account). A cap of 0 means no proxy for that user; `null` (no cap) is refused at start-up
for a subuser provider, because the allocation has to be a number.

**Relay.** jarvis-agent runs an HTTP proxy on `127.0.0.1:3128` in every machine. In relay mode each
tunnel is one WebSocket to `/api/session/proxy?host&port[&country][&session]` with the session
token; the server opens the tunnel through the provider, answers `{"ok":true}`, then relays binary
frames, writing the bytes to the ledger every 8 MB and at close. The tunnel closes (4029) when the
month's GB are used up, and new tunnels get 429. Ports are limited to 80, 443, 8080 and 8443.

Either way the agent sees one thing: `$JARVIS_PROXY_URL` (`http://127.0.0.1:3128`), with targeting
in the proxy user name (`http://country-de:x@127.0.0.1:3128`, `country-us-session-ab12cd34`). The
server's `ProxyTargetingTemplate` turns that into the provider's own syntax (IPRoyal and Evomi put
it on the password).

## What the agent gets

- OpenCode tools `web_search` and `web_fetch` in the policy plugin (`session-image/lib/opencode-plugin.mjs`).
  A fetched page is saved under `~/workspace/.web/` and its first 30,000 characters are returned.
- The shell command `jarvis-web search|fetch|proxy|usage`, for scripts.
- A paragraph in the platform preamble and a built-in skill `jarvis-web` (skipped when a layer has a
  skill of that name). Both are written only when the instance has a tool.
- Everything goes through jarvis-agent's socket, which adds the session token; a cap refusal reaches
  the agent as "Not done: … Tell the user; don't try to get around it."
- The tools are not exempt from guards: a locked-policy rule can name `web_fetch` or `*`.

## Configuration

Absent `tools` (or a kind left out) = that tool is off. Once a kind is configured, every role must
say its cap explicitly (`null` = no cap), so a forgotten field can't mean "unlimited". Full field
list: [CONFIG.md](CONFIG.md).

```json
"roles": {
  "admin": { "openrouterMonthlyUsd": 100, "machineHoursPerMonth": null, "admin": true, "toolsMonthlyUsd": 20, "proxyMonthlyGb": 2 },
  "staff": { "openrouterMonthlyUsd": 20, "machineHoursPerMonth": 60, "toolsMonthlyUsd": 5, "proxyMonthlyGb": 1 }
},
"tools": {
  "search": { "provider": "exa", "credential": "EXA_API_KEY" },
  "fetch": { "provider": "scrapingbee", "credential": "SCRAPINGBEE_API_KEY", "pricing": { "perCreditUsd": 0.000196 } },
  "proxy": { "provider": "iproyal", "credential": "IPROYAL_API_TOKEN" },
  "monthlyUsd": 100
}
```

## Providers

| kind | `provider` | credential (env var named by `credential`) | price used (override with `pricing`) | per-user keys at the provider? |
|---|---|---|---|---|
| search | `exa` | Exa API key | `costDollars` from each answer; reserve USD 0.007 + 0.001 per result over 10 (+ 0.001 per result with text) | yes, with Team Management (enabled by Exa support): not used yet |
| search | `brave` | Brave Search subscription token | USD 0.005 per call | no |
| search | `tavily` | Tavily API key | `usage.credits` × USD 0.008 | Enterprise plan only |
| fetch | `scrapingbee` | ScrapingBee API key | `Spb-cost` credits × `perCreditUsd` (default 0.000196, the USD 49 / 250k plan); 1 plain, 5 render, 10 premium, 25 both | no |
| fetch | `exa` | Exa API key | `costDollars`; text only | (as above) |
| proxy | `iproyal` (subuser) | IPRoyal residential API token | provider-capped GB | yes: residential sub-users |
| proxy | `evomi` (relay) | `username:password` of the org's Evomi proxy | USD 0.45/GB | no |
| proxy | `http` (relay) | `username:password`; `settings.host`, `settings.port`, `settings.targeting` | `pricing.perGbUsd` | — |

Provider facts (checked 2026-10-10): Brave, ScrapingBee, Firecrawl, ZenRows, SerpApi and Serper.dev
have no API for per-user keys with a cap, Evomi and Bright Data none for capped sub-users; their caps
can only be kept on the server. Oxylabs residential sub-users (`traffic_limit`, `auto_disable`) would
fit the `subuser` interface. OpenRouter's own `openrouter:web_search` server tool bills the user's
already-capped OpenRouter key, so it needs no Tier 0 key at all, but it returns a model's answer, not
results.

**Adding a provider:** an adapter implementing `SearchProvider`, `FetchProvider` or one of the proxy
interfaces in `server/src/tools/types.ts`, one line in `server/src/tools/registry.ts`, and a test
with a fake `fetch` in `server/test/tools-adapters.test.ts`. `maxCostUsd` must be an upper bound:
the user is never charged more than it, so a low one leaks spend past the cap.

## API

[API.md](API.md) section 12. Users see their own use (`tools` in `GET /api/me` and
`GET /api/users/:id`), admins everyone's and the totals (`GET /api/admin/tools`); admins set
per-user caps with `PATCH /api/users/:id/limits` (`toolsMonthlyUsd`, `proxyMonthlyGb`). The ledger
keeps no query text or URL, only the tool, provider, cost, bytes and month.

## Tests

- `server/test/tools.test.ts`: metering, the hard cap (also with eight concurrent calls), the
  instance cap, failures, sub-accounts (mint, monthly refill, cap change, offboarding), the relay
  (bytes, cap closes the tunnel, target checks), who sees whose usage.
- `server/test/tools-adapters.test.ts`: each adapter's requests and cost reading; the key never in
  an error.
- `server/test/authz.test.ts`: the new routes and the relay for every kind of caller.
- `session-image/test/web.test.mjs`, `proxy.test.mjs`: the OpenCode tools, the skill and preamble,
  the local proxy in both modes.
- `integration/`: the real image against stand-in providers (`integration/stub-providers.ts`):
  `web_search`, `web_fetch`, `jarvis-web`, `curl` through the relayed proxy, the cap, and no key or
  login anywhere in the machine.
