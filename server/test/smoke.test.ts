import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, createTask, fakeSession, openWs, nextMessage } from "./helpers.ts";

test("smoke: create a task, session dials in, chat round-trips through the proxy", async () => {
  const h = await harness();
  try {
    const { alice } = await seedUsers(h);
    const me = await call(h, await asEmail(h, alice), "GET", "/api/me");
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const id = await createTask(h, alice);
    const s = await fakeSession(h, id);
    const t = await call(h, await asEmail(h, alice), "GET", `/api/tasks/${id}`);
    assert.equal(t.body.state, "running");
    const c = await openWs(h, await asEmail(h, alice), `/api/tasks/${id}/daemon`);
    c.send("hi");
    assert.equal(await nextMessage(c), "echo:hi");
    assert.match(s.opened[0]!.protocols[0]!, /^paseo\.bearer\./);
    c.close();
    s.ws.close();
  } finally {
    await h.close();
  }
});
