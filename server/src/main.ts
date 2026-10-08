// Production entry: config from JARVIS_CONFIG, secrets from the environment, state in JARVIS_DB.
import { loadConfig, loadSecrets } from "./config.ts";
import { openDb } from "./db.ts";
import { createJarvis } from "./app.ts";
import { FlyMachines } from "./fly.ts";
import { S3BlobStore } from "./s3.ts";
import { OpenRouterKeys } from "./openrouter.ts";
import { GoogleDirectory, StaticDirectory } from "./directory-google.ts";
import { CloudflareDeviceTokens } from "./cloudflare-devices.ts";
import { GitOrgEnv } from "./orgenv-git.ts";

const config = loadConfig();
const secrets = loadSecrets();
const db = openDb(process.env.JARVIS_DB || "/data/jarvis.db");

const directory =
  config.directory.kind === "google"
    ? new GoogleDirectory({
        serviceAccountJson: secrets.googleServiceAccountJson,
        domain: config.directory.domain,
        subject: config.directory.subject,
        groups: Object.keys(config.directory.groupRoles),
      })
    : new StaticDirectory(config.directory.users);

const jarvis = createJarvis({
  config,
  db,
  dbKey: secrets.dbKey,
  sessionGateClientSecret: secrets.sessionGateClientSecret,
  providers: {
    machines: new FlyMachines({ token: secrets.flyApiToken, app: config.machines.app, region: config.machines.region, ...(config.machines.rootfsGb ? { rootfsGb: config.machines.rootfsGb } : {}) }),
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
