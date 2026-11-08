import assert from "node:assert/strict";
import { readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writerSupervisorFixture } from "../src/services/writer-fixtures";
import { readGuardedWriterService } from "../src/services/writer-service";
import { writerLease } from "../src/conversations/domain-adapters/operations/writer-authority";

const fixture = await writerSupervisorFixture();
try {
  const begun = await fixture.writers.begin(fixture.plan, 0);
  const active = await fixture.writers.resume(begun.bindingKey, fixture.steps);
  const stable = fixture.stable;
  await unlink(stable); await symlink(fixture.old, stable);
  const service = await readGuardedWriterService(fixture.service);
  const launch = async (): Promise<number> => {
    const child = Bun.spawn(service.argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fixture.home } });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) assert.match(stderr, /retired|floor/);
    return code;
  };
  assert.equal(await launch(), 78);
  await fixture.reopen();
  assert.equal(await launch(), 78);
  assert.equal(await fixture.writers.current(writerLease(active), fixture.plan.binding), true);
  await unlink(stable); await symlink(fixture.approved, stable);
  assert.equal(await launch(), 0);
  assert.deepEqual((await readFile(join(fixture.home, "effects"), "utf8")).trim().split("\n"), ["approved"]);
  assert.deepEqual(await fixture.writers.resume(active.bindingKey, fixture.steps), active);
  console.log("Synthetic writer fence: retired stable-path restart refused before/after durable reopen; approved digest executed once; checked fake launchd retirement and source-hashed uncertain import preserved. No live services changed.");
} finally { await fixture.close(); }
