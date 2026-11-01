import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

globalThis.fetch = Object.assign(() => Promise.reject(new Error("Qualification prohibits network calls")), { preconnect: () => undefined });
const deadline = 20_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const waitForCrash = () => new Promise<void>(() => undefined);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
async function packageVersion(entryPoint: string) {
  const metadata: unknown = await Bun.file(new URL("../package.json", import.meta.resolve(entryPoint))).json();
  assert(metadata !== null && typeof metadata === "object" && "version" in metadata && typeof metadata.version === "string");
  assert.equal(metadata.version, "1.4.0");
  return metadata.version;
}
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const started = Date.now();
  while (!(await check())) {
    assert(Date.now() - started < deadline, `Timeout: ${label}`);
    await sleep(10);
  }
}
async function exists(path: string) {
  try { await readFile(path); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function records(root: Conversation) {
  const page = await root.entries({ order: "ascending" }, 1000, undefined, context);
  assert(!page.next, "Qualification transcript exceeds first page");
  return page.items;
}
async function open(store: string, phase = "normal", resumed = false) {
  const faux = fauxProvider({ models: [{ id: "first" }, { id: "second" }], tokensPerSecond: 1_000_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const owner = defineTool({
    name: "owner_create",
    description: "Simulated authoritative owner operation in a scratch ledger",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      if (phase === "before-owner" && !resumed) {
        await writeFile(`${store}.ready`, "owner intent committed, effect not performed");
        await waitForCrash();
      }
      await appendFile(`${store}.owner`, `${JSON.stringify({ operation: "create", correlation: "owner-request-1", object: "scratch-object-1" })}\n`);
      if (phase === "after-owner" && !resumed) {
        await writeFile(`${store}.ready`, "effect persisted, tool result not committed");
        await waitForCrash();
      }
      return { output: [{ type: "text", text: "scratch-object-1" }], details: { correlation: "owner-request-1", object: "scratch-object-1" } };
    },
  });
  registry.install(defineExtension({ name: "scratch-owner", tools: [owner] }));
  const harness = await Harness.open(await openNodeSqliteStorage(store), {
    models, registry,
    settings: { retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false, keepRecentTokens: 50 } },
    onReport: report => emit({ report }),
  }, context);
  const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: "first" } } });
  return { harness, root, faux };
}
async function writer(store: string, phase: string) {
  const { harness, root, faux } = await open(store, phase);
  await root.submit({ type: "write", requestId: "attachment", entry: { kind: "app.attachment", data: { uri: "attachment://sample", sha256: "sample-digest", mediaType: "text/plain" } } }, context);
  await root.submit({ type: "write", requestId: "decision", entry: { kind: "app.decision", data: { choice: "keep-record", source: "input-1" } } }, context);
  await root.submit({ type: "write", requestId: "provenance-fixture", entry: { kind: "app.provenance-fixture", data: { object: "fixture-only", owner: "simulated-owner", exchange: "input-1" } } }, context);
  if (phase === "during-model") {
    faux.setResponses([async () => {
      await writeFile(`${store}.ready`, "input and generation intent committed; model pending");
      await waitForCrash();
      return fauxAssistantMessage("unreachable");
    }]);
  } else {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("owner_create", {}, { id: "owner-call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Owner result recorded"),
    ]);
  }
  const submission = await root.submit({ type: "input", content: "Create sample", requestId: "input-1" }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done");
  assert(settled.answer !== undefined);
  await root.submit({ type: "write", requestId: "owner-provenance", entry: { kind: "app.created", data: { object: "scratch-object-1", owner: "simulated-owner", exchange: submission.id, correlation: "owner-request-1", answer: settled.answer } } }, context);
  await writeFile(`${store}.ready`, "answer and tool result committed");
  if (phase === "after-result") await waitForCrash();
  await harness.close(context);
  emit({ writer: phase, settled });
}
async function reopen(store: string, phase: string) {
  const { harness, root, faux } = await open(store, phase, true);
  faux.setResponses([fauxAssistantMessage("Recovered from committed transcript")]);
  harness.resume();
  await root.waitForIdle(context);
  const duplicate = await root.submit({ type: "input", content: "Create sample", requestId: "input-1" }, context);
  const conflict = await root.submit({ type: "input", content: "CONFLICTING replacement payload", requestId: "input-1" }, context);
  assert.equal(duplicate.id, conflict.id);
  const settled = await duplicate.wait(context);
  const entries = await records(root);
  assert.equal(entries.filter(entry => entry.kind === "pi.user").length, 1, "Reconnect dedup must not append another input");
  for (const kind of ["app.attachment", "app.decision", "app.provenance-fixture", "pi.user", "pi.assistant"]) assert(entries.some(entry => entry.kind === kind), kind);
  assert(!JSON.stringify(entries).includes("CONFLICTING replacement payload"));
  const ownerEffects = await exists(`${store}.owner`) ? (await readFile(`${store}.owner`, "utf8")).trim().split("\n") : [];
  const toolResults = entries.filter(entry => entry.kind === "pi.tool-result");
  if (phase === "before-owner" || phase === "after-owner") {
    assert.equal(ownerEffects.length, phase === "before-owner" ? 0 : 1);
    assert(JSON.stringify(toolResults).includes("interrupted"), "Unsafe tool must surface interruption instead of replaying external effect");
  } else if (phase === "after-result" || phase === "normal") {
    assert.equal(ownerEffects.length, 1);
    assert(JSON.stringify(toolResults).includes("scratch-object-1"));
    assert(entries.some(entry => entry.kind === "app.created" && JSON.stringify(entry.data).includes("owner-request-1")), "Successful owner result has correlated provenance");
  } else if (phase === "during-model") {
    assert.equal(ownerEffects.length, 0);
  }
  emit({ probe: "reopen", phase, settled, duplicateId: duplicate.id, conflictingId: conflict.id, conflictBehavior: "original wins silently; payload mismatch not rejected", ownerEffects, toolResults, entries });
  await harness.close(context);
}
async function clients(store: string) {
  const { harness, root, faux } = await open(store);
  let releaseModel: () => void = () => undefined;
  let enteredModel = false;
  const gate = new Promise<void>(resolve => { releaseModel = resolve; });
  const requests: unknown[] = [];
  faux.setResponses([
    async transcript => { enteredModel = true; requests.push(transcript); await gate; return fauxAssistantMessage(fauxToolCall("owner_create", {}, { id: "queue-owner" }), { stopReason: "toolUse" }); },
    transcript => { requests.push(transcript); return fauxAssistantMessage("Steering applied after owner boundary"); },
    transcript => { requests.push(transcript); return fauxAssistantMessage("Queued follow-up handled"); },
  ]);
  const views: unknown[][] = [[], []];
  const a = await root.watch(context);
  const b = await root.watch(context);
  for (const [index, watch] of [a, b].entries()) {
    views[index]?.push(structuredClone(watch.value));
    watch.start(value => { views[index]?.push(structuredClone(value)); return Promise.resolve(); });
  }
  const first = await root.submit({ type: "input", content: "Start from web", requestId: "web-1" }, context);
  await until(() => enteredModel, "model gate");
  const follow = await root.submit({ type: "input", content: "Queued from Discord", requestId: "discord-1" }, context);
  const steer = await root.submit({ type: "input", content: "Use this now", requestId: "web-steer", whenBusy: "steer" }, context);
  const inbox = structuredClone(a.value.docs["pi.inbox"]);
  assert(JSON.stringify(inbox).includes("Queued from Discord"));
  assert(JSON.stringify(inbox).includes("Use this now"));
  let rejected = "";
  try { await root.submit({ type: "input", content: "Reject when busy", whenBusy: "reject" }, context); }
  catch (error) { rejected = errorText(error); }
  assert(rejected.includes("busy"));
  releaseModel();
  await Promise.all([first.wait(context), follow.wait(context), steer.wait(context)]);
  await root.waitForIdle(context);
  await until(() => JSON.stringify(a.value) === JSON.stringify(b.value), "clients converge");
  await until(() => views.every(client => JSON.stringify(client.at(-1)) === JSON.stringify(a.value)), "both callbacks observe final committed state");
  const entries = await records(root);
  const toolIndex = entries.findIndex(entry => entry.kind === "pi.tool-result");
  const steerIndex = entries.findIndex(entry => JSON.stringify(entry.model).includes("Use this now"));
  const followIndex = entries.findIndex(entry => JSON.stringify(entry.model).includes("Queued from Discord"));
  assert(toolIndex >= 0 && steerIndex > toolIndex && followIndex > steerIndex);
  assert.deepEqual(a.value.entries.map(entry => entry.id), b.value.entries.map(entry => entry.id));
  emit({ probe: "two-clients", attachment: "two watches on one owning host; transport adapters simulated by caller labels", inbox, rejected, toolIndex, steerIndex, followIndex, finalOrder: entries.map(entry => ({ id: entry.id, kind: entry.kind, model: entry.model })), views, requests });
  await a.stop(); await b.stop();
  await compactAndChangeModel(harness, root, faux, store);
  await harness.close(context);
}
async function compactAndChangeModel(harness: Harness, root: Conversation, faux: ReturnType<typeof fauxProvider>, store: string) {
  const before = (await records(root)).length;
  for (let index = 0; index < 80; index++) await root.submit({ type: "write", entry: { kind: "app.history", model: [{ role: "user", content: `history-${index} ${"retained original detail ".repeat(30)}`, timestamp: index }], data: { index } } }, context);
  const originals = await records(root);
  await writeFile(`${store}.originals`, JSON.stringify(originals));
  faux.setResponses([fauxAssistantMessage("Compact working summary: preserve original record and owner provenance")]);
  const taskId = await root.compact("Keep provenance", context);
  const task = await harness.waitForTask(taskId, context);
  assert.equal(task.state.outcome.status, "completed");
  await root.waitForIdle(context);
  const after = await records(root);
  assert(after.some(entry => entry.kind === "pi.compaction"));
  for (const entry of originals) assert(after.some(saved => JSON.stringify(saved) === JSON.stringify(entry)));
  await root.configure({ model: { provider: faux.provider.id, modelId: "second" } }, context);
  let reconstructed: unknown;
  faux.setResponses([transcript => { reconstructed = transcript; return fauxAssistantMessage("Reconstructed on second model"); }]);
  await (await root.submit({ type: "input", content: "Continue with second model", requestId: "second-model" }, context)).wait(context);
  assert(JSON.stringify(reconstructed).includes("Compact working summary"));
  emit({ probe: "compaction-model-change", before, originals: originals.length, after: after.length, task, selectedModel: (await root.agent(context)).model, reconstructed, originalFirst: originals[0], originalLast: originals.at(-1) });
}
async function verifyCompaction(store: string) {
  const { harness, root } = await open(store);
  const all = await records(root);
  const originals: unknown = JSON.parse(await readFile(`${store}.originals`, "utf8"));
  assert(Array.isArray(originals));
  for (const original of originals) assert(all.some(entry => JSON.stringify(entry) === JSON.stringify(original)), "Original entry changed or disappeared after compaction/reopen");
  assert.equal(all.filter(entry => entry.kind === "app.history").length, 80);
  assert(all.some(entry => entry.kind === "pi.compaction"));
  assert.equal((await root.agent(context)).model?.modelId, "second");
  emit({ probe: "compaction-new-process", retainedHistory: 80, totalEntries: all.length, compactedContextEntries: (await root.context(context)).entries.length });
  await harness.close(context);
}
async function lock(store: string, hold: boolean) {
  const path = `${store}.host-lock`;
  try { await mkdir(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") { emit({ probe: "host-lock", state: "excluded" }); return; }
    throw error;
  }
  try {
    const storage = await openNodeSqliteStorage(store);
    emit({ probe: "host-lock", state: "acquired" });
    await writeFile(`${store}.ready`, "lock held");
    if (hold) await waitForCrash();
    await storage.close(context);
  } finally { await rm(path, { recursive: true }); }
}
async function child(args: string[], killAtReady?: string) {
  const childProcess = Bun.spawn([process.execPath, import.meta.path, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; childProcess.kill("SIGKILL"); }, deadline + 5000);
  try {
    if (killAtReady) {
      await until(() => exists(killAtReady), `child checkpoint ${args.join(" ")}`);
      childProcess.kill("SIGKILL");
    }
    const [stdout, stderr, exit] = await Promise.all([new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited]);
    emit({ command: ["bun", "qualify.ts", ...args.map(value => value.replace(/.*\/ivy-durable-qualification-[^/]+\//, "$SCRATCH/"))], exit, killed: Boolean(killAtReady), timedOut, stdout: stdout.replaceAll(scratchRoot, "$SCRATCH"), stderr: stderr.replaceAll(scratchRoot, "$SCRATCH") });
    assert(!timedOut, `Child deadline exceeded: ${args.join(" ")}`);
    if (!killAtReady) assert.equal(exit, 0, stderr);
    return stdout;
  } finally {
    clearTimeout(timer);
    childProcess.kill("SIGKILL");
    await childProcess.exited;
  }
}
let scratchRoot = "";
const [mode, store, phase] = process.argv.slice(2);
if (mode && store) {
  if (mode === "write") await writer(store, phase ?? "normal");
  else if (mode === "reopen") await reopen(store, phase ?? "normal");
  else if (mode === "clients") await clients(store);
  else if (mode === "verify-compaction") await verifyCompaction(store);
  else if (mode === "lock") await lock(store, phase === "hold");
  else if (mode === "raw-open") { const storage = await openNodeSqliteStorage(store); emit({ rawSecondWriterOpen: "allowed" }); await storage.close(context); }
  else throw new Error(`Unknown mode ${mode}`);
} else {
  scratchRoot = await mkdtemp(join(tmpdir(), "ivy-durable-qualification-"));
  emit({ probe: "versions", executable: process.execPath, bun: Bun.version, nodeCompatibility: process.versions.node, sqlite: process.versions.sqlite, durable: await packageVersion("@earendil-works/pi-durable"), piAi: await packageVersion("@earendil-works/pi-ai/models"), chordStorageAdapter: await packageVersion("@earendil-works/chord"), platform: process.platform, architecture: process.arch, scratch: "$SCRATCH", network: "fetch rejects; only faux provider registered" });
  try {
    for (const checkpoint of ["normal", "during-model", "before-owner", "after-owner", "after-result"]) {
      const path = join(scratchRoot, `${checkpoint}.sqlite`);
      await child(["write", path, checkpoint], checkpoint === "normal" ? undefined : `${path}.ready`);
      await child(["reopen", path, checkpoint]);
    }
    const clientStore = join(scratchRoot, "clients.sqlite");
    await child(["clients", clientStore]);
    await child(["verify-compaction", clientStore]);
    const lockStore = join(scratchRoot, "lock.sqlite");
    const holder = Bun.spawn([process.execPath, import.meta.path, "lock", lockStore, "hold"], { stdout: "pipe", stderr: "pipe" });
    try {
      await until(() => exists(`${lockStore}.ready`), "host owner holds lock");
      assert((await child(["lock", lockStore])).includes('"state":"excluded"'));
      assert((await child(["raw-open", lockStore])).includes('"rawSecondWriterOpen":"allowed"'));
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    assert((await child(["lock", lockStore])).includes('"state":"excluded"'));
    emit({ probe: "host-lock-crash", state: "stale lock excludes reopening; explicit owner-death reconciliation required, not an automatic production recovery design" });
    emit({ qualification: "completed", productionAdoption: false });
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
}
