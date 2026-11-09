import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_CALL_TIMEOUT_MS, COMPOSE_MAX_TOKENS, composeDeskRoutine, forwardRoutineEdit, loadDeskRoutineCatalog } from "../desk-compose";
import { RoutineOptionsSchema, type RoutineOptions } from "../../src/common/types/desk-routines";
import { initDatabase } from "../../src/surface/mc/db/init";
import { buildRoutineCard } from "../../src/surface/mc/desk/routines";
import { handleDeskAsk } from "../../src/surface/mc/api/desk-ask";
import { handleDeskRoutineEditor } from "../../src/surface/mc/api/desk-routine-editor";
import { HandledLedger } from "../../src/surface/mc/desk/actions";
import type { DeskRuntime } from "../../src/surface/mc/desk/compose";
import { runCommand } from "../../src/surface/mc/desk/spawn";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "desk-catalog-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("uses only exact active snapshot entries with providers supported by pulse-flow", async () => {
  const packages = [];
  for (const [name, status, requires] of [
    ["A_READ", "active", ["shell"]], ["A_MODEL", "active", ["llm"]], ["A_AGENT", "active", ["agent"]], ["A_DISABLED", "disabled", []],
  ] satisfies [string, string, string[]][]) {
    const installPath = join(root, name);
    await mkdir(installPath);
    await writeFile(join(installPath, "action.json"), JSON.stringify({ name, description: "Test action", input: {}, output: {}, requires }));
    packages.push({ name, type: "action", status, installPath });
  }
  const file = join(root, "inventory.json");
  await writeFile(file, JSON.stringify({ packages }));
  expect((await loadDeskRoutineCatalog(file)).map((a) => a.name)).toEqual(["A_READ"]);
  const selected = packages[0];
  if (!selected) throw new Error("Fixture inventory is empty");
  await writeFile(join(selected.installPath, "action.json"), JSON.stringify({ name: "A_COUNTERFEIT", description: "Mismatch" }));
  await expect(loadDeskRoutineCatalog(file)).rejects.toThrow("identity mismatch");
});

it("forwards redacted routine proposals through the same configured model and credential reference", async () => {
  let argv: string[] = [];
  let timeout = 0;
  const options = { pulseBin: "configured-pulse", modelUrl: "https://model.example/v1", model: "configured-model", apiKeyEnv: "EXISTING_MODEL_KEY", request: "use three attempts", routineEdit: JSON.stringify({ name: "F_TEST", steps: [], privateExtra: "must-be-removed" }) };
  const result = await forwardRoutineEdit(options, (args, _stdin, ms) => {
    argv = args;
    timeout = ms;
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: "edit", patches: [] }), stderr: "" });
  });
  expect(result).toEqual({ status: "edit", patches: [] });
  expect(argv).toContain("configured-model");
  expect(argv).toContain("https://model.example/v1");
  expect(argv).toContain("EXISTING_MODEL_KEY");
  expect(argv.join(" ")).not.toContain("must-be-removed");
  expect(argv[argv.indexOf("--routine-edit") + 1]).toBe(JSON.stringify({ name: "F_TEST", steps: [] }));
  expect(timeout).toBe(COMPOSE_CALL_TIMEOUT_MS);
  await expect(forwardRoutineEdit({ ...options, routineEdit: "x".repeat(262145) })).rejects.toThrow("size limit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 0, stdout: "x".repeat(65537), stderr: "" }))).rejects.toThrow("size limit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 1, stdout: "private model output", stderr: "private stderr" }))).rejects.toThrow("could not prepare a valid edit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 0, stdout: "private invalid output", stderr: "" }))).rejects.toThrow("invalid parameter proposal");
});

