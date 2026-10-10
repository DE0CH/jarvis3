"""Tests of infra/instance.py: dry runs make no network call and print no secret; --apply against fake APIs
does the right calls in the right order; scaffold reproduces the committed example instance; SOPS round trip.
Run: python3 -m unittest discover -s infra/tests -v"""
import contextlib
import io
import json
import re
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "infra"))
import instance  # noqa: E402

EXAMPLE = ROOT / "deploy/example-instance"
SECRET_ENV = {
    "JARVIS_DB_KEY": "s3cr3t-db-key-111", "OPENROUTER_MANAGEMENT_KEY": "s3cr3t-or-222", "S3_ACCESS_KEY_ID": "s3cr3t-ak-333",
    "S3_SECRET_ACCESS_KEY": "s3cr3t-sk-444", "CF_DEVICE_TOKENS_API": "s3cr3t-cf-555", "SESSION_GATE_CLIENT_SECRET": "s3cr3t-gate-666",
    "TUNNEL_TOKEN": "s3cr3t-tun-777", "ORG_ENV_DEPLOY_KEY": "s3cr3t-deploy-888", "GOOGLE_IDP_CLIENT_SECRET": "s3cr3t-idp-999",
    "GOOGLE_IDP_CLIENT_ID": "idp-client-id", "CLOUDFLARE_API_TOKEN": "s3cr3t-cfapi-000", "HCLOUD_TOKEN": "s3cr3t-hc-123",
    "GITHUB_TOKEN": "s3cr3t-gh-456",
}
APP_TUNNEL_TOKEN = "s3cr3t-apptun-tun2"
SECRETS = [v for k, v in SECRET_ENV.items() if k != "GOOGLE_IDP_CLIENT_ID"] + [APP_TUNNEL_TOKEN]


def no_network(*a, **k):
    raise AssertionError("a dry run made a network call")


def run(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=False), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        instance.main(argv)
    return out.getvalue() + err.getvalue()


class Resp:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self):
        return self.body


class FakeCloudflare:
    """Just enough of the Cloudflare API, with state, to check order and idempotency."""

    def __init__(self):
        self.calls = []
        self.idps, self.tokens, self.apps, self.policies, self.tunnels, self.dns = [], [], [], {}, [], []
        self.ingresses = {}
        self.n = 0

    def _id(self):
        self.n += 1
        return f"id{self.n}"

    def __call__(self, req: urllib.request.Request):
        m, url = req.get_method(), req.full_url
        path = url.split("/client/v4", 1)[1]
        body = json.loads(req.data) if req.data else None
        assert req.headers["Authorization"] == "Bearer " + SECRET_ENV["CLOUDFLARE_API_TOKEN"]
        self.calls.append((m, path.split("?")[0]))
        ok = lambda r: Resp({"success": True, "result": r})
        if path.endswith("/access/identity_providers"):
            if m == "GET":
                return ok(self.idps)
            self.idps.append(dict(body, id=self._id()))
            return ok(self.idps[-1])
        if "/access/identity_providers/" in path:
            return ok(dict(body, id=path.rsplit("/", 1)[1]))
        if path.endswith("/access/service_tokens"):
            if m == "GET":
                return ok([{k: t[k] for k in ("id", "name", "client_id")} for t in self.tokens])
            t = {"id": self._id(), "name": body["name"], "client_id": "gate.access", "client_secret": SECRET_ENV["SESSION_GATE_CLIENT_SECRET"]}
            self.tokens.append(t)
            return ok(t)
        if "/access/service_tokens/" in path and m == "DELETE":
            self.tokens = [t for t in self.tokens if t["id"] != path.rsplit("/", 1)[1]]
            return ok({})
        if path.endswith("/access/apps"):
            if m == "GET":
                return ok(self.apps)
            self.apps.append(dict(body, id=self._id(), aud="aud-tag"))
            return ok(self.apps[-1])
        if path.endswith("/policies"):
            app = path.split("/apps/")[1].split("/")[0]
            if m == "GET":
                return ok(self.policies.get(app, []))
            self.policies.setdefault(app, []).append(dict(body, id=self._id()))
            return ok(self.policies[app][-1])
        if "/policies/" in path and m == "DELETE":
            app = path.split("/apps/")[1].split("/")[0]
            self.policies[app] = [p for p in self.policies[app] if p["id"] != path.rsplit("/", 1)[1]]
            return ok({})
        if "/access/apps/" in path and m == "PUT":
            a = next(x for x in self.apps if x["id"] == path.rsplit("/", 1)[1])
            a.update(body)
            return ok(a)
        query = dict(x.split("=", 1) for x in path.split("?", 1)[1].split("&")) if "?" in path else {}
        if "/cfd_tunnel" in path:
            tid = path.split("/cfd_tunnel/")[1].split("/")[0] if "/cfd_tunnel/" in path else None
            if path.endswith("/token"):
                return ok(SECRET_ENV["TUNNEL_TOKEN"] if tid == "tun1" else f"s3cr3t-apptun-{tid}")
            if path.endswith("/configurations"):
                self.ingresses[tid] = body
                return ok({})
            if m == "GET":
                return ok([t for t in self.tunnels if t["name"] == query.get("name")])
            self.tunnels.append({"id": f"tun{len(self.tunnels) + 1}", "name": body["name"]})
            return ok(self.tunnels[-1])
        if "/dns_records" in path:
            if m == "GET":
                return ok([d for d in self.dns if d["name"] == query.get("name")])
            if m == "POST":
                self.dns.append(dict(body, id=self._id()))
            return ok({})
        raise AssertionError(f"unexpected {m} {path}")


