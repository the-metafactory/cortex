import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticTestEnv } from "./lib/test-home";
import { queryBinding, queryRegistry, queryRig, syntheticQueryPage } from "../src/conversations/domain-adapters/reads/query-fixtures";
import { ReadBindings } from "../src/conversations/domain-adapters/reads/bindings";

async function probe() {
  const item = await queryRig();
  try {
    let page = 0;
    item.rig.hooks.query = request => {
      assert.equal(request.cursor, page === 0 ? undefined : "synthetic protected cursor");
      return Promise.resolve(syntheticQueryPage([`page-${++page}`], "synthetic protected cursor"));
    };
    const request = await item.runner.create(item.rig.context, [item.source], item.rig.sink);
    const first = await item.runner.run(item.rig.context, request, item.rig.sink);
    assert.ok(first.continuation);
    assert.equal(item.rig.calls.sends.length, 1);
    console.log("page 1: released; opaque continuation issued");
    const second = await item.runner.run(item.rig.context, { ...request, continuation: first.continuation }, item.rig.sink);
    assert.ok(second.continuation);
    assert.equal(item.rig.calls.sends.length, 2);
    console.log("continue: page 2 released; exact protected cursor used");
    const changedRegistry = queryRegistry("1.0.1");
    const changed = new ReadBindings(changedRegistry);
    const pin = { ...queryBinding.outputSchemaRef, version: "1.0.1" };
    assert.ok(changed.register({ ...queryBinding, outputSchemaRef: pin }, { adapterId: item.source.adapterId, connectionId: item.source.connectionId, readCapabilityIds: [item.source.capabilityId] }).ok);
    item.rig.bindings.readBindings = changed;
    const rejected = await item.runner.run(item.rig.context, { ...request, continuation: second.continuation }, item.rig.sink);
    assert.equal(rejected.restartRequired, true);
    assert.equal(item.rig.calls.read, 2);
    console.log("schema pin changed: continuation rejected before fetch; restart required");
    item.rig.bindings.readBindings = item.rig.readBindings;
    const slowRequest = await item.runner.create(item.rig.context, [item.source], item.rig.sink);
    const entered = Promise.withResolvers<AbortSignal>();
    const late = Promise.withResolvers<unknown>();
    item.rig.hooks.query = (_request, signal) => { entered.resolve(signal); return late.promise; };
    const pending = item.runner.run(item.rig.context, slowRequest, item.rig.sink);
    const signal = await entered.promise;
    await item.runner.cancel(slowRequest.queryId);
    assert.equal(signal.aborted, true);
    assert.equal((await pending).status, "cancelled");
    late.resolve(syntheticQueryPage(["late result"]));
    await Bun.sleep(10);
    assert.equal(item.rig.calls.sends.length, 2);
    console.log("cancel slow page: connector signal aborted; late result suppressed; prior pages retained");
  } finally { await item.rig.close(); }
}

if (process.argv.includes("--isolated")) await probe();
else {
  const root = await mkdtemp(join(tmpdir(), "desk-query-probe-"));
  try {
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    await mkdir(home);
    await mkdir(tmp);
    const child = Bun.spawn([process.execPath, import.meta.path, "--isolated"], { env: hermeticTestEnv(process.env, { home, tmp }), stdio: ["inherit", "inherit", "inherit"] });
    const code = await child.exited;
    if (code !== 0) process.exitCode = code;
  } finally { await rm(root, { recursive: true, force: true }); }
}
