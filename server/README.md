# Jarvis 3 instance server

TypeScript on Node 22 (run by type stripping, no build step), `node:sqlite` for state, `jose` for
JWTs, `ws` for WebSockets, `aws4fetch` for S3. See [`../docs/API.md`](../docs/API.md) for the API,
[`../docs/CONFIG.md`](../docs/CONFIG.md) for configuration, [`../docs/DEPLOY.md`](../docs/DEPLOY.md)
for what a deployment needs, and [`../docs/OPEN.md`](../docs/OPEN.md) for choices still open.

```bash
npm ci
npm test          # typecheck + every test (node:test), all against in-memory fakes
npm start         # needs JARVIS_CONFIG and the secret env vars (docs/CONFIG.md)
```

| file | what |
|---|---|
| `src/api-types.ts` | the API contract (types only; the app imports it) |
| `src/auth.ts` | Access JWT verification, principals, the one `authorize()` |
| `src/http.ts` | routes and WebSocket upgrades |
| `src/tasks.ts` | task lifecycle: create, pause (snapshot → destroy), resume, destroy (archive first) |
| `src/channel.ts` | session reverse channel + daemon proxy |
| `src/users.ts` | directory sync, offboarding, devices, limits |
| `src/userkeys.ts` | per-user OpenRouter keys |
| `src/spend.ts`, `src/ticks.ts` | machine-hour caps, instance budget, idle auto-pause |
| `src/layers.ts` | personal layer store, Reset/Undo, layer assembly |
| `src/providers.ts` | interfaces to the outside world; real ones in `fly.ts`, `s3.ts`, `openrouter.ts`, `directory-google.ts`, `cloudflare-devices.ts`, `orgenv-git.ts`; fakes in `src/fakes/` |
| `src/db.ts` | SQLite schema and migrations |