describe("a Desk compose through the real command", () => {
  const MAIL_SEND = { name: "A_MAIL_SEND", description: "Send one mail", input: { subject: { type: "string", required: true }, body: { type: "string", required: true } }, output: { sent: { type: "boolean" } }, tags: ["email", "send", "write"], effect: "write" };
  const MAILS_SOMEONE = "```yaml\nname: F_MAIL\nactions:\n  - agent: # sovereignty: A, residency: CH\n      name: subject\n      capability: compose.judgment\n      prompt: \"Subject for {scenario}\"\n      collect: subject\n      returns: string\n  - agent: # sovereignty: A, residency: CH\n      name: body\n      capability: compose.judgment\n      prompt: \"Body for {subject}\"\n      collect: body\n      returns: string\n  - A_MAIL_SEND # sovereignty: D, residency: CH\n```\nA summary.";
  const seen: { maxTokens: unknown }[] = [];
  let model: ReturnType<typeof Bun.serve>;
  let options: RoutineOptions;

  beforeEach(async () => {
    seen.length = 0;
    model = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.json() as { max_tokens: unknown; messages: { content: string }[] };
        seen.push({ maxTokens: body.max_tokens });
        const readsDelivery = body.messages[0]?.content.startsWith("Read a routine request");
        const content = readsDelivery ? JSON.stringify({ channels: ["email"], send: true, mailsSomeoneElse: true }) : MAILS_SOMEONE;
        return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
      },
    });
    const installPath = join(root, "A_MAIL_SEND");
    await mkdir(installPath);
    await writeFile(join(installPath, "action.json"), JSON.stringify(MAIL_SEND));
    const catalogFile = join(root, "inventory.json");
    await writeFile(catalogFile, JSON.stringify({ packages: [{ name: "A_MAIL_SEND", type: "action", status: "active", installPath }] }));
    options = RoutineOptionsSchema.parse({
      composer: ["/usr/bin/env", "FAKE_MODEL_KEY=none", process.execPath, join(import.meta.dir, "..", "desk-compose.ts"), "--catalog-file", catalogFile, "--model-url", `http://127.0.0.1:${model.port}/v1`, "--model", "test-model", "--api-key-env", "FAKE_MODEL_KEY"],
      reflex: ["reflex"], target: "@test/pulse-flow", timeZone: "UTC",
    });
  });
  afterEach(() => { void model.stop(true); });

  it("an impossible delivery yields a no-match card with no Confirm, and the model is never asked to compose", async () => {
    const db = initDatabase(":memory:");
    const card = await buildRoutineCard(db, "every morning at 8, mail this to someone-else@example.com", options, Date.now());
    db.close();
    expect(card).toMatchObject({ kind: "routine", unwritable: true, problem: expect.stringContaining("only your own configured addresses") });
    expect(card.fields.proposalId).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxTokens).toBe(COMPOSE_MAX_TOKENS);
  });
});

it("holds the Desk's compose to its delivery", async () => {
  let asked = 0;
  const result = await composeDeskRoutine("mail Bob the digest", [], async (_prompt, llmOptions) => {
    asked += 1;
    return { text: llmOptions?.json ? JSON.stringify({ channels: ["email"], send: true, mailsSomeoneElse: false }) : "unused" };
  });
  expect(result).toMatchObject({ status: "no-match" });
  expect(asked).toBe(1);
});

