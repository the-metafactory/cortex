import { afterEach, expect, test } from "bun:test";
import { access, readFile, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writerSupervisorFixture } from "../writer-fixtures";
import { writerLease } from "../../conversations/domain-adapters/operations/writer-authority";
import { implementationDigest, readWriterManifest } from "../writer-manifest";
import { readGuardedWriterService, verifyGuardedWriterService } from "../writer-service";

const rigs: Awaited<ReturnType<typeof writerSupervisorFixture>>[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(rig => rig.close())); });
async function rig(kind: "launchd" | "systemd" = "launchd") { const created = await writerSupervisorFixture(kind); rigs.push(created); return created; }
async function launch(fixture: Awaited<ReturnType<typeof rig>>, executable: string) {
  const child = Bun.spawn([join(fixture.root, "launch"), "test", executable, "start"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fixture.home } });
  return { code: await child.exited, stderr: await new Response(child.stderr).text() };
}

for (const kind of ["launchd", "systemd"] as const) {
  test(`${kind} checked retirement persists fencing and actual launcher rejects retired stable executable after reopen`, async () => {
    const fixture = await rig(kind);
    const begun = await fixture.writers.begin(fixture.plan, 0);
    const active = await fixture.writers.resume(begun.bindingKey, fixture.steps);
    expect(active.phase).toBe("active");
    expect(fixture.calls.some(argv => argv.includes(kind === "launchd" ? "bootout" : "mask"))).toBe(true);
    expect(fixture.calls.some(argv => argv.includes(kind === "launchd" ? "bootstrap" : "start"))).toBe(true);
    if (kind === "launchd") await expect(access(fixture.plan.entries[0]!.definition)).rejects.toThrow();
    else expect(fixture.state.masked).toBe(true);
    const bin = join(fixture.home, "cortex");
    await symlink(fixture.old, bin);
    const before = await readWriterManifest(fixture.root);
    expect((await launch(fixture, bin)).code).toBe(78);
    await fixture.reopen();
    expect((await launch(fixture, bin)).code).toBe(78);
    expect(await fixture.writers.current(writerLease(active), fixture.plan.binding)).toBe(true);
    await unlink(bin); await symlink(fixture.approved, bin);
    expect((await launch(fixture, bin)).code).toBe(0);
    expect((await readFile(join(fixture.home, "effects"), "utf8")).trim().split("\n")).toEqual(["approved"]);
    expect(await readWriterManifest(fixture.root)).toEqual(before);
    expect(await fixture.writers.resume(active.bindingKey, fixture.steps)).toEqual(active);
  });
}

for (const failure of ["disable", "bootout", "enable", "bootstrap"]) {
  test(`failed ${failure} command leaves lifecycle disabled with durable restart evidence`, async () => {
    const fixture = await rig();
    fixture.state.fail = failure;
    const begun = await fixture.writers.begin(fixture.plan, 0);
    await expect(fixture.writers.resume(begun.bindingKey, fixture.steps)).rejects.toThrow("Supervisor command failed");
    const record = await fixture.writers.read(begun.bindingKey);
    expect(record?.phase).not.toBe("active");
    expect(await fixture.writers.current(writerLease(record!), fixture.plan.binding)).toBe(false);
    expect((await launch(fixture, fixture.old)).code).toBe(78);
    await fixture.reopen();
    expect(await fixture.writers.read(begun.bindingKey)).toEqual(record);
    fixture.state.fail = "";
    expect((await fixture.writers.resume(begun.bindingKey, fixture.steps)).phase).toBe("active");
  });
}

for (const failure of ["stop", "mask", "show", "start"]) {
  test(`systemd failed ${failure} is checked and cannot certify cutover`, async () => {
    const fixture = await rig("systemd"); fixture.state.fail = failure;
    const begun = await fixture.writers.begin(fixture.plan, 0);
    await expect(fixture.writers.resume(begun.bindingKey, fixture.steps)).rejects.toThrow("Supervisor command failed");
    expect((await fixture.writers.read(begun.bindingKey))?.phase).not.toBe("active");
  });
}

test("unknown process inspection and remaining PIDs cannot activate; importer evidence survives denial", async () => {
  const fixture = await rig();
  const begun = await fixture.writers.begin(fixture.plan, 0);
  fixture.state.leftover = true;
  await expect(fixture.writers.resume(begun.bindingKey, fixture.steps)).rejects.toThrow("PIDs/jobs");
  fixture.state.leftover = false; fixture.state.inspectionFailure = true;
  await expect(fixture.writers.resume(begun.bindingKey, fixture.steps)).rejects.toThrow("inspection unavailable");
  expect((await fixture.host.journal.read(fixture.plan.knownCalls[0]!))?.journal.state).toBe("uncertain");
  expect((await launch(fixture, fixture.approved)).code).toBe(78);
});

test("rendered service validation rejects a launcher mentioned only as text and wrong stack", async () => {
  const fixture = await rig();
  await verifyGuardedWriterService(fixture.service, fixture.root, "test");
  await expect(verifyGuardedWriterService(fixture.service, fixture.root, "other")).rejects.toThrow("exact stack");
  await writeFile(fixture.service.definition, `<plist><dict><key>Label</key><string>${fixture.service.label}</string><key>ProgramArguments</key><array><string>${fixture.approved}</string></array><key>Description</key><string>${join(fixture.root, "launch")}</string></dict></plist>`);
  const begun = await fixture.writers.begin(fixture.plan, 0);
  await expect(fixture.writers.resume(begun.bindingKey, fixture.steps)).rejects.toThrow("exact stack");
  expect((await fixture.writers.read(begun.bindingKey))?.phase).toBe("disabled");
});

