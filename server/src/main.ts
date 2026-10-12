// Production entry: config from JARVIS_CONFIG, secrets from the environment, state in JARVIS_DB.
import { loadActionSecrets, loadConfig, loadPushSecrets, loadSecrets, loadToolSecrets } from "./config.ts";
import { RealPushSender } from "./push.ts";
import { buildToolProviders } from "./tools/registry.ts";
import { openDb } from "./db.ts";
import { createJarvis } from "./app.ts";
import { FlyMachines } from "./fly.ts";
import { DockerMachines } from "./docker.ts";
import { S3BlobStore } from "./s3.ts";
import { OpenRouterKeys } from "./openrouter.ts";
import { GoogleDirectory, StaticDirectory, WithExternalMembers } from "./directory-google.ts";
import { CloudflareDeviceTokens } from "./cloudflare-devices.ts";
import { GitOrgEnv } from "./orgenv-git.ts";
import { WebApp } from "./web.ts";
import { GitHubForge } from "./github.ts";

const config = loadConfig();
const secrets = loadSecrets();
if (config.machines.kind === "fly" && !secrets.flyApiToken) throw new Error("missing secret env FLY_API_TOKEN");
const db = openDb(process.env.JARVIS_DB || "/data/jarvis.db");

const directory =
  config.directory.kind === "google"
    ? new WithExternalMembers(
        new GoogleDirectory({
          serviceAccountJson: secrets.googleServiceAccountJson,
          domain: config.directory.domain,
          subject: config.directory.subject,
          groups: Object.keys(config.directory.groupRoles),
        }),
        config.directory.users || [],
      )
    : new StaticDirectory(config.directory.users);

const sg = config.suggestions;
if (sg?.auth.kind === "token" && !secrets.githubSuggestToken) throw new Error("missing secret env GITHUB_SUGGEST_TOKEN (suggestions.auth.kind = token)");
if (sg?.auth.kind === "app" && !secrets.githubAppPrivateKey) throw new Error("missing secret env GITHUB_APP_PRIVATE_KEY (suggestions.auth.kind = app)");
const forge = sg
  ? new GitHubForge({
      repo: sg.repo,
      ...(sg.baseBranch ? { baseBranch: sg.baseBranch } : {}),
      ...(sg.apiUrl ? { apiUrl: sg.apiUrl } : {}),
      auth:
        sg.auth.kind === "token"
          ? { kind: "token", token: secrets.githubSuggestToken }
          : { kind: "app", appId: String(sg.auth.appId), installationId: String(sg.auth.installationId), privateKeyPem: secrets.githubAppPrivateKey },
    })
  : null;

// push notifications: only the channels the config names, with their keys from the environment
const push = config.push && (config.push.apns || config.push.webPush) ? new RealPushSender(config.push, loadPushSecrets(config)) : null;

const webDir = process.env.JARVIS_WEB_DIR;
const jarvis = createJarvis({
  config,
  web: webDir ? new WebApp(webDir) : null,
  db,
  actionSecrets: loadActionSecrets(config),
  dbKey: secrets.dbKey,
  sessionGateClientSecret: secrets.sessionGateClientSecret,
  providers: {
    machines:
      config.machines.kind === "fly"
        ? new FlyMachines({ token: secrets.flyApiToken, app: config.machines.app, region: config.machines.region, ...(config.machines.rootfsGb ? { rootfsGb: config.machines.rootfsGb } : {}) })
        : new DockerMachines({ instance: config.instanceName, ...config.machines }),
    blobs: new S3BlobStore({
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      bucket: config.storage.bucket,
      accessKeyId: secrets.s3AccessKeyId,
      secretAccessKey: secrets.s3SecretAccessKey,
    }),
    keys: new OpenRouterKeys(secrets.openrouterManagementKey),
    directory,
    deviceTokens: new CloudflareDeviceTokens(secrets.cloudflareDeviceTokensApi, config.devices.cloudflareAccountId),
    orgEnv: new GitOrgEnv(config.orgEnv.mirrorPath, config.orgEnv.commit),
    forge,
    tools: buildToolProviders(config, loadToolSecrets(config)),
    push,
  },
});

const port = Number(process.env.PORT || 8080);
jarvis.server.listen(port, () => console.log(JSON.stringify({ msg: "jarvis3 listening", port })));
jarvis.startLoops();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void jarvis
      .settle()
      .then(() => jarvis.close())
      .finally(() => process.exit(0));
  });
}
