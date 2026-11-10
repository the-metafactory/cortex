import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { authorityRig } from "../../../authority-fixtures";
import { createFlowReadAdapter } from "../../flow/read";
import { DomainAdapterRegistry } from "../../registry";
import { ReadBindings } from "../../reads/bindings";
import type { QueryRequest, QueryResult } from "../../reads/query-types";
import type { Json } from "../../operations/types";
import type { ReadBinding } from "../../reads/types";
import { releasedObjects } from "./balance-read-fixtures";

const execute = promisify(execFile);
const pulseBinary = fileURLToPath(new URL("src/cli.ts", import.meta.resolve("pulse/package.json")));
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
  await symlink(process.execPath, join(bin, "bun"));
  await writeFile(join(pkg, "arc-manifest.yaml"), "name: example-flow-package\nversion: 1.0.0\ntype: tool\n");
  await writeFile(join(pkg, "flow.yaml"), `name: ${ARC_FLOW_NAME}\nsource:\n  type: inline\ndestination:\n  type: stdout\npipeline: ./pipeline.yaml\n`);
  const arc = join(bin, "arc");
  const packages = JSON.stringify({ packages: [{ name: "example-flow-package", version: "1.0.0", type: "tool", status: "installed", installPath: pkg }] });
  await writeFile(arc, `#!/bin/sh\nprintf '%s\\n' '${packages}'\n`);
  await chmod(arc, 0o700);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), PATH: bin };
  const source = { connectionId: "connection-example", stack: "stack-example", ...(options.configured === false ? {} : { flowsDir }), binary: options.binary ?? pulseBinary, env };
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
    const result = await execute(pulseBinary, ["flow", ...args, "--flows-dir", flowsDir, "--json"], { env, timeout: 8000, maxBuffer: 1048576 });
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

export function assertNoFlowLeak(step: Awaited<ReturnType<FlowReadRig["query"]>>) {
  assert.equal(step.released, undefined);
  assert.doesNotMatch(JSON.stringify(step.result), /F_[A-Z0-9_]+|operation|receipt|sha256|count/);
}

export async function assertSavedFlowMatches(rig: FlowReadRig) {
  const listed = await rig.pulse(["list", "--saved"]);
  const flows = listed.flows as Record<string, unknown>[];
  assert.ok(flows.some(flow => flow.source === "arc" && flow.name === ARC_FLOW_NAME));
  const queried = await rig.query();
  assert.equal(queried.result.status, "ok");
  assert.equal(queried.result.groups[0]?.coverage, "exhausted");
  assert.deepEqual(releasedObjects(queried.released).map(object => object.value), flows.filter(flow => flow.source === "saved"));
  const shown = await rig.pulse(["show", FLOW_NAME]);
  const queriedFlow = releasedObjects(queried.released)[0];
  assert.ok(queriedFlow);
  const { package: _package, ...queryMetadata } = queriedFlow.value;
  const { yaml: _yaml, ...shownMetadata } = shown;
  assert.deepEqual(queryMetadata, shownMetadata);
  const read = await rig.read();
  assert.equal(read.result.status, "ok");
  const [flow] = releasedObjects(read.released);
  assert.deepEqual(flow?.ref, { adapterId: "flow", connectionId: rig.source.connectionId, objectType: "saved", canonicalId: FLOW_NAME });
  assert.deepEqual(flow?.value, shown);
  const provenance = flow?.value.provenance as Record<string, unknown>;
  assert.equal(provenance.origin, "conversation");
  assert.equal(provenance.conversation, "conversation-example");
  assert.equal(typeof provenance.saved_at, "string");
  for (const step of [await rig.read(ARC_FLOW_NAME), await rig.read(FLOW_NAME, "another-connection")]) {
    assert.equal(step.result.status, "unavailable");
    assertNoFlowLeak(step);
  }
  return shown;
}

export async function assertDeletedFlowUnavailable(rig: FlowReadRig, shown: Record<string, unknown>) {
  await rig.pulse(["delete", FLOW_NAME, "--expected-sha256", String(shown.sha256)]);
  const missing = await rig.read();
  assert.equal(missing.result.status, "unavailable");
  assertNoFlowLeak(missing);
  const empty = await rig.query();
  assert.equal(empty.result.status, "ok");
  assert.equal(empty.result.noMatch, true);
  assert.deepEqual(releasedObjects(empty.released), []);
}

export async function assertCloudReaderDenied(rig: FlowReadRig) {
  const before = rig.rig.calls.read;
  for (const denied of [await rig.query(), await rig.read()]) {
    assert.equal(denied.result.status, "denied");
    assert.equal(denied.result.restricted, true);
    assert.equal(denied.result.noMatch, false);
    assertNoFlowLeak(denied);
  }
  assert.equal(rig.rig.calls.read, before);
}
