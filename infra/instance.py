#!/usr/bin/env python3
"""instance.py — bring up one Jarvis 3 instance from its instance repo (docs/RUNBOOK.md).

Every step reads the instance repo's `instance.json` (see deploy/example-instance/instance.json and docs/DEPLOY.md) and is a DRY RUN
unless `--apply` is given: a dry run makes no network call and prints the requests it would send, with
every secret replaced by `<redacted>`. Nothing here ever prints a secret value; secrets go to files made
with mode 600 or straight into SOPS.

  instance.py check       REPO                   instance.json + config.json agree, required files exist
  instance.py scaffold    REPO                   write deploy/kustomization.yaml, deploy/instance.env,
                                                 flux/sync.yaml, flux/bootstrap-apps.yaml, .sops.yaml and
                                                 apps/<name>/kustomization.yaml per extra app (local only)
  instance.py age-key     REPO --out FILE        new age key: private half to FILE (keep it in the admin's
                                                 password manager), public half to REPO/age.pub
  instance.py deploy-keys REPO --out-dir DIR     two read-only SSH deploy keys (Flux -> instance repo,
                          [--apply]              server -> org-env repo), registered on GitHub (GITHUB_TOKEN)
  instance.py cloudflare  REPO --out FILE        Google Workspace login, the Access app, the session gate
                          [--apply]              service token, the tunnel + its ingress, DNS; and per
                                                 extra app its Access app, tunnel and DNS
  instance.py secrets     REPO KEY[=SRC]...      deploy/secrets.enc.yaml, SOPS-encrypted to REPO/age.pub
                          [--apply]              (SRC = env:VAR (default env:KEY) or file:PATH);
                                                 APP_<NAME>_TUNNEL_TOKEN -> apps/<name>/tunnel.enc.yaml
  instance.py box         REPO --age-key FILE    the Hetzner server: firewall with no inbound rules,
                          --flux-key FILE        cloud-init that installs k3s + Flux and points Flux at the
                          [--apply]              instance repo (HCLOUD_TOKEN)

Python 3.10+, stdlib only; `age-keygen`, `ssh-keygen` and `sops` for the steps that need them.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
NAMESPACE = "jarvis3"
ORIGIN = f"http://server.{NAMESPACE}.svc.cluster.local:8080"
MIRROR_PATH = "/data/org-env.git"
GITHUB_KNOWN_HOSTS = (ROOT / "deploy/base/known_hosts").read_text().strip()
BASE_URL = "https://github.com/DE0CH/jarvis3//deploy/base"
APP_BASE_URL = "https://github.com/DE0CH/jarvis3//deploy/app-base"
APP_TOKEN_RE = re.compile(r"APP_([A-Z][A-Z0-9_]*)_TUNNEL_TOKEN")

# The server's secret environment (docs/CONFIG.md "Secrets"): Secret jarvis-secrets.
SERVER_SECRETS_REQUIRED = [
    "JARVIS_DB_KEY", "OPENROUTER_MANAGEMENT_KEY", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
    "CF_DEVICE_TOKENS_API", "SESSION_GATE_CLIENT_SECRET",
]
SERVER_SECRETS_OPTIONAL = ["FLY_API_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "GITHUB_SUGGEST_TOKEN", "GITHUB_APP_PRIVATE_KEY", "APNS_KEY_P8", "VAPID_PRIVATE_KEY"]
# Other Secrets of the base, by the KEY name used on the command line.
OTHER_SECRETS = {"TUNNEL_TOKEN": ("tunnel-token", "token"), "ORG_ENV_DEPLOY_KEY": ("org-env-deploy-key", "identity")}

REDACT_KEYS = {"client_secret", "secret", "token", "tunnel_secret", "user_data", "public_key", "key", "value"}


def die(msg: str) -> "None":
    raise SystemExit(f"error: {msg}")


# ---- instance config ------------------------------------------------------------------------------

def load_instance(repo: Path) -> dict:
    p = repo / "instance.json"
    if not p.exists():
        die(f"{p} not found")
    c = json.loads(p.read_text())
    problems = validate_instance(c)
    if problems:
        die(f"{p}:\n  " + "\n  ".join(problems))
    return c


def validate_instance(c: dict) -> list[str]:
    out = []
    def need(path: str, pred=lambda v: isinstance(v, str) and v != "", what="a non-empty string"):
        cur = c
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                out.append(f"{path}: missing")
                return None
            cur = cur[part]
        if not pred(cur):
            out.append(f"{path}: must be {what}")
        return cur
    name = need("name")
    if isinstance(name, str) and not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", name):
        out.append("name: lowercase letters, digits and '-', 2..31 characters")
    host = need("hostname")
    if isinstance(host, str) and not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host):
        out.append("hostname: a DNS name like jarvis.example.org")
    need("jarvis3.ref", lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{40}|v[0-9][0-9A-Za-z.-]*", v), "a 40-hex commit or a v… tag")
    need("jarvis3.serverImageTag", lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{12}|main", v), "the 12-hex commit tag of the server image")
    for k in ["hetzner.location", "hetzner.serverType", "hetzner.image", "cloudflare.accountId", "cloudflare.zoneId",
              "cloudflare.teamDomain", "storage.endpoint", "storage.region", "storage.bucket", "github.instanceRepo", "github.branch",
              "github.orgEnvRepo", "versions.k3s", "versions.flux"]:
        need(k)
    cf = c.get("cloudflare", {}) if isinstance(c.get("cloudflare"), dict) else {}
    if "identityProvider" in cf:
        need("cloudflare.identityProvider.name")
        need("cloudflare.identityProvider.appsDomain")
    if cf.get("accessScope", "account") not in ("account", "zone"):
        out.append("cloudflare.accessScope: account (default) or zone")
    strs = lambda v: isinstance(v, list) and all(isinstance(d, str) and d for d in v)
    for k in ["allowedEmailDomains", "allowedEmails"]:
        if k in cf and not strs(cf[k]):
            out.append(f"cloudflare.{k}: a list of non-empty strings")
    if not cf.get("allowedEmailDomains") and not cf.get("allowedEmails"):
        out.append("cloudflare.allowedEmailDomains / allowedEmails: at least one domain or email")
    apps = c.get("apps", [])
    if not isinstance(apps, list):
        out.append("apps: a list (optional)")
        apps = []
    seen = set()
    for i, app in enumerate(apps):
        where = f"apps[{i}]"
        if not isinstance(app, dict):
            out.append(f"{where}: an object")
            continue
        an = app.get("name")
        if not isinstance(an, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,20}", an):
            out.append(f"{where}.name: lowercase letters, digits and '-', 2..21 characters")
            continue
        if an in seen:
            out.append(f"{where}.name: {an} twice")
        seen.add(an)
        h = app.get("hostname")
        if not isinstance(h, str) or not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", h) or h == c.get("hostname"):
            out.append(f"{where}.hostname: a DNS name of its own")
        o = app.get("origin")
        if not isinstance(o, str) or not re.fullmatch(rf"https?://[a-z0-9-]+\.{re.escape(app_namespace(an))}\.svc\.cluster\.local(:[0-9]{{1,5}})?", o):
            out.append(f"{where}.origin: http://<service>.{app_namespace(an)}.svc.cluster.local[:port] (a Service of the app itself)")
        if "external" in app and not isinstance(app["external"], bool):
            out.append(f"{where}.external: true or false")
        em = app.get("accessEmails")
        if app.get("external"):
            if em is not None:
                out.append(f"{where}.accessEmails: not with external (its Access app is managed outside instance.py)")
        elif not isinstance(em, list) or not em or not all(isinstance(e, str) and "@" in e for e in em):
            out.append(f"{where}.accessEmails: a non-empty list of emails (who may open it)")
    for k in ["github.instanceRepo", "github.orgEnvRepo"]:
        v = c.get("github", {}).get(k.split(".")[1])
        if isinstance(v, str) and v and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", v):
            out.append(f"{k}: owner/repo")
    return out


def app_namespace(name: str) -> str:
    return f"app-{name}"


def app_token_key(name: str) -> str:
    return f"APP_{name.upper().replace('-', '_')}_TUNNEL_TOKEN"


def apps_of(c: dict) -> list[dict]:
    return c.get("apps", [])


def names(c: dict) -> dict:
    n = c["name"]
    return {
        "server": f"{n}-jarvis3", "firewall": f"{n}-jarvis3", "tunnel": f"{n}-jarvis3",
        "gate_token": f"{n}-jarvis3-sessions", "access_app": f"Jarvis 3 ({n})",
    }


# ---- HTTP: real or dry ------------------------------------------------------------------------------

def redact(v, key: str | None = None):
    if isinstance(v, dict):
        return {k: redact(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [redact(x, key) for x in v]
    if key in REDACT_KEYS and isinstance(v, str) and v:
        return "<redacted>"
    return v


class Http:
    """One JSON API. dry=True: print the request (secrets redacted) and answer with `stub(method, path)`."""

    def __init__(self, base: str, token_env: str | None, dry: bool, stub=None, out=None, opener=None):
        self.base, self.dry, self.stub, self.out = base, dry, stub or (lambda m, p, b: {}), out
        self.token = ""
        if token_env and not dry:
            self.token = os.environ.get(token_env, "")
            if not self.token:
                die(f"{token_env} is not set")
        self.opener = opener
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, path: str, body=None):
        self.calls.append((method, path))
        if self.dry:
            line = f"DRY {method} {self.base}{path}"
            if body is not None:
                line += " " + json.dumps(redact(body), sort_keys=True)
            print(line, file=self.out or sys.stdout)
            return self.stub(method, path, body)
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                                              "Accept": "application/json", "User-Agent": "jarvis3-infra/1"})
        try:
            resp = (self.opener or urllib.request.urlopen)(req)
            raw = resp.read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{method} {self.base}{path}: HTTP {e.code} {e.read()[:300]!r}")


def write_secret_file(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        for k, v in values.items():
            f.write(f"{k}={v}\n")


def read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return dict(l.rstrip("\n").split("=", 1) for l in path.read_text().splitlines() if "=" in l)


# ---- scaffold / check -----------------------------------------------------------------------------

def secrets_rev(repo: Path) -> str:
    """sha256 (12 hex) of the encrypted secrets: in the pod template, so a rotated secret restarts the pods."""
    import hashlib
    p = repo / "deploy/secrets.enc.yaml"
    return hashlib.sha256(p.read_bytes()).hexdigest()[:12] if p.exists() else "none"


def render_kustomization(c: dict, base: str | None = None, rev: str = "none") -> str:
    base = base or f"{BASE_URL}?ref={c['jarvis3']['ref']}"
    return f"""# Generated by jarvis3 infra/instance.py scaffold from instance.json; re-run it after editing that file.