describe("command model through the real composer CLI", () => {
  const editableFlow = { name: "F_READ", steps: [{ path: ["actions", 0], action: "A_READ", purpose: "Read", reason: "Read", parameters: [{ name: "limit", kind: "literal", value: 1 }], editable: [{ name: "limit", type: "number", minimum: 1, maximum: 5 }] }] };
  async function setup(reply?: unknown) {
    const capture = join(root, "messages.jsonl");
    const command = join(root, "model.ts");
    await writeFile(command, `import { appendFileSync } from "node:fs";
const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
appendFileSync(${JSON.stringify(capture)}, JSON.stringify(input)+"\\n");
const instructions = JSON.parse(input.messages[1].content).instructions;
const editing = instructions.startsWith("Propose routine parameter edits");
const delivery = instructions.startsWith("Read a routine request");
const text = editing ? JSON.stringify({patches:[{path:["actions",0,"A_READ","limit"],value:3}]}) : delivery ? JSON.stringify({channels:[],send:false,mailsSomeoneElse:false}) : "\`\`\`yaml\\nname: F_READ\\nactions:\\n  - A_READ # sovereignty: D, residency: CH\\n\`\`\`";
process.stdout.write(JSON.stringify(${reply === undefined ? "{text}" : JSON.stringify(reply)}));
`);
    const installPath = join(root, "A_READ");
    await mkdir(installPath);
    await writeFile(join(installPath, "action.json"), JSON.stringify({ name: "A_READ", description: "Read a fixed value", input: {}, output: { value: { type: "string" } }, effect: "read" }));
    const catalog = join(root, "catalog.json");
    await writeFile(catalog, JSON.stringify({ packages: [{ name: "A_READ", type: "action", status: "active", installPath }] }));
    return { capture, argv: [process.execPath, join(import.meta.dir, "..", "desk-compose.ts"), "--catalog-file", catalog, "--model-command", JSON.stringify([process.execPath, command]), "--request", "read a fixed value", "--json"] };
  }

  async function execute(argv: string[]) {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  it("composes without an HTTP endpoint and preserves the delivery check", async () => {
    const { argv, capture } = await setup();
    const result = await execute(argv);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "complete", flow: { name: "F_READ", actions: ["A_READ"] } });
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.sourcePolicy === "cloud")).toBe(true);
    expect(JSON.parse(calls[0].messages[1].content).instructions).toStartWith("Read a routine request");
    expect(calls[1].messages[0].content).toContain('"text"');
  });

  it("proposes validated edits through the command without forwarding to Pulse HTTP", async () => {
    const { argv } = await setup();
    const result = await execute([...argv, "--pulse-bin", "/nonexistent/pulse", "--routine-edit", JSON.stringify(editableFlow)]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "edit", patches: [{ path: ["actions", 0, "A_READ", "limit"], value: 3 }] });
    const restricted = { ...editableFlow, steps: editableFlow.steps.map((step) => ({ ...step, editable: step.editable.map((field) => ({ ...field, maximum: 2 })) })) };
    const invalid = await execute([...argv, "--routine-edit", JSON.stringify(restricted)]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ status: "invalid" });
  });

  it.each([{ patches: [] }, { text: { patches: [] } }])("rejects the wrong envelope shape %j", async (reply) => {
    const { argv } = await setup(reply);
    const result = await execute([...argv, "--routine-edit", JSON.stringify(editableFlow)]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "invalid" });
  });

  it("accepts fenced JSON inside the string envelope for an edit", async () => {
    const { argv } = await setup({ text: '```json\n{"patches":[]}\n```' });
    const result = await execute([...argv, "--routine-edit", JSON.stringify(editableFlow)]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "edit", patches: [] });
  });

  it("stops an undeliverable command request after the delivery read", async () => {
    const { argv, capture } = await setup({ text: JSON.stringify({ channels: ["email"], send: true, mailsSomeoneElse: true }) });
    const result = await execute(argv);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "no-match" });
    expect((await readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("rejects malformed command responses instead of accepting an unchecked proposal", async () => {
    const { argv } = await setup({ text: 42 });
    const result = await execute(argv);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "invalid" });
  });

  it("normalizes private stderr and bounded-output failures", async () => {
    const { argv } = await setup();
    const model = join(root, "model.ts");
    for (const code of ['process.stderr.write("PRIVATE_SENTINEL"); process.exit(1);', 'process.stdout.write("PRIVATE_SENTINEL" + "x".repeat(600000));', 'process.stdout.write("PRIVATE_SENTINEL");']) {
      await writeFile(model, code);
      const result = await execute(argv);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_SENTINEL");
      expect(result.stderr).toContain("desk-compose: model failed");
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "invalid" });
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)("kills the model group and starts no retry after %s", async (signal) => {
    const { argv } = await setup();
    const pidFile = join(root, "pid");
    const cleaned = join(root, "cleaned");
    await writeFile(join(root, "model.ts"), `import { existsSync,readFileSync,writeFileSync,renameSync } from "node:fs"; const child=Bun.spawn([process.execPath,"-e","setInterval(() => {},1000)"],{stdout:"inherit",stderr:"inherit"});const file=${JSON.stringify(pidFile)};const prior=existsSync(file)?readFileSync(file,"utf8"):"";writeFileSync(file+".tmp",prior+JSON.stringify([process.pid,child.pid])+"\\n");renameSync(file+".tmp",file);process.on("SIGTERM",async()=>{writeFileSync(${JSON.stringify(cleaned)},"cleaned");await child.exited;process.exit(0);}); setInterval(() => {}, 1000);`);
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 200 && !await Bun.file(pidFile).exists(); i++) await Bun.sleep(10);
      const pids: number[] = JSON.parse((await readFile(pidFile, "utf8")).trim());
      if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) throw new Error("Invalid model PID fixture");
      proc.kill(signal);
      const [, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).not.toBe(0);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect((await readFile(pidFile, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(await Bun.file(cleaned).exists()).toBe(true);
    } finally { proc.kill("SIGKILL"); await proc.exited; }
  });

  it("abort settles even when a detached descendant holds the output pipe", async () => {
    const pidFile = join(root, "detached-pid");
    const script = `import {writeFileSync,renameSync} from "node:fs"; const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdout:"inherit",stderr:"inherit"});const file=${JSON.stringify(pidFile)};writeFileSync(file+".tmp",String(child.pid));renameSync(file+".tmp",file);process.on("SIGTERM",()=>{});setInterval(()=>{},1000);`;
    const abort = new AbortController();
    const result = runCommand([process.execPath, "-e", script], 10000, "", undefined, true, { maxOutputBytes: 1024, signal: abort.signal });
    let child: number | undefined;
    try {
      for (let i = 0; i < 200 && !await Bun.file(pidFile).exists(); i++) await Bun.sleep(10);
      const pid = Number(await readFile(pidFile, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid detached PID fixture");
      child = pid;
      abort.abort();
      await expect(result).rejects.toThrow();
    } finally {
      abort.abort();
      if (child !== undefined && child > 1) process.kill(-child, "SIGKILL");
    }
  });

  it("keeps HTTP edits on the forwarding path without constructing an HTTP model", async () => {
    const { argv } = await setup();
    const pulse = join(root, "pulse");
    await writeFile(pulse, '#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({status:"edit",patches:[]}));\n');
    await chmod(pulse, 0o755);
    const commandIndex = argv.indexOf("--model-command");
    const http = [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 2), "--model-url", "previously-forwarded-value", "--model", "test", "--api-key-env", "MODEL_KEY", "--pulse-bin", pulse, "--routine-edit", JSON.stringify({ name: "F_READ", steps: [] })];
    const result = await execute(http);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "edit", patches: [] });
  });

  it("rejects ambiguous model configuration and an empty command before spawning", async () => {
    const { argv, capture } = await setup();
    const invalidCommands = ["[]", "not-json", '"not-array"', '[""]', '["relative-model"]'].map((json) => argv.map((value, i) => argv[i - 1] === "--model-command" ? json : value));
    for (const args of [[...argv, "--model-url", "https://model.example/v1", "--model", "model", "--api-key-env", "MODEL_KEY"], [...argv, "--model", "partial-http"], ...invalidCommands]) {
      const result = await execute(args);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "invalid" });
    }
    expect(await Bun.file(capture).exists()).toBe(false);
  });

  it("refuses local and unknown areas before starting the cloud composer", async () => {
    const { argv } = await setup();
    const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "Test", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [], policy: "local" }], routines: RoutineOptionsSchema.parse({ composer: argv, reflex: ["reflex"], target: "@test/pulse-flow", timeZone: "UTC" }) } };
    const detail = { id: "test", revision: "a".repeat(64), writable: true, reason: "", flow: { name: "F_READ", steps: [] } };
    const db = initDatabase(":memory:");
    let modelCalls = 0;
    const run = async (args: string[]) => {
      if (args[0] !== "reflex") modelCalls++;
      return { code: 0, stdout: JSON.stringify(args[0] === "reflex" ? detail : { status: "edit", patches: [] }), stderr: "" };
    };
    try {
      for (const area of ["work", "unknown", ""]) {
        const ask = await handleDeskAsk(new Request("http://localhost/api/desk/ask", { method: "POST", body: JSON.stringify({ text: "every morning at 8 read a fixed value", area }) }), runtime, { runRoutine: run }, db);
        expect(ask.status).toBe(area === "work" ? 409 : 400);
        if (area === "work") expect(await ask.text()).toContain("provider restriction");
        const edit = await handleDeskRoutineEditor(new Request("http://localhost/api/desk/routine-editor", { method: "POST", body: JSON.stringify({ id: detail.id, revision: detail.revision, action: "propose", text: "use three attempts", area }) }), runtime, run);
        expect(edit.status).toBe(area === "" ? 400 : 409);
        if (area !== "") expect(await edit.text()).toContain("provider restriction");
      }
      expect(modelCalls).toBe(0);
      const options = runtime.options;
      if (!options) throw new Error("Fixture options are missing");
      for (const area of [undefined, "personal", "default-policy"]) {
        const allowed = { ...runtime, options: { ...options, areas: [...options.areas, { id: "personal", label: "Personal", color: "", repos: [], goals: [], policy: "cloud" as const }, { id: "default-policy", label: "Default", color: "", repos: [], goals: [] }] } };
        const edit = await handleDeskRoutineEditor(new Request("http://localhost/api/desk/routine-editor", { method: "POST", body: JSON.stringify({ id: detail.id, revision: detail.revision, action: "propose", text: "use three attempts", area }) }), allowed, run);
        expect(edit.status).toBe(200);
        const ask = await handleDeskAsk(new Request("http://localhost/api/desk/ask", { method: "POST", body: JSON.stringify({ text: "every morning at 8 read a fixed value", area }) }), allowed, { runRoutine: run }, db);
        expect(ask.status).toBe(200);
      }
      expect(modelCalls).toBe(6);
    } finally { db.close(); }
  });
});
