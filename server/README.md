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

The image (`ghcr.io/de0ch/jarvis3-server:<commit>`, `Dockerfile`) also serves the app's web build
at the root, from `JARVIS_WEB_DIR` (`/app/web` in the image). The build comes from
[DE0CH/jarvis3-app](https://github.com/DE0CH/jarvis3-app) at the commit pinned in
[`../APP_COMMIT`](../APP_COMMIT); CI builds it (`.github/workflows/server.yml`), and
`../scripts/build-web.sh` does the same locally into `web-dist/` before a `docker build server`.
To ship a newer app, change `APP_COMMIT` to a commit whose jarvis3-app CI is green.

| file | what |
|---|---|
| `src/api-types.ts` | the API contract (types only; the app imports it) |
| `src/auth.ts` | Access JWT verification, principals, the one `authorize()` |
| `src/http.ts` | routes, the HTTP relay to the daemon, and WebSocket upgrades |
| `src/web.ts` | the app's web build at the root (`JARVIS_WEB_DIR`) |
| `src/notices.ts` | in-app notices and their read marks |
| `src/tasks.ts` | task lifecycle: create, pause (snapshot → destroy), resume, destroy (archive first); rename and messages from the app |
| `src/projects.ts` | Projects: repos + sealed secrets, who sees and changes them, what a task's machine gets |
| `src/channel.ts` | session reverse channel + daemon proxy |
| `src/users.ts` | directory sync, offboarding, devices, limits |
| `src/userkeys.ts` | per-user OpenRouter keys |
| `src/spend.ts`, `src/ticks.ts` | machine-hour caps, instance budget, idle auto-pause |
| `src/layers.ts` | personal layer store, Reset/Undo, layer assembly |
| `src/providers.ts` | interfaces to the outside world; real ones in `fly.ts`, `s3.ts`, `openrouter.ts`, `directory-google.ts`, `cloudflare-devices.ts`, `orgenv-git.ts`; fakes in `src/fakes/` |
| `src/db.ts` | SQLite schema and migrations |
