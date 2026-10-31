import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { InMemoryAgentTransport } from "pulse";
import { loadProcessSpec, resolveArgv } from "../../bus/process-runner";
import { registerPulseFlowCommand } from "../../cli/cortex/commands/pulse-flow";
import { executeRoutineFlow, readActionInventory, readRoutineFlow, requireFlowProviders } from "../pulse-flow";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pulse-flow-test-"));
  roots.push(root);
  const flowsDir = join(root, "flows");
  const selected = join(root, "installed", "current", "A_PROBE");
  const sentinel = join(root, "ran.txt");
  await mkdir(flowsDir);
  await mkdir(selected, { recursive: true });
  await writeFile(join(selected, "action.json"), JSON.stringify({ name: "A_PROBE", description: "test action", input: {}, output: {}, requires: [] }));
  await writeFile(join(selected, "action.ts"), `export default { async execute(input) { await Bun.write(${JSON.stringify(sentinel)}, "selected"); return input; } };`);
  const flow = join(flowsDir, "routine with spaces.yaml");
  const yaml = "name: F_PROBE\nactions:\n  - A_PROBE # sovereignty: D, residency: CH\n";
  await writeFile(flow, yaml);
  const packages = [{ name: "A_PROBE", type: "action", status: "active", installPath: selected }];
  return { root, flowsDir, flow, yaml, selected, sentinel, packages, inventory: async () => ({ packages }) };
}