class InstanceConfig(unittest.TestCase):
    def test_example_is_valid(self):
        self.assertEqual(instance.validate_instance(json.loads((EXAMPLE / "instance.json").read_text())), [])

    def test_bad_values_are_named(self):
        c = json.loads((EXAMPLE / "instance.json").read_text())
        c["name"] = "Bad Name"
        c["github"]["instanceRepo"] = "no-slash"
        del c["storage"]["bucket"]
        p = instance.validate_instance(c)
        self.assertTrue(any(x.startswith("name:") for x in p))
        self.assertTrue(any("instanceRepo" in x for x in p))
        self.assertTrue(any("storage.bucket: missing" in x for x in p))

    def test_no_organisation_data_in_examples(self):
        # this repo is public: the example instance names only example.org and public services
        allowed_hosts = {"github.com", "fsn1.your-objectstorage.com", "example.cloudflareaccess.com", "api.cloudflare.com"}
        for f in EXAMPLE.rglob("*"):
            if not (f.is_file() and f.suffix in {".json", ".yaml", ".env"}):
                continue
            text = f.read_text()
            for email in re.findall(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)", text):
                self.assertTrue(email == "example.org" or email == "github.com", f"{f}: email domain {email}")
            for host in re.findall(r"\b((?:[a-z0-9-]+\.)+(?:com|org|net|uk|cn|hk))\b", text.lower()):
                self.assertTrue(host.endswith("example.org") or host in allowed_hosts, f"{f}: host {host}")