# Flux applies this directory (flux/sync.yaml) as the limited flux-applier identity, decrypting the SOPS
# file with the box's age key.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: {NAMESPACE}
resources:
  - {base}
  - secrets.enc.yaml
configMapGenerator:
  - name: jarvis-config
    files: [config.json]
  - name: jarvis-instance
    envs: [instance.env]
images:
  - name: ghcr.io/de0ch/jarvis3-server
    newTag: "{c['jarvis3']['serverImageTag']}"
commonAnnotations:
  jarvis3/secrets-rev: "{rev}"
"""


def app_secrets_rev(repo: Path, name: str) -> str:
    import hashlib
    p = repo / f"apps/{name}/tunnel.enc.yaml"
    return hashlib.sha256(p.read_bytes()).hexdigest()[:12] if p.exists() else "none"


def render_app_kustomization(c: dict, app: dict, base: str | None = None, rev: str = "none") -> str:
    base = base or f"{APP_BASE_URL}?ref={c['jarvis3']['ref']}"
    return f"""# Generated by jarvis3 infra/instance.py scaffold from instance.json; re-run it after editing that file.
# The extra app "{app['name']}" (docs/DEPLOY.md in DE0CH/jarvis3, "Extra apps"): its own tunnel and network
# policies from the jarvis3 app base, the app's own manifests in ./app (a kustomization of yours), and its
# tunnel token. Flux applies this directory as flux-app-{app['name']}, admin in {app_namespace(app['name'])} only.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: {app_namespace(app['name'])}
resources:
  - {base}
  - app
  - tunnel.enc.yaml
