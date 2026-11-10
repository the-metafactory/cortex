import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { authorityRig } from "../../../authority-fixtures";
import { createFlowReadAdapter } from "../../flow/read";
import { DomainAdapterRegistry } from "../../registry";
import { ReadBindings } from "../../reads/bindings";
import type { QueryRequest, QueryResult } from "../../reads/query-types";
import type { Json } from "../../operations/types";
import type { ReadBinding } from "../../reads/types";

const execute = promisify(execFile);
export const FLOW_NAME = "F_SAVED_EXAMPLE";
export const ARC_FLOW_NAME = "F_ARC_EXAMPLE";
export const flowYaml = (name: string): string => `name: ${name}\ninput:\n  text: example\nactions:\n  - A_EXAMPLE\n`;

export async function openFlowReadRig(options: { conversationPolicy?: "local" | "cloud"; configured?: boolean; binary?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "desk-flow-read-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const flowsDir = join(dir, "flows");
  const pkg = join(dir, "arc-example");
  for (const path of [home, bin, pkg]) await mkdir(path, { recursive: true });
  await writeFile(join(pkg, "arc-manifest.yaml"), "name: example-flow-package\nversion: 1.0.0\ntype: tool\n");
  await writeFile(join(pkg, "flow.yaml"), `name: ${ARC_FLOW_NAME}\nsource:\n  type: inline\ndestination:\n  type: stdout\npipeline: ./pipeline.yaml\n`);
  const arc = join(bin, "arc");
  const packages = JSON.stringify({ packages: [{ name: "example-flow-package", version: "1.0.0", type: "tool", status: "installed", installPath: pkg }] });
  await writeFile(arc, `#!/bin/sh\nprintf '%s\\n' '${packages}'\n`);
  await chmod(arc, 0o700);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const source = { connectionId: "connection-example", stack: "stack-example", ...(options.configured === false ? {} : { flowsDir }), ...(options.binary ? { binary: options.binary } : {}), env };
  const adapter = createFlowReadAdapter(source);
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(adapter.declaration, adapter.bindings);
  if (!registered.ok) throw new Error(JSON.stringify(registered.error));
  const queryBinding = adapter.readBindings.find(binding => binding.capabilityId === "flow.saved.query");
  const readBinding = adapter.readBindings.find(binding => binding.capabilityId === "flow.saved.read");
  if (!queryBinding || !readBinding) throw new Error("flow bindings missing");
  const rig = await authorityRig({}, options.conversationPolicy ?? "local", { registry, binding: queryBinding, adapterId: "flow", capabilityIds: adapter.readBindings.map(binding => binding.capabilityId) });
  const readBindings = new ReadBindings(registry);
  for (const binding of adapter.readBindings) {
    const result = readBindings.register(binding, { adapterId: "flow", connectionId: source.connectionId, readCapabilityIds: adapter.readBindings.map(item => item.capabilityId) });
    if (!result.ok) throw new Error(result.error.code);
  }
  rig.bindings.readBindings = readBindings;
  const connection = { ...rig.connection, connectionRevision: "2", readCapabilityIds: adapter.readBindings.map(binding => binding.capabilityId), writeCapabilityIds: [], readDestinations: [adapter.destination], writeDestinations: [] };
  Object.assign(rig.connection, connection);
  await rig.service.publishHostRecord({ kind: "connection", value: connection }, 1);
  let restrictionRevision = 1;
  const restriction = adapter.restriction({ ...rig.objectRestriction, restrictionRef: randomUUID() });
  await rig.service.publishHostRecord({ kind: "restriction", value: restriction }, 0);
  rig.hooks.query = (request, signal) => adapter.query(request, signal);
  const runner = rig.host.readQueries(registry, rig.bindings);
  const pulse = async (args: string[]): Promise<Record<string, unknown>> => {
    const result = await execute("pulse", ["flow", ...args, "--flows-dir", flowsDir, "--json"], { env, timeout: 8000, maxBuffer: 1048576 });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const run = async (binding: ReadBinding, input: Json, resume?: QueryRequest) => {
    const sends = rig.calls.sends.length;
    const request = resume ?? await runner.create(rig.context, [{ adapterId: "flow", connectionId: source.connectionId, capabilityId: binding.capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations: [adapter.destination], input }], rig.sink);
    const result = await runner.run(rig.context, request, rig.sink);
    return { request, result, released: rig.calls.sends.length > sends ? rig.calls.sends.at(-1) : undefined };
  };
  return {
    dir, home, env, flowsDir, source, adapter, registry, rig, runner, pulse,
    async save(name = FLOW_NAME) {
      const file = join(dir, `${name}.input.yaml`);
      await writeFile(file, flowYaml(name));
      return pulse(["save", "--file", file, "--request-id", randomUUID(), "--conversation", "conversation-example", "--saved-by", "principal-example"]);
    },
    query(limit = 20) { return run(queryBinding, { stack: adapter.destination, limit }); },
    read(canonicalId = FLOW_NAME, connectionId = source.connectionId) { return run(readBinding, { ref: { adapterId: "flow", connectionId, objectType: "saved", canonicalId } }); },
    continueQuery(step: { request: QueryRequest; result: QueryResult }) {
      if (!step.result.continuation) throw new Error("flow continuation missing");
      return run(queryBinding, { stack: adapter.destination }, { ...step.request, continuation: step.result.continuation });
    },
    async setPolicy(dataPolicy: "local" | "cloud") {
      const updated = createFlowReadAdapter({ ...source, dataPolicy }).restriction({ ...restriction, revision: String(restrictionRevision + 1) });
      await rig.service.publishHostRecord({ kind: "restriction", value: updated }, restrictionRevision++);
    },
    async close() { await rig.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
export type FlowReadRig = Awaited<ReturnType<typeof openFlowReadRig>>;
