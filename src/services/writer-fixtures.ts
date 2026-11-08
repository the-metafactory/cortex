import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityPublication } from "../conversations/authority-publication";
import { AT, openJournalFixture } from "../conversations/domain-adapters/operations/fixtures";
import { legacyFixture, legacyContext } from "../conversations/domain-adapters/operations/legacy-fixtures";
import { importLegacyOperation, previewLegacyOperation, readLegacyImportWatermark } from "../conversations/domain-adapters/operations/legacy";
import { WriterAuthority, type WriterPlan, type WriterCutoverSteps } from "../conversations/domain-adapters/operations/writer-authority";
import { implementationDigest, PersistentWriterManifest } from "./writer-manifest";
import { ManagedWriterSupervisor, type SupervisorPlatform } from "./writer-supervisor";
import { renderGuardedWriterService } from "./writer-service";

export async function writerSupervisorFixture(kind: "launchd" | "systemd" = "launchd") {
  const home = await mkdtemp(join(tmpdir(), "writer-fence-"));
  const root = join(home, ".local/state/metafactory/cortex/writer-fence");
  await mkdir(root, { recursive: true });
  const executable = async (name: string, version: string): Promise<string> => {
    const path = join(home, name);
    await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\nprintf '%s\\n' '${name}' >> '${join(home, "effects")}'\n`, { mode: 0o700 });
    return path;
  };
  const old = await executable("retired", "1.0.0");
  const approved = await executable("approved", "2.0.0");
  const definition = join(home, kind === "launchd" ? "retired.plist" : "retired.service");
  await writeFile(definition, "retired synthetic startup");
  const service = { kind, label: kind === "launchd" ? "synthetic.guarded" : "synthetic.guarded.service", definition: join(home, kind === "launchd" ? "guarded.plist" : "synthetic.guarded.service") };
  const stable = join(home, ".local/bin/cortex");
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await symlink(approved, stable);
  await renderGuardedWriterService(service, root, "test", stable, join(home, "test.yaml"), home);
  const calls: string[][] = [];
  const state = { stopped: false, masked: false, disabled: false, fail: "", leftover: false, inspectionFailure: false };
  const platform: SupervisorPlatform = {
    run: argv => {
      calls.push(argv);
      if (state.fail && argv.includes(state.fail)) return Promise.resolve({ exitCode: 1, stdout: "synthetic command refused" });
      if (argv.includes("disable")) state.disabled = true;
      if (argv.includes("stop") || argv.includes("bootout")) state.stopped = true;
      if (argv.includes("mask")) state.masked = true;
      return Promise.resolve({ exitCode: 0, stdout: argv.includes("print-disabled") ? `"synthetic.retired" => ${String(state.disabled)}` : argv.includes("show") ? state.masked ? "masked\n" : "enabled\n" : "checked" });
    },
    pids: () => state.inspectionFailure ? Promise.reject(new Error("Process inspection unavailable")) : Promise.resolve(state.stopped && !state.leftover ? [] : [2147483646]),
    jobs: () => Promise.resolve(state.stopped ? [] : ["synthetic.retired"]),
  };
  const manifest = new PersistentWriterManifest(root);
  const supervisor = new ManagedWriterSupervisor(platform, manifest, "gui/501", service);
  const source = legacyFixture("running");
  const context = legacyContext(source);
  const preview = previewLegacyOperation(source, context);
  const plan: WriterPlan = { cutoverId: "synthetic-explicit-cutover", binding: { stack: "test", owner: "synthetic-owner", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create" }, implementation: { version: "2.0.0", sha256: await implementationDigest(approved) }, inventoryRef: "synthetic-complete-inventory", entries: [{ kind, label: "synthetic.retired", definition, pids: [2147483646], connectionQualified: false }], knownCalls: [source.record.operationId], sources: [{ operationId: source.record.operationId, sourceDigest: preview.sourceDigest }] };
  let host = await openJournalFixture(join(home, "durable.sqlite"));
  let writers = new WriterAuthority(host.engine, new AuthorityPublication());
  const steps: WriterCutoverSteps = {
    disable: record => supervisor.disable(record), stop: record => supervisor.stop(record),
    drain: async () => { await importLegacyOperation(host.journal, source, context, AT); return { drained: [], uncertain: [source.record.operationId] }; },
    verify: record => supervisor.verify(record),
    import: async () => { await importLegacyOperation(host.journal, source, context, AT); return readLegacyImportWatermark(host.journal, plan.sources); },
    watermark: () => readLegacyImportWatermark(host.journal, plan.sources), prepare: record => supervisor.prepare(record), enable: record => supervisor.enable(record),
  };
  const fixture = { home, root, old, approved, stable, service, supervisor, manifest, plan, steps, calls, state,
    get writers() { return writers; }, get host() { return host; },
    async reopen() { await host.close(); host = await openJournalFixture(join(home, "durable.sqlite")); writers = new WriterAuthority(host.engine, new AuthorityPublication()); },
    async close() { await host.close(); await rm(home, { recursive: true, force: true }); },
  };
  return fixture;
}
