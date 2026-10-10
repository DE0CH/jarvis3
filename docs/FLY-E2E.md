# The real-Fly end-to-end run

`integration/fly-e2e.sh` runs one task through its whole life on real Fly Machines and a real
OpenRouter model: create → Fly machine boots → layers load → first prompt answered → chat through the
server's daemon proxy → pause (snapshot, machine destroyed) → resume (new machine, same conversation)
→ delete (archive) → no machine left. CI covers the same chain on the local-Docker provider
(`integration/integration.test.ts`); this run is manual, because it needs real credentials and costs a
little money.

## What is real and what stands in

| part | in this run |
|---|---|
| the instance server | in-process (`createJarvis`), with `FlyMachines` from `server/src/fly.ts` |
| session machines | Fly Machines in the instance's existing session app |
| session image | the pinned `SESSION_IMAGE` from GHCR (never `:main`) |
| model and keys | OpenRouter: the server mints the user's key with the management key (limit `E2E_KEY_LIMIT_USD`, default 1), the run deletes it at the end |
| public hostname | a Cloudflare quick tunnel (`trycloudflare.com`, no account) to the local server: the sessions' `JARVIS_URL` |
| bucket | `versitygw` on a temp dir, behind a second quick tunnel, so the machines can use presigned URLs |
| Cloudflare Access | test-signed JWTs and the session gate turned into a gate JWT in front of the server, as in `integration/stack.ts` |
| org-env repo | a local bare repo with `ORG_FILES` |

The run never creates or deletes the Fly app (one persistent app per instance, made by the operator)
and touches only machines whose metadata says `jarvisInstance: flye2e`. A token scoped to that one app
is enough. Everything it makes (machines, the OpenRouter key, tunnels, the bucket dir) is torn down in a
`finally`, also on failure.

## Running it

Needs node ≥ 22.18, git, `cloudflared` and `versitygw` on `PATH` (both are in Jarvis 1's session image).

```bash
FLY_API_TOKEN=… FLY_ORG=personal FLY_APP=kamyee-jarvis3-sessions \
OPENROUTER_MANAGEMENT_KEY=… SESSION_IMAGE=ghcr.io/de0ch/jarvis3-session:<12 hex> \
E2E_REPORT=/tmp/fly-e2e.json integration/fly-e2e.sh
```

Optional: `E2E_FLY_REGION` (`lhr`), `E2E_MODEL` (`google/gemini-2.5-flash-lite`), `E2E_KEY_LIMIT_USD`.
It prints PASS/FAIL per step and a JSON report (also written to `E2E_REPORT`): step results, timings,
machine-seconds and their cost at the server's own rates (`server/src/spend.ts`), and what the model
cost (the key's usage, read before it is deleted). It prints no secret.

From a Jarvis 1 session the credentials are in the `default` store as `KAMYEE_FLY_TOKEN` (an
attenuated token: the Fly org token plus an `Apps` caveat for `kamyee-jarvis3-sessions` alone),
`KAMYEE_FLY_ORG`, `KAMYEE_FLY_APP` and `KAMYEE_OPENROUTER_PROVISIONING_KEY`; run the script through
`pull-secrets --exec` with a small wrapper that maps them to the names above.

## Gotchas

- **A machine created with `skip_launch` is `created` until Fly has prepared it**, and a start then
  answers 412 "unable to start machine from current state: 'created'". `FlyMachines.start` waits on
  `/wait?state=stopped` and retries. This was the one provider bug the first real run found.
- **cloudflared prints the quick-tunnel URL before the edge serves it.** Resolving the name that early
  gets an NXDOMAIN that the resolver caches for minutes; the script waits for "Registered tunnel
  connection".
- **versitygw refuses a sidecar dir whose path starts with the root's path** (`s3meta` next to `s3`).
- **A Fly account flagged "high risk"** refuses app creation (422, `fly.io/high-risk-unlock`) even with
  billing `CURRENT`. Machines in an existing app still work.

## Results

2026-10-10, image `0c882b86a175`, app in `lhr`, `shared-cpu-2x` / 2 GB, `google/gemini-2.5-flash-lite`:
all 10 steps passed, 132 s wall clock.

| measure | seconds |
|---|---|
| create → Fly machine `started` | 17.7 |
| create → session dialled in (task `running`) | 33.7 |
| dialled in → first answer seen | 18.0 |
| chat turn through the daemon proxy | 2.1 |
| pause (11 MB snapshot, machine destroyed) | 8.2 |
| resume → machine `started` / dialled in | 14.9 / 33.0 |
| resumed chat turn (the model recalled the first reply) | 7.9 |
| delete (archive, machine destroyed) | 10.2 |

Cost: 113 machine-seconds, USD 0.00052 at the server's rates (Fly bills per second; the run's share
can't be isolated on the org's invoice). OpenRouter: USD 0.0142 on the user's key.