class Scaffold(unittest.TestCase):
    def test_reproduces_the_committed_example(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            shutil.copy(EXAMPLE / "instance.json", repo)
            shutil.copy(EXAMPLE / "age.pub", repo)
            (repo / "deploy").mkdir()
            shutil.copy(EXAMPLE / "deploy/secrets.enc.yaml", repo / "deploy")
            (repo / "apps/hello").mkdir(parents=True)
            shutil.copy(EXAMPLE / "apps/hello/tunnel.enc.yaml", repo / "apps/hello")
            run(["scaffold", str(repo), "--base", "../../base", "--app-base", "../../../app-base"])
            for rel in ["deploy/kustomization.yaml", "deploy/instance.env", "flux/sync.yaml", "flux/bootstrap-apps.yaml", ".sops.yaml",
                        "apps/hello/kustomization.yaml"]:
                self.assertEqual((repo / rel).read_text(), (EXAMPLE / rel).read_text(), rel)

    def test_real_instances_pin_the_remote_base(self):
        c = json.loads((EXAMPLE / "instance.json").read_text())
        k = instance.render_kustomization(c)
        self.assertIn(f"https://github.com/DE0CH/jarvis3//deploy/base?ref={c['jarvis3']['ref']}", k)

    def test_flux_applies_as_the_limited_identity_with_sops(self):
        s = (EXAMPLE / "flux/sync.yaml").read_text()
        self.assertIn("serviceAccountName: flux-applier", s)
        self.assertIn("provider: sops", s)
        self.assertIn("ssh://git@github.com/example-org/example-jarvis.git", s)

    def test_check_passes_on_example_and_catches_drift(self):
        self.assertEqual(instance.check(EXAMPLE), [])
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "r"
            shutil.copytree(EXAMPLE, repo)
            cfg = json.loads((repo / "deploy/config.json").read_text())
            cfg["orgEnv"]["mirrorPath"] = "/elsewhere"
            cfg["publicUrl"] = "https://other.example.org"
            (repo / "deploy/config.json").write_text(json.dumps(cfg))
            p = instance.check(repo)
            self.assertTrue(any("mirrorPath" in x for x in p))
            self.assertTrue(any("publicUrl" in x for x in p))


class Cloudflare(unittest.TestCase):
    def test_dry_run_makes_no_call_and_prints_no_secret(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(instance.urllib.request, "urlopen", no_network):
            out = run(["cloudflare", str(EXAMPLE), "--out", f"{td}/cf.env"], SECRET_ENV)
            self.assertFalse(Path(f"{td}/cf.env").exists())
        for s in SECRETS:
            self.assertNotIn(s, out)
        lines = [l for l in out.splitlines() if l.startswith("DRY ")]
        order = [next(i for i, l in enumerate(lines) if frag in l) for frag in
                 ["/access/identity_providers", "/access/service_tokens", "POST https://api.cloudflare.com/client/v4/accounts/<Cloudflare account id>/access/apps ",
                  "/cfd_tunnel", "/dns_records"]]
        self.assertEqual(order, sorted(order), "Access before the tunnel, DNS last")
        self.assertIn('"client_secret": "<redacted>"', out)

    def test_apply_against_a_fake_api(self):
        fake = FakeCloudflare()
        with tempfile.TemporaryDirectory() as td, mock.patch.object(instance.urllib.request, "urlopen", fake):
            outf = Path(td) / "cf.env"
            out = run(["cloudflare", str(EXAMPLE), "--out", str(outf), "--apply"], SECRET_ENV)
            self.assertEqual(stat.S_IMODE(outf.stat().st_mode), 0o600)
            vals = instance.read_env_file(outf)
            self.assertEqual(vals["TUNNEL_TOKEN"], SECRET_ENV["TUNNEL_TOKEN"])
            self.assertEqual(vals["SESSION_GATE_CLIENT_SECRET"], SECRET_ENV["SESSION_GATE_CLIENT_SECRET"])
            for s in SECRETS:
                self.assertNotIn(s, out)
            self.assertIn("access.audience=aud-tag", out)
            self.assertIn("access.sessionGateClientId=gate.access", out)
            app = fake.apps[0]
            self.assertEqual(app["domain"], "jarvis.example.org")
            self.assertEqual(app["allowed_idps"], [fake.idps[0]["id"]])
            pols = fake.policies[app["id"]]
            self.assertEqual([p["decision"] for p in pols], ["allow", "non_identity"])
            self.assertEqual(pols[0]["include"], [{"email_domain": {"domain": "example.org"}}])
            self.assertEqual(pols[1]["include"], [{"any_valid_service_token": {}}])
            self.assertEqual(fake.ingresses["tun1"]["config"]["ingress"][0]["service"], "http://server.jarvis3.svc.cluster.local:8080")
            self.assertEqual(fake.dns[0]["content"], "tun1.cfargotunnel.com")
            # the extra app: its own Access app (its emails, no service tokens), its own tunnel to its own Service
            xapp = fake.apps[1]
            self.assertEqual(xapp["domain"], "hello.example.org")
            self.assertNotIn("allowed_idps", xapp)
            xpols = fake.policies[xapp["id"]]
            self.assertEqual([p["decision"] for p in xpols], ["allow"])
            self.assertEqual(xpols[0]["include"], [{"email": {"email": "owner@example.org"}}, {"email": {"email": "colleague@example.org"}}])
            self.assertEqual([t["name"] for t in fake.tunnels], ["example-jarvis3", "example-app-hello"])
            self.assertEqual(fake.ingresses["tun2"]["config"]["ingress"][0],
                             {"hostname": "hello.example.org", "service": "http://whoami.app-hello.svc.cluster.local:8080", "originRequest": {}})
            self.assertEqual(fake.dns[1]["name"], "hello.example.org")
            self.assertEqual(fake.dns[1]["content"], "tun2.cfargotunnel.com")
            self.assertEqual(vals["APP_HELLO_TUNNEL_TOKEN"], APP_TUNNEL_TOKEN)
            # the app's Access app exists before its DNS record
            names = [c for c in fake.calls]
            self.assertLess(names.index(("POST", "/accounts/<Cloudflare account id>/access/apps")), names.index(("POST", "/zones/<zone id of example.org>/dns_records")))
            # second run: idempotent, the gate token is kept (its secret is in the out file)
            run(["cloudflare", str(EXAMPLE), "--out", str(outf), "--apply"], SECRET_ENV)
            self.assertEqual(len(fake.tokens), 1)
            self.assertEqual(len(fake.apps), 2)
            self.assertEqual(len(fake.tunnels), 2)
            self.assertEqual(len(fake.policies[app["id"]]), 2)
            self.assertEqual(len(fake.dns), 2)
            self.assertNotIn(("DELETE", f"/accounts/<Cloudflare account id>/access/service_tokens/{fake.tokens[0]['id']}"), fake.calls)

    def test_apply_needs_the_token(self):
        env = {k: v for k, v in SECRET_ENV.items() if k != "CLOUDFLARE_API_TOKEN"}
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            run(["cloudflare", str(EXAMPLE), "--out", "/nonexistent/x", "--apply"], env)


class Secrets(unittest.TestCase):
    keys = ["JARVIS_DB_KEY", "OPENROUTER_MANAGEMENT_KEY", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "CF_DEVICE_TOKENS_API",
            "SESSION_GATE_CLIENT_SECRET", "TUNNEL_TOKEN", "ORG_ENV_DEPLOY_KEY"]

    def test_dry_run_names_only(self):
        out = run(["secrets", str(EXAMPLE), *self.keys], SECRET_ENV)
        self.assertIn("jarvis-secrets: CF_DEVICE_TOKENS_API", out)
        self.assertIn("tunnel-token: token", out)
        for s in SECRETS:
            self.assertNotIn(s, out)

    def test_every_key_must_be_named(self):
        with self.assertRaises(SystemExit) as e:
            run(["secrets", str(EXAMPLE), *self.keys[:-1]], SECRET_ENV)
        self.assertIn("ORG_ENV_DEPLOY_KEY", str(e.exception))
        with self.assertRaises(SystemExit):
            run(["secrets", str(EXAMPLE), *self.keys, "NOT_A_SECRET"], dict(SECRET_ENV, NOT_A_SECRET="x"))

    @unittest.skipUnless(shutil.which("sops") and shutil.which("age-keygen"), "needs sops and age")
    def test_sops_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "r"
            repo.mkdir()
            shutil.copy(EXAMPLE / "instance.json", repo)
            run(["age-key", str(repo), "--out", f"{td}/age.key"])
            self.assertEqual(stat.S_IMODE(Path(f"{td}/age.key").stat().st_mode), 0o600)
            run(["scaffold", str(repo)])
            self.assertIn('jarvis3/secrets-rev: "none"', (repo / "deploy/kustomization.yaml").read_text())
            out = run(["secrets", str(repo), *self.keys, "--apply"], SECRET_ENV)
            self.assertIn(f'jarvis3/secrets-rev: "{instance.secrets_rev(repo)}"', (repo / "deploy/kustomization.yaml").read_text())
            for s in SECRETS:
                self.assertNotIn(s, out)
            enc = (repo / "deploy/secrets.enc.yaml").read_text()
            for s in SECRETS:
                self.assertNotIn(s, enc)
            self.assertEqual(enc.count("\nsops:"), 3)
            dec = subprocess.run(["sops", "-d", str(repo / "deploy/secrets.enc.yaml")], env=dict(os.environ, SOPS_AGE_KEY_FILE=f"{td}/age.key"),
                                 check=True, capture_output=True, text=True).stdout
            self.assertIn(SECRET_ENV["JARVIS_DB_KEY"], dec)
            self.assertIn(SECRET_ENV["ORG_ENV_DEPLOY_KEY"], dec)

    @unittest.skipUnless(shutil.which("sops"), "needs sops")
    def test_committed_example_secrets_are_encrypted_to_its_key(self):
        dec = subprocess.run(["sops", "-d", str(EXAMPLE / "deploy/secrets.enc.yaml")],
                             env=dict(os.environ, SOPS_AGE_KEY_FILE=str(EXAMPLE / "TEST-ONLY-age.key")), check=True, capture_output=True, text=True).stdout
        self.assertIn("name: jarvis-secrets", dec)


class Box(unittest.TestCase):
    def test_dry_run(self):
        with mock.patch.object(instance.urllib.request, "urlopen", no_network):
            out = run(["box", str(EXAMPLE), "--age-key", "/nonexistent/age", "--flux-key", "/nonexistent/flux"], SECRET_ENV)
        self.assertIn('"rules": []', out)
        self.assertIn('"user_data": "<redacted>"', out)
        self.assertIn("DRY POST https://api.hetzner.cloud/v1/servers", out)
        self.assertIn("DRY DELETE https://api.hetzner.cloud/v1/ssh_keys/0", out)

    def test_user_data(self):
        c = json.loads((EXAMPLE / "instance.json").read_text())
        ud = instance.user_data(c, EXAMPLE, "AGE-SECRET-KEY-1FAKE\n", "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n")
        self.assertLess(len(ud.encode()), 32 * 1024)
        self.assertTrue(ud.startswith("#!/bin/bash\n"))
        subprocess.run(["bash", "-n"], input=ud, text=True, check=True)
        # the variables really are what the script gets
        got = subprocess.run(["bash", "-c", ud.split("set -uo pipefail")[0] + 'printf "%s|%s|%s" "$K3S_VERSION" "$FLUX_VERSION" "$AGE_KEY"'],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(got, "v1.34.12+k3s1|2.9.6|AGE-SECRET-KEY-1FAKE\n")
        self.assertIn("name: flux-applier", ud)
        self.assertIn("kind: Kustomization", ud)

    def test_apply_against_a_fake_api(self):
        calls = []

        def fake(req):
            m, path = req.get_method(), req.full_url.split("/v1", 1)[1]
            body = json.loads(req.data) if req.data else None
            calls.append((m, path, body))
            if m == "GET":
                return Resp({"servers": [], "firewalls": []})
            if path == "/ssh_keys":
                return Resp({"ssh_key": {"id": 7}})
            if path == "/firewalls":
                return Resp({"firewall": {"id": 8}})
            if path == "/servers":
                return Resp({"server": {"id": 9, "public_net": {"ipv4": {"ip": "192.0.2.1"}}}})
            return Resp({})

        with tempfile.TemporaryDirectory() as td, mock.patch.object(instance.urllib.request, "urlopen", fake):
            Path(f"{td}/age").write_text("AGE-SECRET-KEY-1FAKE\n")
            Path(f"{td}/flux").write_text("fake flux key\n")
            out = run(["box", str(EXAMPLE), "--age-key", f"{td}/age", "--flux-key", f"{td}/flux", "--apply"], SECRET_ENV)
        self.assertNotIn("AGE-SECRET-KEY-1FAKE", out)
        server = next(b for m, p, b in calls if m == "POST" and p == "/servers")
        self.assertEqual(server["firewalls"], [{"firewall": 8}])
        self.assertIn("AGE-SECRET-KEY-1FAKE", server["user_data"])
        fw = next(b for m, p, b in calls if m == "POST" and p == "/firewalls")
        self.assertEqual(fw["rules"], [])
        self.assertEqual(calls[-1][:2], ("DELETE", "/ssh_keys/7"))


class DeployKeys(unittest.TestCase):
    def test_dry_run(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(instance.urllib.request, "urlopen", no_network):
            out = run(["deploy-keys", str(EXAMPLE), "--out-dir", td], SECRET_ENV)
            self.assertEqual(os.listdir(td), [])
        self.assertIn("DRY POST https://api.github.com/repos/example-org/example-jarvis/keys", out)
        self.assertIn("DRY POST https://api.github.com/repos/example-org/example-env/keys", out)
        self.assertIn('"read_only": true', out)


if __name__ == "__main__":
    unittest.main()


class ExtraApps(unittest.TestCase):
    def config(self, **app):
        c = json.loads((EXAMPLE / "instance.json").read_text())
        c["apps"] = [dict(c["apps"][0], **app)]
        return c

    def test_origin_must_be_a_service_of_the_app_itself(self):
        for origin in ["http://server.jarvis3.svc.cluster.local:8080", "http://whoami.app-other.svc.cluster.local", "http://10.0.0.1:80",
                       "http://whoami.app-hello.svc.cluster.local.evil.example.org"]:
            self.assertTrue(any("origin" in p for p in instance.validate_instance(self.config(origin=origin))), origin)
        self.assertEqual(instance.validate_instance(self.config()), [])

    def test_bad_apps_are_named(self):
        self.assertTrue(any("hostname" in p for p in instance.validate_instance(self.config(hostname="jarvis.example.org"))))
        self.assertTrue(any("accessEmails" in p for p in instance.validate_instance(self.config(accessEmails=[]))))
        self.assertTrue(any(".name" in p for p in instance.validate_instance(self.config(name="Bad_Name"))))
        c = self.config()
        c["apps"].append(dict(c["apps"][0]))
        self.assertTrue(any("twice" in p for p in instance.validate_instance(c)))

    def test_each_app_is_applied_as_its_own_namespace_admin(self):
        sync = (EXAMPLE / "flux/sync.yaml").read_text()
        self.assertIn("name: app-hello, namespace: flux-system", sync)
        self.assertIn("path: ./apps/hello", sync)
        self.assertIn("targetNamespace: app-hello", sync)
        self.assertIn("serviceAccountName: flux-app-hello", sync)
        boot = (EXAMPLE / "flux/bootstrap-apps.yaml").read_text()
        self.assertIn("name: app-hello", boot)
        self.assertIn("pod-security.kubernetes.io/enforce: restricted", boot)
        self.assertIn("kind: RoleBinding", boot)
        self.assertNotIn("ClusterRoleBinding", boot)
        self.assertIn("subjects: [{ kind: ServiceAccount, name: flux-app-hello, namespace: flux-system }]", boot)

    def test_the_box_bootstrap_makes_the_app_namespaces(self):
        c = json.loads((EXAMPLE / "instance.json").read_text())
        ud = instance.user_data(c, EXAMPLE, "AGE-SECRET-KEY-1FAKE\n", "fake")
        self.assertIn("flux-app-hello", ud)
        self.assertIn("name: jarvis3", ud)

    def test_real_app_kustomizations_pin_the_remote_app_base(self):
        c = json.loads((EXAMPLE / "instance.json").read_text())
        k = instance.render_app_kustomization(c, c["apps"][0])
        self.assertIn(f"https://github.com/DE0CH/jarvis3//deploy/app-base?ref={c['jarvis3']['ref']}", k)
        self.assertIn("namespace: app-hello", k)

    def test_check_wants_the_apps_files_and_no_strays(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "r"
            shutil.copytree(EXAMPLE, repo)
            (repo / "apps/hello/tunnel.enc.yaml").unlink()
            (repo / "apps/stray").mkdir()
            p = instance.check(repo)
            self.assertTrue(any("apps/hello/tunnel.enc.yaml missing" in x for x in p), p)
            self.assertTrue(any("apps/stray/" in x for x in p), p)

    def test_secrets_routes_an_app_token_to_its_own_file(self):
        out = run(["secrets", str(EXAMPLE), "APP_HELLO_TUNNEL_TOKEN"], {"APP_HELLO_TUNNEL_TOKEN": APP_TUNNEL_TOKEN})
        self.assertIn("would write apps/hello/tunnel.enc.yaml with tunnel-token: token", out)
        self.assertNotIn("deploy/secrets.enc.yaml", out)
        self.assertNotIn(APP_TUNNEL_TOKEN, out)
        with self.assertRaises(SystemExit):
            run(["secrets", str(EXAMPLE), "APP_NOPE_TUNNEL_TOKEN"], {"APP_NOPE_TUNNEL_TOKEN": "x"})

    @unittest.skipUnless(shutil.which("sops"), "needs sops")
    def test_committed_example_app_token_is_encrypted_to_its_key(self):
        enc = (EXAMPLE / "apps/hello/tunnel.enc.yaml").read_text()
        self.assertIn("\nsops:", enc)
        dec = subprocess.run(["sops", "-d", str(EXAMPLE / "apps/hello/tunnel.enc.yaml")],
                             env=dict(os.environ, SOPS_AGE_KEY_FILE=str(EXAMPLE / "TEST-ONLY-age.key")), check=True, capture_output=True, text=True).stdout
        self.assertIn("name: tunnel-token", dec)