commonAnnotations:
  jarvis3/secrets-rev: "{rev}"
"""


def render_apps_bootstrap(c: dict) -> str:
    """Cluster-scoped objects for the extra apps, applied ONCE by cloud-init with the jarvis3 bootstrap."""
    docs = [f"""# Generated by jarvis3 infra/instance.py scaffold. Applied ONCE by the box's cloud-init (not reconciled),
# so a push to the instance repo can never make a namespace or grant a right: per extra app, its namespace
# (Pod Security "restricted") and the identity Flux applies it as (admin in that namespace only).
# Adding an app to an existing box means rebuilding the box (docs/RUNBOOK.md).
"""]
    for app in apps_of(c):
        ns, sa = app_namespace(app["name"]), f"flux-app-{app['name']}"
        docs.append(f"""apiVersion: v1
kind: Namespace
metadata:
  name: {ns}
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
---
apiVersion: v1
kind: ServiceAccount
metadata: {{ name: {sa}, namespace: flux-system }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {{ name: {sa}, namespace: {ns} }}
roleRef: {{ apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: admin }}
subjects: [{{ kind: ServiceAccount, name: {sa}, namespace: flux-system }}]
""")
    return docs[0] + "---\n".join(docs[1:])


def render_instance_env(c: dict) -> str:
    s = c["storage"]
    return (f"LITESTREAM_S3_ENDPOINT={s['endpoint']}\nLITESTREAM_S3_REGION={s['region']}\n"
            f"LITESTREAM_S3_BUCKET={s['bucket']}\nLITESTREAM_S3_FORCE_PATH_STYLE={'true' if s.get('forcePathStyle') else 'false'}\n"
            f"ORG_ENV_URL=ssh://git@github.com/{c['github']['orgEnvRepo']}.git\n")


def render_sync(c: dict) -> str:
    return f"""# Generated by jarvis3 infra/instance.py scaffold. Applied ONCE by the box's cloud-init (not reconciled):
# Flux pulls the instance repo with its read-only deploy key (Secret instance-repo) and applies ./deploy as
# flux-applier (admin in the {NAMESPACE} namespace only), decrypting SOPS files with the box's age key.
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: {{ name: instance, namespace: flux-system }}
spec:
  interval: 1m
  url: ssh://git@github.com/{c['github']['instanceRepo']}.git
  ref: {{ branch: {c['github']['branch']} }}
  secretRef: {{ name: instance-repo }}
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {{ name: instance, namespace: flux-system }}
spec:
  interval: 1m
  retryInterval: 30s
  timeout: 5m
  sourceRef: {{ kind: GitRepository, name: instance }}
  path: ./deploy
  prune: true
  wait: false
  serviceAccountName: flux-applier
  decryption:
    provider: sops
    secretRef: {{ name: sops-age }}
""" + "".join(f"""---
# the extra app "{app['name']}": applied as flux-app-{app['name']}, which can touch {app_namespace(app['name'])} only
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: {{ name: app-{app['name']}, namespace: flux-system }}
spec:
  interval: 1m
  retryInterval: 30s
  timeout: 5m
  sourceRef: {{ kind: GitRepository, name: instance }}
  path: ./apps/{app['name']}
  targetNamespace: {app_namespace(app['name'])}
  prune: true
  wait: false
  serviceAccountName: flux-app-{app['name']}
  decryption:
    provider: sops
    secretRef: {{ name: sops-age }}
""" for app in apps_of(c))


def render_sops(recipient: str) -> str:
    return f"""# SOPS: everything under deploy/ and apps/ that ends in .enc.yaml is encrypted to the box's age key (only data/stringData).
creation_rules:
  - path_regex: (deploy|apps)/.*\\.enc\\.yaml$
    encrypted_regex: ^(data|stringData)$
    age: {recipient}
"""


def cmd_scaffold(a) -> None:
    repo = Path(a.repo)
    c = load_instance(repo)
    (repo / "deploy").mkdir(exist_ok=True)
    (repo / "flux").mkdir(exist_ok=True)
    files = {"deploy/kustomization.yaml": render_kustomization(c, a.base, secrets_rev(repo)), "deploy/instance.env": render_instance_env(c),
             "flux/sync.yaml": render_sync(c), "flux/bootstrap-apps.yaml": render_apps_bootstrap(c)}
    app_base = a.app_base
    for app in apps_of(c):
        (repo / "apps" / app["name"]).mkdir(parents=True, exist_ok=True)
        files[f"apps/{app['name']}/kustomization.yaml"] = render_app_kustomization(c, app, app_base, app_secrets_rev(repo, app["name"]))
    pub = repo / "age.pub"
    if pub.exists():
        files[".sops.yaml"] = render_sops(pub.read_text().strip())
    for rel, text in files.items():
        (repo / rel).write_text(text)
        print("wrote", rel)
    if not pub.exists():
        print("no age.pub yet: run `instance.py age-key` and scaffold again for .sops.yaml")
    for app in apps_of(c):
        if not (repo / f"apps/{app['name']}/app/kustomization.yaml").exists():
            print(f"apps/{app['name']}/app/: put the app's own manifests there (a kustomization; no namespace needed)")


def check(repo: Path) -> list[str]:
    c = load_instance(repo)
    out = []
    cfgp = repo / "deploy/config.json"
    if not cfgp.exists():
        return [f"{cfgp} missing (the server config, docs/CONFIG.md)"]
    cfg = json.loads(cfgp.read_text())
    if cfg.get("publicUrl") != f"https://{c['hostname']}":
        out.append(f"deploy/config.json publicUrl must be https://{c['hostname']}")
    if cfg.get("access", {}).get("teamDomain") != c["cloudflare"]["teamDomain"]:
        out.append("config.json access.teamDomain differs from instance.json cloudflare.teamDomain")
    st = cfg.get("storage", {})
    for k in ["endpoint", "region", "bucket"]:
        if st.get(k) != c["storage"][k]:
            out.append(f"config.json storage.{k} differs from instance.json storage.{k}")
    if cfg.get("orgEnv", {}).get("mirrorPath") != MIRROR_PATH:
        out.append(f"config.json orgEnv.mirrorPath must be {MIRROR_PATH} (where the deployment keeps the mirror)")
    if cfg.get("instanceName") != c["name"]:
        out.append("config.json instanceName differs from instance.json name")
    for app in apps_of(c):
        for rel in ["kustomization.yaml", "app/kustomization.yaml", "tunnel.enc.yaml"]:
            if not (repo / f"apps/{app['name']}/{rel}").exists():
                out.append(f"apps/{app['name']}/{rel} missing")
    present = {p.name for p in (repo / "apps").iterdir() if p.is_dir()} if (repo / "apps").exists() else set()
    for extra in sorted(present - {app["name"] for app in apps_of(c)}):
        out.append(f"apps/{extra}/ is not in instance.json apps (Flux would not apply it)")
    for rel in ["deploy/kustomization.yaml", "deploy/instance.env", "flux/sync.yaml", "flux/bootstrap-apps.yaml", "age.pub", ".sops.yaml", "deploy/secrets.enc.yaml"]:
        if not (repo / rel).exists():
            out.append(f"{rel} missing")
    enc = repo / "deploy/secrets.enc.yaml"
    if enc.exists() and "sops:" not in enc.read_text():
        out.append("deploy/secrets.enc.yaml is not SOPS-encrypted")
    return out


def cmd_check(a) -> None:
    problems = check(Path(a.repo))
    if problems:
        die("\n  " + "\n  ".join(problems))
    print("ok")


# ---- keys -----------------------------------------------------------------------------------------

def cmd_age_key(a) -> None:
    repo, out = Path(a.repo), Path(a.out)
    load_instance(repo)
    if out.exists():
        die(f"{out} exists; a rebuild reuses the instance's age key (pass it to `box --age-key`)")
    out.parent.mkdir(parents=True, exist_ok=True)
    old = os.umask(0o077)
    try:
        subprocess.run(["age-keygen", "-o", str(out)], check=True, capture_output=True)
    finally:
        os.umask(old)
    pub = subprocess.run(["age-keygen", "-y", str(out)], check=True, capture_output=True, text=True).stdout.strip()
    (repo / "age.pub").write_text(pub + "\n")
    (repo / ".sops.yaml").write_text(render_sops(pub))
    print(f"age key written to {out} (mode 600; keep it in the admin's password manager); public key in age.pub and .sops.yaml")


def ssh_keygen(path: Path, comment: str) -> str:
    if path.exists():
        die(f"{path} exists")
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", str(path)], check=True)
    os.chmod(path, 0o600)
    return Path(str(path) + ".pub").read_text().strip()


def cmd_deploy_keys(a) -> None:
    repo, outdir = Path(a.repo), Path(a.out_dir)
    c = load_instance(repo)
    dry = not a.apply
    gh = Http("https://api.github.com", "GITHUB_TOKEN", dry, stub=lambda m, p, b: {"id": 0})
    outdir.mkdir(parents=True, exist_ok=True, mode=0o700)
    pairs = [("flux", c["github"]["instanceRepo"], f"{c['name']}-jarvis3 flux (read-only)"),
             ("org-env", c["github"]["orgEnvRepo"], f"{c['name']}-jarvis3 server org-env mirror (read-only)")]
    for name, ghrepo, title in pairs:
        key = outdir / f"{name}-deploy-key"
        pub = "ssh-ed25519 <generated in --apply>" if dry else ssh_keygen(key, title)
        gh("POST", f"/repos/{ghrepo}/keys", {"title": title, "key": pub, "read_only": True})
        print(f"{name}: {'would write' if dry else 'wrote'} {key} (private half, mode 600); read-only deploy key on {ghrepo}")
    print("next: `box --flux-key", outdir / "flux-deploy-key", "` and `secrets ORG_ENV_DEPLOY_KEY=file:" + str(outdir / "org-env-deploy-key") + " …`")


# ---- Cloudflare -----------------------------------------------------------------------------------

def cloudflare_stub(c: dict):
    def stub(method, path, body):
        if method == "GET":
            if path.endswith("/token"):
                return {"success": True, "result": "<tunnel token>"}
            return {"success": True, "result": []}
        res = {"id": "<id>", "aud": "<aud>", "client_id": "<client id>.access", "client_secret": "<secret>"}
        return {"success": True, "result": res}
    return stub


def cmd_cloudflare(a) -> None:
    repo, out = Path(a.repo), Path(a.out)
    c = load_instance(repo)
    cf, n = c["cloudflare"], names(c)
    dry = not a.apply
    http = Http("https://api.cloudflare.com/client/v4", "CLOUDFLARE_API_TOKEN", dry, stub=cloudflare_stub(c))
    acc = f"/accounts/{cf['accountId']}"
    # where the Access apps live: account-level (default), or zone-level for a token limited to the instance's
    # zone (it can't see or touch the account's other Access apps). Service tokens and tunnels are account-level.
    aapps = f"/zones/{cf['zoneId']}" if cf.get("accessScope") == "zone" else acc

    def call(m, p, b=None):
        r = http(m, p, b)
        if not r.get("success", False):
            die(f"{m} {p}: {r.get('errors')}")
        return r["result"]

    def env(k):
        v = os.environ.get(k, "")
        if not v and not dry:
            die(f"{k} is not set")
        return v or "<from env>"

    prev = read_env_file(out)
    vals: dict[str, str] = {}

    # 1. the identity provider: the instance's Google Workspace (an OAuth client in its own Cloud project).
    # Without `identityProvider` the app uses the login methods the account already has (e.g. one-time PIN).
    idp = None
    if cf.get("identityProvider"):
        idp_body = {"name": cf["identityProvider"]["name"], "type": "google-apps",
                    "config": {"client_id": env("GOOGLE_IDP_CLIENT_ID"), "client_secret": env("GOOGLE_IDP_CLIENT_SECRET"),
                               "apps_domain": cf["identityProvider"]["appsDomain"]}}
        idps = call("GET", f"{aapps}/access/identity_providers")
        idp = next((i for i in idps if i.get("name") == idp_body["name"]), None)
        idp = call("PUT", f"{aapps}/access/identity_providers/{idp['id']}", idp_body) if idp else call("POST", f"{aapps}/access/identity_providers", idp_body)

    # 2. the session gate service token (kept unless ROTATE=1 or its secret is gone)
    toks = call("GET", f"{acc}/access/service_tokens")
    tok = next((t for t in toks if t.get("name") == n["gate_token"]), None)
    if tok and not os.environ.get("ROTATE") and prev.get("SESSION_GATE_CLIENT_SECRET"):
        vals["SESSION_GATE_CLIENT_SECRET"] = prev["SESSION_GATE_CLIENT_SECRET"]
        gate_client_id = tok["client_id"]
    else:
        if tok:
            call("DELETE", f"{acc}/access/service_tokens/{tok['id']}")
        t = call("POST", f"{acc}/access/service_tokens", {"name": n["gate_token"], "duration": "8760h"})
        vals["SESSION_GATE_CLIENT_SECRET"], gate_client_id = t["client_secret"], t["client_id"]

    # 3. the Access app BEFORE any DNS, so the hostname is never reachable ungated
    apps = call("GET", f"{aapps}/access/apps")
    app = next((x for x in apps if x.get("domain") == c["hostname"]), None)
    app_body = {"name": n["access_app"], "domain": c["hostname"], "type": "self_hosted", "session_duration": "720h",
                "app_launcher_visible": False}
    if idp:
        app_body.update(allowed_idps=[idp["id"]], auto_redirect_to_identity=True)
    app = call("PUT", f"{aapps}/access/apps/{app['id']}", app_body) if app else call("POST", f"{aapps}/access/apps", app_body)
    for p in call("GET", f"{aapps}/access/apps/{app['id']}/policies"):
        call("DELETE", f"{aapps}/access/apps/{app['id']}/policies/{p['id']}")
    members = {"name": "members", "decision": "allow", "precedence": 1,
               "include": [{"email_domain": {"domain": d}} for d in cf.get("allowedEmailDomains", [])]
                          + [{"email": {"email": e}} for e in cf.get("allowedEmails", [])]}
    if idp:
        members["require"] = [{"login_method": {"id": idp["id"]}}]
    call("POST", f"{aapps}/access/apps/{app['id']}/policies", members)
    # paired devices and the session gate: per-device tokens are minted by the server at runtime, so the
    # policy admits any service token of the account; the server accepts only the ones it knows
    call("POST", f"{aapps}/access/apps/{app['id']}/policies", {
        "name": "service tokens", "decision": "non_identity", "precedence": 2,
        "include": [{"any_valid_service_token": {}}]})

    # 4. the tunnel (remotely managed) and its one ingress rule
    tunnels = call("GET", f"{acc}/cfd_tunnel?name={n['tunnel']}&is_deleted=false")
    tun = tunnels[0] if tunnels else call("POST", f"{acc}/cfd_tunnel", {"name": n["tunnel"], "config_src": "cloudflare"})
    call("PUT", f"{acc}/cfd_tunnel/{tun['id']}/configurations", {"config": {"ingress": [
        {"hostname": c["hostname"], "service": ORIGIN, "originRequest": {}}, {"service": "http_status:404"}]}})
    vals["TUNNEL_TOKEN"] = call("GET", f"{acc}/cfd_tunnel/{tun['id']}/token")

    # 5. DNS last
    zone = f"/zones/{cf['zoneId']}"
    def cname(host: str, tunnel_id: str, comment: str) -> None:
        recs = call("GET", f"{zone}/dns_records?name={host}")
        rec = {"type": "CNAME", "name": host, "content": f"{tunnel_id}.cfargotunnel.com", "proxied": True, "comment": comment}
        call("PUT", f"{zone}/dns_records/{recs[0]['id']}", rec) if recs else call("POST", f"{zone}/dns_records", rec)
    cname(c["hostname"], tun["id"], f"Jarvis 3 {c['name']} tunnel")

    # 6. each extra app: its own Access app (the listed emails, through the account's login methods), its own
    # tunnel to its own Service, then DNS. Nothing of it reaches the instance's tunnel or Access app.
    # An `external` app's hostname is in a zone this token doesn't manage (e.g. an address the app had
    # before it moved here): only its tunnel is made; its Access app and CNAME stay with that zone's owner.
    external = []
    for xa in apps_of(c):
        an = f"{c['name']}-app-{xa['name']}"
        if xa.get("external"):
            ts = call("GET", f"{acc}/cfd_tunnel?name={an}&is_deleted=false")
            xt = ts[0] if ts else call("POST", f"{acc}/cfd_tunnel", {"name": an, "config_src": "cloudflare"})
            call("PUT", f"{acc}/cfd_tunnel/{xt['id']}/configurations", {"config": {"ingress": [
                {"hostname": xa["hostname"], "service": xa["origin"], "originRequest": {}}, {"service": "http_status:404"}]}})
            vals[app_token_key(xa["name"])] = call("GET", f"{acc}/cfd_tunnel/{xt['id']}/token")
            external.append(f"{xa['hostname']} -> CNAME {xt['id']}.cfargotunnel.com (proxied), behind an Access app made there first")
            continue
        xapp = next((x for x in apps if x.get("domain") == xa["hostname"]), None)
        xbody = {"name": f"{xa['name']} ({c['name']})", "domain": xa["hostname"], "type": "self_hosted",
                 "session_duration": "720h", "app_launcher_visible": False}
        xapp = call("PUT", f"{aapps}/access/apps/{xapp['id']}", xbody) if xapp else call("POST", f"{aapps}/access/apps", xbody)
        for p in call("GET", f"{aapps}/access/apps/{xapp['id']}/policies"):
            call("DELETE", f"{aapps}/access/apps/{xapp['id']}/policies/{p['id']}")
        call("POST", f"{aapps}/access/apps/{xapp['id']}/policies", {
            "name": "users", "decision": "allow", "precedence": 1,
            "include": [{"email": {"email": e}} for e in xa["accessEmails"]]})
        ts = call("GET", f"{acc}/cfd_tunnel?name={an}&is_deleted=false")
        xt = ts[0] if ts else call("POST", f"{acc}/cfd_tunnel", {"name": an, "config_src": "cloudflare"})
        call("PUT", f"{acc}/cfd_tunnel/{xt['id']}/configurations", {"config": {"ingress": [
            {"hostname": xa["hostname"], "service": xa["origin"], "originRequest": {}}, {"service": "http_status:404"}]}})
        vals[app_token_key(xa["name"])] = call("GET", f"{acc}/cfd_tunnel/{xt['id']}/token")
        cname(xa["hostname"], xt["id"], f"{xa['name']} on Jarvis 3 {c['name']}")

    keys = ", ".join(vals) if vals else "SESSION_GATE_CLIENT_SECRET, TUNNEL_TOKEN" + "".join(", " + app_token_key(x["name"]) for x in apps_of(c))
    if dry:
        print(f"dry run: would write {keys} to {out} (mode 600)")
    else:
        write_secret_file(out, vals)
        print(f"wrote {keys} to {out} (mode 600)")
    for e in external:
        print(f"external app, yours to set up in its zone: {e}")
    print(f"config.json: access.audience={app['aud']} access.sessionGateClientId={gate_client_id} "
          f"access.teamDomain={cf['teamDomain']}; tunnel {tun['id']}")


# ---- SOPS secrets -----------------------------------------------------------------------------------

def collect(args: list[str]) -> dict[str, str]:
    data = {}
    for arg in args:
        key, _, src = arg.partition("=")
        src = src or "env:" + key
        kind, _, ref = src.partition(":")
        if kind == "env":
            v = os.environ.get(ref, "")
        elif kind == "file":
            p = Path(ref).expanduser()
            v = p.read_text() if p.exists() else ""
            if key != "ORG_ENV_DEPLOY_KEY" and key != "GOOGLE_SERVICE_ACCOUNT_JSON":
                v = v.strip()
        else:
            die(f"{key}: SRC is env:VAR or file:PATH")
        if not v:
            die(f"{key}: {src} is empty")
        data[key] = v
    return data


def config_secret_names(repo: Path) -> list[str]:
    """Environment variables deploy/config.json names for credentials: tools.<kind>.credential (Tier 0)
    and actions.<name>.credentials (the broker). They go into jarvis-secrets like the fixed keys."""
    p = repo / "deploy/config.json"
    if not p.exists():
        return []
    c = json.loads(p.read_text())
    names = [t.get("credential") for k, t in (c.get("tools") or {}).items() if isinstance(t, dict)]
    for a in (c.get("actions") or {}).values():
        names += list((a.get("credentials") or {}).values()) if isinstance(a, dict) else []
    return sorted({n for n in names if isinstance(n, str) and re.fullmatch(r"[A-Z_][A-Z0-9_]*", n)})


def secret_docs(data: dict[str, str], configured: list[str] | None = None) -> list[dict]:
    configured = configured or []
    known = set(SERVER_SECRETS_REQUIRED) | set(SERVER_SECRETS_OPTIONAL) | set(OTHER_SECRETS) | set(configured)
    unknown = sorted(set(data) - known)
    if unknown:
        die("unknown keys: " + ", ".join(unknown) + " (server secrets are listed in docs/CONFIG.md; tool and action"
            " credentials must be named in deploy/config.json first)")
    missing = sorted(set(SERVER_SECRETS_REQUIRED) - set(data)) + sorted(k for k in OTHER_SECRETS if k not in data)
    missing += sorted(k for k in configured if k not in data)
    if missing:
        die("every run rewrites the whole file, so name every key; missing: " + ", ".join(missing))
    server = {k: data[k] for k in SERVER_SECRETS_REQUIRED + SERVER_SECRETS_OPTIONAL + configured if k in data}
    docs = [{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "jarvis-secrets"}, "type": "Opaque", "stringData": server}]
    for k, (name, field) in OTHER_SECRETS.items():
        docs.append({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name}, "type": "Opaque", "stringData": {field: data[k]}})
    return docs


def sops_encrypt(pub: Path, docs: list[dict]) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "secrets.yaml"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("\n---\n".join(json.dumps(d) for d in docs))  # JSON is YAML
        # cwd = the temp dir: sops reads a .sops.yaml from the working directory up, and the instance repo's
        # rules (deploy/… and apps/… paths) don't match the temp file ("no matching creation rules found")
        r = subprocess.run(["sops", "--encrypt", "--age", pub.read_text().strip(), "--encrypted-regex", "^(data|stringData)$",
                            "--input-type", "yaml", "--output-type", "yaml", str(tmp)], cwd=td, capture_output=True)
        if r.returncode != 0:
            die("sops --encrypt failed: " + r.stderr.decode(errors="replace").strip()[-300:])
        return r.stdout


def cmd_secrets(a) -> None:
    repo = Path(a.repo)
    c = load_instance(repo)
    data = collect(a.keys)
    by_key = {app_token_key(x["name"]): x["name"] for x in apps_of(c)}
    app_data = {k: v for k, v in data.items() if APP_TOKEN_RE.fullmatch(k)}
    for k in app_data:
        if k not in by_key:
            die(f"{k}: no app with that name in instance.json apps")
    main = {k: v for k, v in data.items() if k not in app_data}
    # (path, docs, kustomization to bump, rev)
    plan: list[tuple[Path, list[dict], Path, callable]] = []
    if main or not app_data:
        plan.append((repo / "deploy/secrets.enc.yaml", secret_docs(main, config_secret_names(repo)), repo / "deploy/kustomization.yaml", lambda: secrets_rev(repo)))
    for k, v in app_data.items():
        name = by_key[k]
        docs = [{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "tunnel-token"}, "type": "Opaque", "stringData": {"token": v}}]
        plan.append((repo / f"apps/{name}/tunnel.enc.yaml", docs, repo / f"apps/{name}/kustomization.yaml", lambda n=name: app_secrets_rev(repo, n)))
    summary = lambda docs: "; ".join(f"{d['metadata']['name']}: {', '.join(sorted(d['stringData']))}" for d in docs)
    if not a.apply:
        for out, docs, _, _ in plan:
            print(f"dry run: would write {out.relative_to(repo)} with {summary(docs)}")
        return
    pub = repo / "age.pub"
    if not pub.exists():
        die("age.pub missing: run `instance.py age-key` first")
    for out, docs, kust, rev in plan:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(sops_encrypt(pub, docs))
        if kust.exists():
            kust.write_text(re.sub(r'jarvis3/secrets-rev: "[^"]*"', f'jarvis3/secrets-rev: "{rev()}"', kust.read_text()))
        print(f"wrote {out.relative_to(repo)} with {summary(docs)}; secrets-rev {rev()}")


# ---- the box ------------------------------------------------------------------------------------------

def user_data(c: dict, repo: Path, age_key: str, flux_key: str) -> str:
    init = (HERE / "cloud-init.sh").read_text()
    bootstrap = (ROOT / "deploy/bootstrap/bootstrap.yaml").read_text()
    if apps_of(c):
        ab = repo / "flux/bootstrap-apps.yaml"
        bootstrap += "\n---\n" + (ab.read_text() if ab.exists() else render_apps_bootstrap(c))
    sync = (repo / "flux/sync.yaml").read_text() if (repo / "flux/sync.yaml").exists() else render_sync(c)
    head = "#!/bin/bash\n" + "".join(f"{k}={shlex.quote(v)}\n" for k, v in {
        "K3S_VERSION": c["versions"]["k3s"], "FLUX_VERSION": c["versions"]["flux"].lstrip("v"),
        "AGE_KEY": age_key, "FLUX_KEY": flux_key, "KNOWN_HOSTS": GITHUB_KNOWN_HOSTS,
        "BOOTSTRAP_YAML": bootstrap, "SYNC_YAML": sync}.items())
    return head + init


def hetzner_stub(method, path, body):
    if method == "GET":
        return {"firewalls": [], "servers": []}
    if path == "/ssh_keys":
        return {"ssh_key": {"id": 0}}
    if path == "/firewalls":
        return {"firewall": {"id": 0}}
    if path == "/servers":
        return {"server": {"id": 0, "public_net": {"ipv4": {"ip": "<ip>"}}}}
    return {}


def cmd_box(a) -> None:
    repo = Path(a.repo)
    c = load_instance(repo)
    n, h = names(c), c["hetzner"]
    dry = not a.apply
    for p in [a.age_key, a.flux_key]:
        if not dry and not Path(p).exists():
            die(f"{p} not found")
    age_key = Path(a.age_key).read_text() if Path(a.age_key).exists() else "<age key>"
    flux_key = Path(a.flux_key).read_text() if Path(a.flux_key).exists() else "<flux deploy key>"
    ud = user_data(c, repo, age_key, flux_key)
    if len(ud.encode()) > 32 * 1024:
        die(f"user-data is {len(ud.encode())} bytes; Hetzner allows 32 KiB")
    api = Http("https://api.hetzner.cloud/v1", "HCLOUD_TOKEN", dry, stub=hetzner_stub)
    if any(s.get("name") == n["server"] for s in api("GET", f"/servers?name={n['server']}").get("servers", [])):
        die(f"server {n['server']} exists; delete it first to rebuild (docs/RUNBOOK.md)")
    # Hetzner mails a root password for a server without an SSH key: give it a throwaway key whose private
    # half is never kept (sshd is disabled and the firewall has no inbound rules anyway)
    with tempfile.TemporaryDirectory() as td:
        pub = "ssh-ed25519 <throwaway>" if dry else ssh_keygen(Path(td) / "k", f"{n['server']}-throwaway")
    key = api("POST", "/ssh_keys", {"name": f"{n['server']}-throwaway-{int(time.time())}", "public_key": pub})["ssh_key"]["id"]
    fws = [f for f in api("GET", f"/firewalls?name={n['firewall']}").get("firewalls", []) if f.get("name") == n["firewall"]]
    if fws:
        fw = fws[0]["id"]
        api("POST", f"/firewalls/{fw}/actions/set_rules", {"rules": []})
    else:
        fw = api("POST", "/firewalls", {"name": n["firewall"], "rules": [], "labels": {"jarvis3": c["name"]}})["firewall"]["id"]
    s = api("POST", "/servers", {"name": n["server"], "server_type": h["serverType"], "image": h["image"], "location": h["location"],
                                 "ssh_keys": [key], "firewalls": [{"firewall": fw}], "labels": {"jarvis3": c["name"]},
                                 "public_net": {"enable_ipv4": True, "enable_ipv6": True}, "user_data": ud})["server"]
    api("DELETE", f"/ssh_keys/{key}")
    print(f"server {n['server']} ({s['id']}, {s['public_net']['ipv4']['ip']}): firewall {n['firewall']} has no inbound rules; "
          f"cloud-init installs k3s {c['versions']['k3s']} + Flux {c['versions']['flux']} and syncs {c['github']['instanceRepo']}")
    print(f"it is up when https://{c['hostname']}/api/health answers through the tunnel (a few minutes)")


# ---- main -----------------------------------------------------------------------------------------------

def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    def p(name, fn, apply=False):
        x = sub.add_parser(name)
        x.add_argument("repo", help="the instance repo checkout (holds instance.json)")
        if apply:
            x.add_argument("--apply", action="store_true", help="really do it (default: dry run, no network)")
        x.set_defaults(fn=fn)
        return x
    p("check", cmd_check)
    x = p("scaffold", cmd_scaffold)
    x.add_argument("--base", help="override the remote base (tests and the example instance)")
    x.add_argument("--app-base", help="override the remote app base, relative to apps/<name>/ (tests and the example instance)")
    p("age-key", cmd_age_key).add_argument("--out", required=True)
    p("deploy-keys", cmd_deploy_keys, apply=True).add_argument("--out-dir", required=True)
    p("cloudflare", cmd_cloudflare, apply=True).add_argument("--out", required=True)
    x = p("secrets", cmd_secrets, apply=True)
    x.add_argument("keys", nargs="+", metavar="KEY[=SRC]")
    x = p("box", cmd_box, apply=True)
    x.add_argument("--age-key", required=True)
    x.add_argument("--flux-key", required=True)
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
