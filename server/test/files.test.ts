// The users' files and first-prompt attachments: upload, list, download links, rename, delete,
// limits, per-user isolation, the session's view of its owner's files, and attachments reaching
// the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { harness, seedUsers, call, upload, asEmail, asService, createTask, fakeSession, machineOf, GATE, type Harness } from "./helpers.ts";
import { contentTypeFor, filePath } from "../src/files.ts";
import { attachmentDisposition } from "../src/s3.ts";

async function withUsers(fn: (h: Harness, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>, config = {}) {
  const h = await harness({ config });
  try {
    await fn(h, await seedUsers(h));
  } finally {
    await h.close();
  }
}

const objects = (h: Harness) => [...h.blobs.objects.keys()].filter((k) => k.startsWith("files/"));

test("file paths: what is accepted and what is refused", () => {
  assert.equal(filePath("/a/b c/ä.txt/"), "a/b c/ä.txt");
  for (const bad of ["", "/", "a//b", "a/../b", "./a", "a/.", "a\\b", "a\u0000b", "x".repeat(256), "a/".repeat(300) + "b"]) {
    assert.throws(() => filePath(bad), /file path/, JSON.stringify(bad));
  }
  assert.equal(contentTypeFor("x.PDF", undefined), "application/pdf");
  assert.equal(contentTypeFor("x.bin", "application/octet-stream"), "application/octet-stream");
  assert.equal(contentTypeFor("x.txt", "text/plain; charset=utf-8"), "text/plain");
  assert.equal(contentTypeFor("x.txt", "bad type"), "text/plain");
  assert.equal(attachmentDisposition('Q3 "report" é.pdf'), `attachment; filename="Q3 _report_ _.pdf"; filename*=UTF-8''Q3%20%22report%22%20%C3%A9.pdf`);
});

test("upload, list, replace, download link, rename, delete", () =>
  withUsers(async (h, u) => {
    const alice = await asEmail(h, u.alice);
    const put = await upload(h, alice, "/api/users/me/files/reports/Q3%20summary.txt", "hello world");
    assert.equal(put.status, 201, JSON.stringify(put.body));
    assert.deepEqual({ ...put.body, updatedAt: undefined }, { path: "reports/Q3 summary.txt", size: 11, contentType: "text/plain", source: "user", taskId: null, updatedAt: undefined });
    assert.equal((await upload(h, alice, "/api/users/me/files/photo.png", new Uint8Array([1, 2, 3]), "image/png")).status, 201);

    let list = (await call(h, alice, "GET", "/api/users/me/files")).body;
    assert.deepEqual(list.files.map((f: { path: string }) => f.path), ["photo.png", "reports/Q3 summary.txt"]);
    assert.equal(list.usedBytes, 14);
    assert.equal(list.quotaBytes, 1024 ** 3);
    assert.equal(list.maxFileBytes, 50 * 1024 ** 2);
    assert.equal(objects(h).length, 2);

    // replacing: 200, the old object is gone, one object per file
    const before = new Set(objects(h));
    const again = await upload(h, alice, "/api/users/me/files/reports/Q3%20summary.txt", "hello again!");
    assert.equal(again.status, 200);
    assert.equal(again.body.size, 12);
    assert.equal(objects(h).length, 2);
    assert.equal(objects(h).filter((k) => !before.has(k)).length, 1);

    // download: a redirect to a short-lived link that forces a download under the file's name
    const dl = await call(h, alice, "GET", "/api/users/me/files/reports/Q3%20summary.txt");
    assert.equal(dl.status, 302);
    const loc = dl.headers.get("location")!;
    assert.match(loc, /^fake-s3:\/\/get\/files\/[^/]+\/[0-9a-f]+\?expires=600&download=Q3%20summary\.txt$/);
    const key = /get\/([^?]+)/.exec(loc)![1]!;
    assert.equal(new TextDecoder().decode(h.blobs.objects.get(key)!), "hello again!");
    const link = await call(h, alice, "GET", "/api/users/me/files/reports/Q3%20summary.txt?link=1");
    assert.equal(link.status, 200);
    assert.equal(link.body.url, loc);
    assert.ok(Date.parse(link.body.expiresAt) > h.clock.now());

    // rename: the object stays, the path changes
    const mv = await call(h, alice, "POST", "/api/users/me/files/move", { from: "reports/Q3 summary.txt", to: "archive/2026/Q3.txt" });
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    assert.equal(mv.body.path, "archive/2026/Q3.txt");
    assert.equal(objects(h).length, 2);
    assert.equal((await call(h, alice, "GET", "/api/users/me/files/reports/Q3%20summary.txt")).status, 404);
    assert.equal((await call(h, alice, "POST", "/api/users/me/files/move", { from: "photo.png", to: "archive/2026/Q3.txt" })).status, 409);
    assert.equal((await call(h, alice, "POST", "/api/users/me/files/move", { from: "nope.txt", to: "x.txt" })).status, 404);
    assert.equal((await call(h, alice, "POST", "/api/users/me/files/move", { from: "photo.png", to: "archive" })).status, 409, "a folder");
    assert.equal((await call(h, alice, "POST", "/api/users/me/files/move", { from: "photo.png", to: "../x" })).status, 400);

    // a file and a folder can't share a name
    assert.equal((await upload(h, alice, "/api/users/me/files/photo.png/x.txt", "x")).status, 409);
    assert.equal((await upload(h, alice, "/api/users/me/files/archive", "x")).status, 409);

    // delete: the row and the object
    assert.equal((await call(h, alice, "DELETE", "/api/users/me/files/photo.png")).status, 200);
    assert.equal((await call(h, alice, "DELETE", "/api/users/me/files/photo.png")).status, 404);
    list = (await call(h, alice, "GET", "/api/users/me/files")).body;
    assert.deepEqual(list.files.map((f: { path: string }) => f.path), ["archive/2026/Q3.txt"]);
    assert.equal(objects(h).length, 1);
    assert.equal((await upload(h, alice, "/api/users/me/files/a/..%2Fb", "x")).status, 400);
  }));

test("limits: per file, per person, and a body needs its length", () =>
  withUsers(
    async (h, u) => {
      const alice = await asEmail(h, u.alice);
      const big = await upload(h, alice, "/api/users/me/files/big.bin", new Uint8Array(101));
      assert.equal(big.status, 413);
      assert.equal(big.body.error.code, "too_large");
      assert.equal((await upload(h, alice, "/api/users/me/files/a.bin", new Uint8Array(100))).status, 201);
      assert.equal((await upload(h, alice, "/api/users/me/files/b.bin", new Uint8Array(100))).status, 201);
      const over = await upload(h, alice, "/api/users/me/files/c.bin", new Uint8Array(51));
      assert.equal(over.status, 413);
      assert.match(over.body.error.message, /storage/);
      // replacing a file counts its new size only
      assert.equal((await upload(h, alice, "/api/users/me/files/b.bin", new Uint8Array(50))).status, 200);
      assert.equal((await upload(h, alice, "/api/users/me/files/c.bin", new Uint8Array(100))).status, 201);
      assert.equal((await call(h, alice, "GET", "/api/users/me/files")).body.usedBytes, 250);
      assert.equal(objects(h).length, 3, "nothing left behind by refused uploads");
      // chunked (no Content-Length)
      const jwt = alice.jwt!;
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(h.base + "/api/users/me/files/chunked.txt", { method: "PUT", headers: { "cf-access-jwt-assertion": jwt, "transfer-encoding": "chunked" } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.write("abc");
        req.end();
      });
      assert.equal(status, 400);
      // bob's quota is his own
      assert.equal((await upload(h, await asEmail(h, u.bob), "/api/users/me/files/a.bin", new Uint8Array(100))).status, 201);
    },
    { files: { maxFileBytes: 100, quotaBytes: 250 } },
  ));

test("another person's files are a uniform 404; an admin sees and manages them", () =>
  withUsers(async (h, u) => {
    const alice = await asEmail(h, u.alice);
    const bob = await asEmail(h, u.bob);
    const admin = await asEmail(h, u.admin);
    const aliceId = (await call(h, alice, "GET", "/api/me")).body.user.id;
    await upload(h, alice, "/api/users/me/files/secret.txt", "alice only");
    const theirs = await call(h, bob, "GET", `/api/users/${aliceId}/files/secret.txt`);
    const missing = await call(h, bob, "GET", `/api/users/nobody/files/secret.txt`);
    assert.equal(theirs.status, 404);
    assert.deepEqual(theirs.body, missing.body);
    assert.equal((await call(h, bob, "GET", `/api/users/${aliceId}/files`)).status, 404);
    assert.equal((await upload(h, bob, `/api/users/${aliceId}/files/planted.txt`, "x")).status, 404);
    assert.equal((await call(h, bob, "DELETE", `/api/users/${aliceId}/files/secret.txt`)).status, 404);
    assert.equal((await call(h, bob, "POST", `/api/users/${aliceId}/files/move`, { from: "secret.txt", to: "x.txt" })).status, 404);
    // bob's own list doesn't show it, and bob's "me" is bob
    assert.deepEqual((await call(h, bob, "GET", "/api/users/me/files")).body.files, []);
    assert.equal((await call(h, bob, "GET", "/api/users/me/files/secret.txt")).status, 404);
    // the admin sees everything
    assert.deepEqual((await call(h, admin, "GET", `/api/users/${aliceId}/files`)).body.files.map((f: { path: string }) => f.path), ["secret.txt"]);
    assert.equal((await call(h, admin, "GET", `/api/users/${aliceId}/files/secret.txt`)).status, 302);
  }));

test("a session sees and saves only its owner's files", () =>
  withUsers(async (h, u) => {
    const alice = await asEmail(h, u.alice);
    await upload(h, alice, "/api/users/me/files/notes/brief.md", "# Brief");
    await upload(h, await asEmail(h, u.bob), "/api/users/me/files/bob.txt", "bob's");
    const taskId = await createTask(h, u.alice);
    const s = await fakeSession(h, taskId);
    const sess = await asService(h, GATE, s.token);
    const list = await call(h, sess, "GET", "/api/session/files");
    assert.deepEqual(list.body.files.map((f: { path: string }) => f.path), ["notes/brief.md"]);
    const link = await call(h, sess, "GET", "/api/session/files/notes/brief.md");
    assert.equal(link.status, 200, "JSON, never a redirect that would carry the session's headers");
    assert.match(link.body.url, /^fake-s3:\/\/get\/files\//);
    assert.equal((await call(h, sess, "GET", "/api/session/files/bob.txt")).status, 404);
    const saved = await upload(h, sess, "/api/session/files/out/report.csv", new TextEncoder().encode("a,b\n1,2\n"));
    assert.equal(saved.status, 201);
    assert.equal(saved.body.source, "session");
    assert.equal(saved.body.taskId, taskId);
    assert.equal(saved.body.contentType, "text/csv");
    assert.ok((await call(h, alice, "GET", "/api/users/me/files")).body.files.some((f: { path: string }) => f.path === "out/report.csv"));
    // the gate token alone, or a user, can't use the session routes
    assert.equal((await call(h, await asService(h, GATE), "GET", "/api/session/files")).status, 401);
    assert.equal((await call(h, alice, "GET", "/api/session/files")).status, 401);
  }));

test("attachments: checked against the caller's files and handed to the first machine only", () =>
  withUsers(async (h, u) => {
    const alice = await asEmail(h, u.alice);
    await upload(h, alice, "/api/users/me/files/attachments/r1/brief.pdf", "%PDF");
    await upload(h, alice, "/api/users/me/files/attachments/r1/photo.jpg", "jpg");
    await upload(h, await asEmail(h, u.bob), "/api/users/me/files/bob.txt", "bob's");
    const bad = await call(h, alice, "POST", "/api/tasks", { prompt: "x", attachments: ["bob.txt"] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /not in your files/);
    assert.equal((await call(h, alice, "POST", "/api/tasks", { prompt: "x", attachments: "a.txt" })).status, 400);
    assert.equal((await call(h, alice, "POST", "/api/tasks", { prompt: "x", attachments: Array(21).fill("a") })).status, 400);
    const r = await call(h, alice, "POST", "/api/tasks", { prompt: "Summarise these", attachments: ["attachments/r1/brief.pdf", "attachments/r1/photo.jpg", "attachments/r1/brief.pdf"], requestId: "r1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.attachments, ["attachments/r1/brief.pdf", "attachments/r1/photo.jpg"]);
    await h.jarvis.settle();
    const m = machineOf(h, r.body.id)!;
    assert.deepEqual(JSON.parse(m.env.JARVIS_ATTACHMENTS!), ["attachments/r1/brief.pdf", "attachments/r1/photo.jpg"]);
    assert.equal(m.env.JARVIS_MODEL_IMAGES, undefined, "the test models don't declare image input");
    // a resume doesn't re-send them
    await fakeSession(h, r.body.id);
    assert.equal((await call(h, alice, "POST", `/api/tasks/${r.body.id}/pause`)).status, 202);
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "POST", `/api/tasks/${r.body.id}/resume`)).status, 202);
    await h.jarvis.settle();
    const m2 = machineOf(h, r.body.id)!;
    assert.notEqual(m2.id, m.id);
    assert.equal(m2.env.JARVIS_ATTACHMENTS, undefined);
    assert.equal(m2.env.JARVIS_FIRST_PROMPT, undefined);
    // a task without attachments says []
    const plain = await call(h, alice, "POST", "/api/tasks", { prompt: "no files" });
    assert.deepEqual(plain.body.attachments, []);
    await h.jarvis.settle();
    assert.equal(machineOf(h, plain.body.id)!.env.JARVIS_ATTACHMENTS, undefined);
  }));

test("me.features names files and search", () =>
  withUsers(async (h, u) => {
    const me = await call(h, await asEmail(h, u.alice), "GET", "/api/me");
    assert.equal(me.body.features.files, true);
    assert.equal(me.body.features.search, true);
  }));