test("service renderer preserves floor and skips retired startup routes across re-render and rollback", async () => {
  const fixture = await rig();
  const launchDir = join(fixture.home, "Library/LaunchAgents");
  const configDir = join(fixture.home, "config");
  await mkdir(launchDir, { recursive: true }); await mkdir(configDir);
  await writeFile(join(configDir, "cortex.test.yaml"), "stack:\n  id: test\n");
  fixture.plan.entries[0]!.definition = join(launchDir, "ai.meta-factory.cortex.test.plist");
  const begun = await fixture.writers.begin(fixture.plan, 0);
  await fixture.writers.resume(begun.bindingKey, fixture.steps);
  const manifest = await readFile(join(fixture.root, "manifest.json"), "utf8");
  const script = `source scripts/lib/plist-render.sh\nrender_stack_plist "$PWD" "$1" "$2" test "$3"`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = Bun.spawn(["bash", "-c", script, "render", launchDir, configDir, process.execPath], { env: { ...process.env, HOME: fixture.home }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    await expect(access(fixture.plan.entries[0]!.definition)).rejects.toThrow();
    expect(await readFile(join(fixture.root, "manifest.json"), "utf8")).toBe(manifest);
  }
  const candidate = join(fixture.home, "cortex@.service");
  await writeFile(candidate, await readFile("src/services/cortex@.service", "utf8"));
  const child = Bun.spawn(["python3", "scripts/lib/guard-writer-service.py", "render", "systemd", candidate, candidate], { env: { ...process.env, HOME: fixture.home }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await readFile(candidate, "utf8")).toContain("writer-fence/launch %i");
  expect((await launch(fixture, fixture.old)).code).toBe(78);
});

test("retired manifest implementation and lower version cannot be restored; read evidence remains available", async () => {
  const fixture = await rig(); const begun = await fixture.writers.begin(fixture.plan, 0);
  const active = await fixture.writers.resume(begun.bindingKey, fixture.steps);
  const previous = await readWriterManifest(fixture.root);
  await expect(fixture.manifest.set({ ...active, plan: { ...active.plan, implementation: { ...active.plan.implementation, version: "1.0.0" } } }, false)).rejects.toThrow("downgrade");
  expect(await readWriterManifest(fixture.root)).toEqual(previous);
  expect((await fixture.host.journal.read(fixture.plan.sources[0]!.operationId))?.journal.state).toBe("uncertain");
  await writeFile(join(fixture.root, "manifest.json"), JSON.stringify({ version: 99 }));
  expect((await launch(fixture, fixture.approved)).code).toBe(78);
  expect((await fixture.host.journal.read(fixture.plan.sources[0]!.operationId))?.retryBlocked).toBe(true);
});

for (const kind of ["launchd", "systemd"] as const) {
  test(`${kind} actual rendered service enters the launcher through the stable executable path`, async () => {
    const fixture = await rig(kind); const begun = await fixture.writers.begin(fixture.plan, 0);
    await fixture.writers.resume(begun.bindingKey, fixture.steps);
    const service = await readGuardedWriterService(fixture.service);
    await unlink(fixture.stable); await symlink(fixture.old, fixture.stable);
    let child = Bun.spawn(service.argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fixture.home } });
    expect(await child.exited).toBe(78);
    await fixture.reopen();
    await unlink(fixture.stable); await symlink(fixture.approved, fixture.stable);
    child = Bun.spawn(service.argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fixture.home } });
    expect(await child.exited).toBe(0);
    expect((await readFile(join(fixture.home, "effects"), "utf8")).trim()).toBe("approved");
  });
}

test("implementation digest changes when an imported module changes while the entry file stays identical", async () => {
  const fixture = await rig();
  const entry = join(fixture.home, "entry.ts");
  const dependency = join(fixture.home, "dependency.ts");
  await writeFile(entry, 'import "./dependency";\n');
  await writeFile(dependency, "export const route = 1;\n");
  const before = await implementationDigest(entry);
  await writeFile(dependency, "export const route = 2;\n");
  expect(await implementationDigest(entry)).not.toBe(before);
  expect(await implementationDigest(fixture.approved)).toBe(fixture.plan.implementation.sha256);
});

test("implementation digest scans an executable with a shebang header and still follows its imports", async () => {
  const fixture = await rig();
  const entry = join(fixture.home, "shebang-entry.ts");
  const dependency = join(fixture.home, "shebang-dependency.ts");
  await writeFile(entry, '#!/usr/bin/env bun\nimport "./shebang-dependency";\n');
  await writeFile(dependency, "export const route = 1;\n");
  const before = await implementationDigest(entry);
  await writeFile(dependency, "export const route = 2;\n");
  expect(await implementationDigest(entry)).not.toBe(before);
});

test("launcher passes through a stack with no enrolled writer binding but refuses an enrolled stack's retired executable", async () => {
  const fixture = await rig();
  const begun = await fixture.writers.begin(fixture.plan, 0);
  await fixture.writers.resume(begun.bindingKey, fixture.steps);
  const other = Bun.spawn([join(fixture.root, "launch"), "unenrolled", fixture.old, "start"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fixture.home } });
  expect(await other.exited).toBe(0);
  expect((await launch(fixture, fixture.old)).code).toBe(78);
});