describe("routine flow execution", () => {
  test("the generic process template maps payload flow into exactly one argv slot", async () => {
    const spec = await loadProcessSpec(join(import.meta.dir, "../../../examples/processes"), "pulse-flow");
    const flow = "/configured flows/-value; echo injected.yaml";
    expect(resolveArgv(spec, { flow })).toEqual(["cortex", "pulse-flow", "--flows-dir", "/absolute/routines/flows", "--flow", flow, "--catalog-file", "/absolute/routines/action-inventory.json", "--agent-provider", "myelin"]);
    expect(() => resolveArgv(spec, {})).toThrow("required");
    expect(() => resolveArgv(spec, { flow: 3 })).toThrow("string");
  });

  test("runs the selected active installed action using the validated YAML snapshot", async () => {
    const f = await fixture();
    await executeRoutineFlow(f);
    expect(await readFile(f.sentinel, "utf8")).toBe("selected");
  });

  test("a trusted inventory file drives execution and missing or invalid files have no fallback", async () => {
    const f = await fixture();
    const catalogFile = join(f.root, "catalog.json");
    await writeFile(catalogFile, JSON.stringify(await f.inventory()));
    await executeRoutineFlow({ ...f, inventory: () => readActionInventory(catalogFile) });
    expect(await readFile(f.sentinel, "utf8")).toBe("selected");
    await rm(f.sentinel);
    await writeFile(catalogFile, "not JSON");
    await expect(executeRoutineFlow({ ...f, inventory: () => readActionInventory(catalogFile) })).rejects.toThrow();
    await rm(catalogFile);
    await expect(executeRoutineFlow({ ...f, inventory: () => readActionInventory(catalogFile) })).rejects.toThrow();
    await expect(readActionInventory("relative.json")).rejects.toThrow("absolute");
    expect(await Bun.file(f.sentinel).exists()).toBe(false);
  });

  test("allows canonical root aliases and links to files inside the root", async () => {
    const f = await fixture();
    const rootAlias = join(f.root, "alias");
    await symlink(f.flowsDir, rootAlias, "dir");
    const fileAlias = join(f.flowsDir, "alias.yaml");
    await symlink(f.flow, fileAlias);
    expect(await readRoutineFlow(rootAlias, fileAlias)).toBe(f.yaml);
  });

  test.each(["outside", "prefix", "parent", "symlink", "relative", "missing", "directory"])("rejects %s before catalog discovery or action execution", async (kind) => {
    const f = await fixture();
    const outside = join(f.root, "outside.yaml");
    await writeFile(outside, f.yaml);
    const prefix = `${f.flowsDir}-other`;
    await mkdir(prefix);
    await writeFile(join(prefix, "flow.yaml"), f.yaml);
    const link = join(f.flowsDir, "outside-link.yaml");
    await symlink(outside, link);
    const paths: Record<string, string> = {
      outside, prefix: join(prefix, "flow.yaml"), parent: join(f.flowsDir, "..", "outside.yaml"),
      symlink: link, relative: "flow.yaml", missing: join(f.flowsDir, "missing.yaml"), directory: f.flowsDir,
    };
    let discovered = false;
    const flow = paths[kind];
    if (!flow) throw new Error("missing case");
    await expect(executeRoutineFlow({ ...f, flow, inventory: async () => { discovered = true; return f.inventory(); } })).rejects.toThrow();
    expect(discovered).toBe(false);
    expect(await Bun.file(f.sentinel).exists()).toBe(false);
  });

  test.each(["malformed", "unknown", "nested-unknown", "unannotated"])("rejects %s flow before the first action", async (kind) => {
    const f = await fixture();
    const tails: Record<string, string> = {
      malformed: "  - unknown_primitive: {} # sovereignty: D, residency: CH\n",
      unknown: "  - A_MISSING # sovereignty: D, residency: CH\n",
      "nested-unknown": "  - retry: # sovereignty: D, residency: CH\n      attempts: 1\n      actions: [A_MISSING]\n",
      unannotated: "  - A_PROBE\n",
    };
    await writeFile(f.flow, f.yaml + (tails[kind] ?? ""));
    await expect(executeRoutineFlow(f)).rejects.toThrow();
    expect(await Bun.file(f.sentinel).exists()).toBe(false);
  });

  test("a later missing agent provider prevents the earlier action from running", async () => {
    const f = await fixture();
    await writeFile(f.flow, f.yaml + "  - retry: # sovereignty: A, residency: CH\n      attempts: 1\n      actions:\n        - agent:\n            name: judgment\n            capability: test.judgment\n            prompt: judge\n            collect: result\n");
    await expect(executeRoutineFlow(f)).rejects.toThrow("configured agent provider");
    expect(await Bun.file(f.sentinel).exists()).toBe(false);
  });

  test("a missing required input inside a later retry prevents the earlier action from running", async () => {
    const f = await fixture();
    const required = join(f.root, "A_NEEDS");
    await mkdir(required);
    await writeFile(join(required, "action.json"), JSON.stringify({ name: "A_NEEDS", description: "requires unavailable input", input: { missing: { type: "string", required: true } }, output: {}, requires: [] }));
    await writeFile(join(required, "action.ts"), "export default { async execute(input) { return input; } };");
    f.packages.push({ name: "A_NEEDS", type: "action", status: "active", installPath: required });
    await writeFile(f.flow, f.yaml + "  - retry: # sovereignty: D, residency: CH\n      attempts: 1\n      actions: [A_NEEDS]\n");
    await expect(executeRoutineFlow(f)).rejects.toThrow("missing");
    expect(await Bun.file(f.sentinel).exists()).toBe(false);
  });

  test("accepts an explicitly supplied provider without changing sovereignty routing", () => {
    const step = { agent: { name: "judgment", capability: "test.judgment", prompt: "judge", collect: "result", sovereignty: { model_class: "local-only" as const, frontier_ok: false } } };
    const agentProvider = { dispatch: async () => ({ task_id: "test", status: "completed" as const, output: "ok", duration_ms: 0 }) };
    expect(() => requireFlowProviders([step], { agentProvider })).not.toThrow();
    expect(step.agent.sovereignty.model_class).toBe("local-only");
  });

  test("the configured CLI executes agent steps over Myelin with their sovereignty and closes its transport", async () => {
    const f = await fixture();
    await writeFile(f.flow, f.yaml + "  - agent: # sovereignty: A, residency: CH\n      name: judgment\n      capability: test.judgment\n      prompt: judge\n      collect: result\n      sovereignty: {model_class: local-only, frontier_ok: false, data_residency: CH}\n");
    const transport = new InMemoryAgentTransport();
    const tasks: unknown[] = [];
    await transport.subscribe("local.example.demo.tasks.test.judgment", (_subject, data) => {
      const task = JSON.parse(data);
      tasks.push(task.sovereignty);
      void transport.publish("local.example.demo.dispatch.task.completed", JSON.stringify({ correlation_id: task.correlation_id, payload: { output: "judged" } }));
    });
    let closed = false;
    const command = new Command();
    registerPulseFlowCommand(command, {
      env: { PULSE_PRINCIPAL: "example", PULSE_STACK: "demo", PULSE_NATS_URL: "nats://configured", PULSE_NATS_CREDS: "/configured/credentials" },
      inventory: f.inventory,
      connect: async (options) => {
        expect(options.servers).toBe("nats://configured");
        expect(options.credentials).toBe("/configured/credentials");
        return { publish: transport.publish.bind(transport), subscribe: transport.subscribe.bind(transport), close: async () => { closed = true; } };
      },
    });
    await command.parseAsync(["node", "cortex", "pulse-flow", "--flows-dir", f.flowsDir, "--flow", f.flow, "--catalog-file", "/configured/catalog.json", "--agent-provider", "myelin"]);
    expect(await readFile(f.sentinel, "utf8")).toBe("selected");
    expect(tasks).toEqual([{ classification: "local", max_hop: 0, model_class: "local-only", frontier_ok: false, data_residency: "CH" }]);
    expect(closed).toBe(true);
  });

  test("inactive actions, old sibling versions and non-action packages never enter execution resolution", async () => {
    const f = await fixture();
    const old = join(f.root, "installed", "old", "A_PROBE");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "action.json"), await readFile(join(f.selected, "action.json")));
    await writeFile(join(old, "action.ts"), `export default { async execute() { throw new Error("wrong action"); } };`);
    f.packages.unshift({ name: "A_PROBE", type: "action", status: "disabled", installPath: old });
    f.packages.unshift({ name: "bundle", type: "tool", status: "active", installPath: join(f.root, "installed", "old") });
    await executeRoutineFlow(f);
    expect(await readFile(f.sentinel, "utf8")).toBe("selected");
  });

  test("refuses conflicting active action paths and mismatched manifest names", async () => {
    const f = await fixture();
    f.packages.push({ name: "A_PROBE", type: "action", status: "active", installPath: f.flowsDir });
    await expect(executeRoutineFlow(f)).rejects.toThrow("ambiguous");
    f.packages.pop();
    await writeFile(join(f.selected, "action.json"), JSON.stringify({ name: "A_WRONG", description: "wrong" }));
    await expect(executeRoutineFlow(f)).rejects.toThrow("name mismatch");
    expect(await Bun.file(f.sentinel).exists()).toBe(false);
  });

  test("CLI failures are a single diagnostic line and a failing exit status", async () => {
    const command = new Command();
    registerPulseFlowCommand(command);
    const previous = process.exitCode;
    const stderr = process.stderr.write;
    const output: unknown[] = [];
    try {
      process.stderr.write = (chunk) => { output.push(chunk); return true; };
      await command.parseAsync(["node", "cortex", "pulse-flow", "--flows-dir", "relative", "--flow", "relative", "--catalog-file", "/configured/catalog.json"]);
      expect(process.exitCode).toBe(1);
      expect(output).toEqual(["pulse-flow: flow and flows-dir must be absolute paths\n"]);
    } finally {
      process.stderr.write = stderr;
      process.exitCode = previous ?? 0;
    }
  });
});
