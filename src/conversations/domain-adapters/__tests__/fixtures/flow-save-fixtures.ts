import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateRequest } from "../../../types";
import type { WriterResult, WriterRunner } from "../../../../surface/mc/desk/create";
import { studioRequestId } from "../../../../surface/mc/desk/conversation-ids";
import { createFlowSaveBinding, createFlowSaveFacade, flowSaveApprovedSnapshot, FLOW_SAVE_SUPPORT_ID } from "../../flow/save-binding";
import type { DispatchRequest } from "../../operations/types";
import { DomainAdapterRegistry } from "../../registry";
import { confirmationAuthority, lifecycleRig, openJournal } from "./lifecycle-rig";

export const FLOW_SAVE_NOW = Date.parse("2026-11-01T12:00:00.000Z");
export const flowSaveAuthority = confirmationAuthority(FLOW_SAVE_NOW);
export const flowSaveDefinition = (name = "F_SAVE_EXAMPLE"): string => `name: ${name}\ninput:\n  text: example\nactions:\n  - A_EXAMPLE\n`;
export function flowSaveRequest(proposalId = "save", fields: Record<string, string> = {}): CreateRequest {
  const operationId = `conversation-example:${proposalId}:1`;
  return { operationId, type: "flow", fields: { name: "F_SAVE_EXAMPLE", definition: flowSaveDefinition(), ...fields }, activation: "none", provenance: { operationId, conversationId: "conversation-example", proposalId, revision: 1, entryId: null, link: "?desk=conversation" }, signal: new AbortController().signal };
}

export function flowSaveDispatchRequest(): DispatchRequest {
  const request = flowSaveRequest();
  const { operationId: _operationId, ...provenance } = request.provenance;
  return {
    lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: crypto.randomUUID(), idempotencyKey: request.operationId, ownerRequestId: studioRequestId(request.operationId), authority: flowSaveAuthority, supportDeclarationId: FLOW_SAVE_SUPPORT_ID, deadlineAt: new Date(FLOW_SAVE_NOW + 30_000).toISOString(),
    snapshot: flowSaveApprovedSnapshot({ connectionId: "connection-example", stack: "stack-example", provenance, input: { stack: { adapterId: "flow", connectionId: "connection-example", objectType: "stack", canonicalId: "stack-example" }, name: "F_SAVE_EXAMPLE", definition: flowSaveDefinition() } }),
  };
}

export async function openFlowSaveRig() {
  const dir = await mkdtemp(join(tmpdir(), "desk-flow-save-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const flowsDir = join(dir, "flows");
  await mkdir(home);
  await mkdir(bin);
  const arc = join(bin, "arc");
  await writeFile(arc, '#!/bin/sh\nprintf \'%s\\n\' \'{"packages":[]}\'\n');
  await chmod(arc, 0o700);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), PATH: bin };
  const pulse = [process.execPath, fileURLToPath(new URL("src/cli.ts", import.meta.resolve("pulse/package.json")))];
  const calls: string[][] = [];
  const owner: WriterRunner = (argv, _stdin, timeout) => new Promise((resolve, reject) => {
    execFile(argv[0]!, [...argv.slice(1), "--flows-dir", flowsDir], { env, timeout, maxBuffer: 1048576 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(new Error(error.message, { cause: error })); return; }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
  const state: { mode: "normal" | "exit-2" | "invalid-output" | "timeout" | "wrong-name" | "missing-hash"; configured: boolean; now: number } = { mode: "normal", configured: true, now: FLOW_SAVE_NOW };
  const run: WriterRunner = async (argv, stdin, timeout) => {
    calls.push(argv);
    const result = await owner(argv, stdin, timeout);
    if (!argv.includes("save")) return result;
    if (state.mode === "timeout") throw new Error("Pulse save timed out after the owner wrote the Flow.");
    if (state.mode === "exit-2") return { ...result, code: 2 };
    if (state.mode === "invalid-output") return { ...result, stdout: "incomplete output" };
    if (state.mode === "wrong-name") return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), name: "F_OTHER" }) };
    if (state.mode === "missing-hash") return { ...result, stdout: JSON.stringify({ status: "saved", name: "F_SAVE_EXAMPLE" }) };
    return result;
  };
  const registry = new DomainAdapterRegistry();
  let engine = await openJournal(dir, registry);
  const journal = engine.journal;
  const binding = createFlowSaveBinding({ stack: "stack-example", connectionId: "connection-example", flows: () => state.configured ? { pulse } : undefined, journal, run, now: () => FLOW_SAVE_NOW });
  const registered = registry.register(binding.declaration, binding.bindings);
  if (!registered.ok) throw new Error(JSON.stringify(registered.error));
  const facade = createFlowSaveFacade({ binding, journal, now: () => FLOW_SAVE_NOW });
  const { bridge, lifecycle, context, lease } = lifecycleRig({ journal, live: () => binding, now: FLOW_SAVE_NOW, clock: () => new Date(state.now), label: "Flow save" });
  const command = (args: string[]): Promise<WriterResult> => owner([...pulse, "flow", ...args, "--json"], "", 8000);
  return {
    dir, flowsDir, env, pulse, calls, state, registry, journal, binding, facade, bridge, lifecycle, run,
    command,
    savedCount: async (): Promise<number> => JSON.parse((await command(["list", "--saved"])).stdout).flows.length,
    create: (request = flowSaveRequest()) => facade.create(request, flowSaveAuthority, lifecycle()),
    retry: (operationId: string) => bridge.redispatch(context, operationId, lease),
    async reopened() {
      await engine.closeEngine();
      engine = await openJournal(dir, registry);
      return engine.journal;
    },
    async close() { await engine.closeEngine(); await rm(dir, { recursive: true, force: true }); },
  };
}
export type FlowSaveRig = Awaited<ReturnType<typeof openFlowSaveRig>>;
