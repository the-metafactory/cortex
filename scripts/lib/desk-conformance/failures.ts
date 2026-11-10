import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { ApprovedSnapshot, Json } from "../../../src/conversations/domain-adapters/operations/types";
import { DeskPackageLoader, type DeskPackageCandidate } from "../../../src/conversations/domain-adapters/package";
import { QueryPageSchema } from "../../../src/conversations/domain-adapters/reads/query-types";
import type { ReadBinding } from "../../../src/conversations/domain-adapters/reads/types";
import type { DraftingView } from "../../../src/conversations/domain-adapters/registry";
import type { ObjectReference } from "../../../src/conversations/domain-adapters/types";
import { confirmAndDispatch, prepareAction, snapshotForAction, type DispatchAttempt } from "./actions";
import { recordConnector } from "./connectors";
import { faultyConnector, hold, type Fault, type FaultPlan, type Hold } from "./faults";
import { guardNetwork } from "./network";
import { listDestinations, schemaIndex, type ProbeEnv } from "./probes";
import { emptyOwnerCalls, totalOwnerCalls, type OwnerCalls, type Verdict } from "./report";
import { CONNECTION_ID, authorizeConnection, exercise, openConformanceStore } from "./run";
import { openConformanceRig, STACK, type ConformanceRig } from "./rig";
import { sampleValue, schemaUrn } from "./sample";

export type ScenarioVerdict = "isolated" | "failed";
export const FAILURE_SCENARIOS = [
  "module-load", "owner-success", "owner-timeout", "owner-invalid-output", "owner-exit",
  "duplicate-delivery", "restart-after-success", "crash-before-result", "revoked-query", "revoked-write",
] as const;
export type ScenarioName = (typeof FAILURE_SCENARIOS)[number];

export interface ScenarioReport {
  scenario: ScenarioName;
  verdict: ScenarioVerdict;
  code?: string;
  detail: string;
  operation?: string;
  ownerCalls: OwnerCalls;
  released: number;
  networkRequests: number;
}

export interface CompanionReport {
  packageDir: string;
  adapterId?: string;
  status: Verdict | "not-run";
  code?: string;
  samePackage: boolean;
}

export interface FailureReport {
  packageDir: string;
  packageId?: string;
  adapterId?: string;
  status: ScenarioVerdict;
  code?: string;
  reason?: string;
  scenarios: ScenarioReport[];
  companion: CompanionReport;
  networkRequests: number;
}

export interface FailureOptions { companionDir?: string }

const HOST_WAIT_MS = 100;
const CRASH_WAIT_MS = 400;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "The scenario failed.");
const credentialOnly = (candidate: DeskPackageCandidate): string | null => {
  if (candidate.manifest.setup.authMethods.some(method => method.kind === "local")) return null;
  const kinds = candidate.manifest.setup.authMethods.map(method => method.kind).join(" and ");
  return `The package declares only ${kinds} authentication. The harness requests no credential, so no owner call was possible.`;
};

function pointer(value: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  return path.split("/").slice(1).reduce<unknown>((current, key) => isRecord(current) ? current[key] : Array.isArray(current) ? current[Number(key)] : undefined, value);
}

interface ScenarioRun {
  temp: string;
  store: Harness;
  loader: DeskPackageLoader;
  target?: DeskPackageCandidate;
  companion?: DeskPackageCandidate;
  samePackage: boolean;
  close(): Promise<void>;
}

async function prepareScenario(packageDir: string, companionDir: string): Promise<ScenarioRun> {
  const temp = await mkdtemp(join(tmpdir(), "desk-conformance-failure-"));
  const samePackage = resolve(packageDir) === resolve(companionDir);
  const targetRoot = join(temp, "package");
  const companionRoot = samePackage ? targetRoot : join(temp, "companion");
  await cp(resolve(packageDir), targetRoot, { recursive: true, dereference: false });
  if (!samePackage) await cp(resolve(companionDir), companionRoot, { recursive: true, dereference: false });
  const { engine, store } = await openConformanceStore(temp);
  const loader = new DeskPackageLoader({ bundledPackages: samePackage ? [targetRoot] : [targetRoot, companionRoot], store });
  const discovery = await loader.discover();
  const find = (root: string) => discovery.candidates.find(candidate => resolve(candidate.packageRoot) === realpathSync(root));
  const target = find(targetRoot);
  const companion = find(companionRoot);
  return { temp, store: engine, loader, ...(target ? { target } : {}), ...(companion ? { companion } : {}), samePackage,
    close: async () => { await engine.close(BACKGROUND_CONTEXT); await rm(temp, { recursive: true, force: true }); } };
}

interface Armed {
  rig: ConformanceRig;
  env: ProbeEnv;
  actionId: string;
  view: DraftingView;
  binding: ReadBinding;
  close(): Promise<void>;
}

async function arm(run: ScenarioRun, candidate: DeskPackageCandidate, plan: FaultPlan): Promise<Armed> {
  const { adapterId, manifest } = candidate;
  const action = manifest.declaration.capabilities.find(capability => capability.kind === "action");
  const actionId = action?.capabilityId;
  if (action === undefined || actionId === undefined) throw new Error("This package declares no action capability.");
  const registry = run.loader.registry();
  const view = registry.draftingView(actionId);
  if (!view) throw new Error("The registry does not describe the action capability.");
  const readIds = manifest.declaration.capabilities.filter(capability => capability.kind !== "action").map(capability => capability.capabilityId);
  const built = run.loader.trustedConnector(adapterId, { adapterId, connectionId: CONNECTION_ID }, { authorizeConnection, actionCapabilityId: actionId });
  if (!built.ok) throw new Error(built.error.message);
  const plain = built.value.connector;
  const sample = { schemas: schemaIndex(manifest), destinations: [] as ObjectReference[], adapterId, connectionId: CONNECTION_ID };
  const listed = await listDestinations({ registry, manifest, sample, plain, adapterId, connectionId: CONNECTION_ID });
  sample.destinations.push(...listed.destinations);
  const binding = manifest.readBindings.find(item => item.mode === "query" && action.objectTypes.includes(item.objectType));
  if (!binding) throw new Error("The package declares no query binding for the action's object type.");
  const { connector, recorded } = recordConnector(faultyConnector(plain, plan));
  const rig = await openConformanceRig({
    dir: run.temp, registry, connector, adapterId, connectionId: CONNECTION_ID, readBindings: manifest.readBindings, readCapabilityIds: readIds,
    writeCapabilityIds: [actionId], writerCapabilityId: actionId, destinations: sample.destinations,
  });
  const env: ProbeEnv = { rig, manifest, sample, recorded, plain, adapterId, connectionId: CONNECTION_ID };
  return { rig, env, actionId, view, binding, close: async () => { await rig.close(); } };
}

async function snapshotOf(armed: Armed): Promise<ApprovedSnapshot> {
  const prepared = await prepareAction(armed.env, armed.actionId, armed.view);
  if (!prepared.ok) throw new Error(`${prepared.report.code ?? "draft_failed"}: ${prepared.report.detail}`);
  return snapshotForAction(armed.env, armed.actionId, prepared.value);
}

async function journalState(armed: Armed, operationId: string): Promise<string | undefined> {
  return (await armed.rig.host.lifecycleJournal(armed.rig.registry).read(operationId))?.journal.state;
}

async function receiptCount(armed: Armed, operationId: string): Promise<number> {
  return (await armed.rig.host.lifecycleJournal(armed.rig.registry).read(operationId))?.outbox.length ?? 0;
}

async function ownerEffects(armed: Armed, input: Json): Promise<number> {
  const title = pointer(input, armed.binding.display.title);
  const destination = armed.env.sample.destinations[0];
  if (typeof title !== "string" || !armed.env.plain.query || !destination) return 0;
  const raw = await armed.env.plain.query({
    readVersion: "1.0.0", queryId: randomUUID(), capabilityId: armed.binding.capabilityId, destinations: [destination], limit: 50,
    input: sampleValue(armed.env.sample.schemas.get(schemaUrn(armed.binding.inputSchemaRef.schemaId, armed.binding.inputSchemaRef.version)), armed.env.sample) as Json,
  }, new AbortController().signal);
  const parsed = QueryPageSchema.parse(raw);
  const items = isRecord(parsed.payload) && Array.isArray(parsed.payload.items) ? parsed.payload.items : [];
  return items.filter(item => pointer(item, armed.binding.display.title) === title).length;
}

interface Evidence {
  detail: string;
  code?: string;
  incomplete?: true;
  operation?: string;
  allowed?: readonly string[];
  effects?: number;
  receipts?: number;
  retried?: boolean;
  released?: number;
  calls?: OwnerCalls;
}

function judge(scenario: ScenarioName, evidence: Evidence, companion: CompanionReport, egress: number): ScenarioReport {
  const released = evidence.released ?? 0;
  const broken: string[] = [];
  if (evidence.incomplete === true) broken.push(evidence.code ?? "scenario_incomplete");
  if (evidence.allowed !== undefined && evidence.operation === undefined) broken.push("operation_unknown");
  if (evidence.operation !== undefined && evidence.allowed !== undefined && !evidence.allowed.includes(evidence.operation)) broken.push(`operation_${evidence.operation}`);
  if (evidence.retried === true) broken.push("retry_issued");
  if ((evidence.calls?.dispatch ?? 0) > 1) broken.push(`owner_calls_${String(evidence.calls?.dispatch)}`);
  if (released !== 0) broken.push("result_released");
  if (egress !== 0) broken.push("network_egress");
  if (evidence.effects !== undefined && evidence.effects !== 1) broken.push(`owner_effects_${String(evidence.effects)}`);
  if (evidence.receipts !== undefined && evidence.receipts !== 1) broken.push(`receipts_${String(evidence.receipts)}`);
  if (companion.status !== "conformant" && companion.status !== "not-run") broken.push(`companion_${companion.status}`);
  const code = broken[0] ?? evidence.code;
  return {
    scenario, verdict: broken.length === 0 ? "isolated" : "failed", ...(code === undefined ? {} : { code }), detail: evidence.detail,
    ...(evidence.operation === undefined ? {} : { operation: evidence.operation }), ownerCalls: evidence.calls ?? emptyOwnerCalls(), released, networkRequests: egress,
  };
}

async function replaySettled(dispatch: () => Promise<{ kind: string }>): Promise<boolean> {
  return (await dispatch()).kind === "settled";
}

interface EffectFacts { effects: number; retried: boolean; calls: OwnerCalls; receipts?: number }

async function effectFacts(armed: Armed, snapshot: ApprovedSnapshot, dispatched: DispatchAttempt, extra: { receipts?: number } = {}): Promise<EffectFacts> {
  const retried = await replaySettled(() => dispatched.run.bridge.dispatch(armed.rig.context, dispatched.run.operationId, armed.rig.lease));
  return {
    effects: await ownerEffects(armed, snapshot.input), retried, calls: armed.env.recorded.ownerCalls,
    ...(extra.receipts === undefined ? {} : { receipts: extra.receipts }),
  };
}

const successBody = async (armed: Armed): Promise<Evidence> => {
  const snapshot = await snapshotOf(armed);
  const dispatched = await confirmAndDispatch(armed.env, armed.actionId, snapshot);
  const operation = await journalState(armed, dispatched.run.operationId);
  return {
    detail: `a confirmed dispatch ended as ${operation ?? "unknown"}`, ...(operation === undefined ? {} : { operation }), allowed: ["succeeded"],
    ...await effectFacts(armed, snapshot, dispatched, { receipts: await receiptCount(armed, dispatched.run.operationId) }),
  };
};

const uncertainBody = (sentences: string) => async (armed: Armed): Promise<Evidence> => {
  const snapshot = await snapshotOf(armed);
  const dispatched = await confirmAndDispatch(armed.env, armed.actionId, snapshot, HOST_WAIT_MS);
  const operation = await journalState(armed, dispatched.run.operationId);
  return {
    detail: `${sentences} left the operation ${operation ?? "unknown"}; a replay was refused`,
    ...(operation === undefined ? {} : { operation }), allowed: ["uncertain"],
    ...await effectFacts(armed, snapshot, dispatched),
  };
};

const redeliveryBody = (reopen: boolean) => async (armed: Armed): Promise<Evidence> => {
  const snapshot = await snapshotOf(armed);
  const dispatched = await confirmAndDispatch(armed.env, armed.actionId, snapshot);
  if (reopen) await armed.rig.reopen();
  const again = await confirmAndDispatch(armed.env, armed.actionId, snapshot);
  const operation = await journalState(armed, dispatched.run.operationId);
  const answer = again.report.code ?? again.report.verdict;
  return {
    detail: reopen
      ? `after a restart the operation stayed ${operation ?? "unknown"} and a redelivery was answered ${answer}`
      : `a duplicate delivery was answered ${answer} without a second owner call`,
    ...(operation === undefined ? {} : { operation }), allowed: ["succeeded"],
    effects: await ownerEffects(armed, snapshot.input), receipts: await receiptCount(armed, dispatched.run.operationId),
    retried: again.report.verdict === "conformant", calls: armed.env.recorded.ownerCalls,
  };
};

const crashBody = (held: Hold) => async (armed: Armed): Promise<Evidence> => {
  const snapshot = await snapshotOf(armed);
  void confirmAndDispatch(armed.env, armed.actionId, snapshot, CRASH_WAIT_MS).catch(() => null);
  await held.reached;
  const operationId = `${armed.rig.conversationId}:conformance-proposal:1`;
  await armed.rig.reopen();
  const bridge = armed.rig.host.lifecycleBridge(armed.rig.registry, armed.rig.bindings, () => armed.env.plain.support, HOST_WAIT_MS);
  const recovered = await bridge.recover(operationId);
  const activatable = await bridge.activate({ stack: STACK, owner: armed.env.plain.writerOwner, adapterId: armed.env.adapterId, connectionId: armed.env.connectionId, capabilityId: armed.actionId }, armed.rig.lease);
  const replay = activatable ? await bridge.dispatch(armed.rig.context, operationId, armed.rig.lease) : null;
  return {
    detail: `the store reopened on a prepared attempt, recovered it as ${recovered?.journal.state ?? "unknown"} and replayed ${replay?.kind ?? "nothing"}`,
    ...(recovered === null ? {} : { operation: recovered.journal.state }), allowed: ["uncertain"],
    effects: await ownerEffects(armed, snapshot.input), retried: replay?.kind === "settled", calls: armed.env.recorded.ownerCalls,
  };
};

const revokedQueryBody = (held: Hold) => async (armed: Armed): Promise<Evidence> => {
  const runner = armed.rig.host.readQueries(armed.rig.registry, armed.rig.bindings);
  const source = {
    adapterId: armed.env.adapterId, connectionId: armed.env.connectionId, capabilityId: armed.binding.capabilityId, inputSchemaRef: armed.binding.inputSchemaRef,
    destinations: [...armed.env.sample.destinations],
    input: sampleValue(armed.env.sample.schemas.get(schemaUrn(armed.binding.inputSchemaRef.schemaId, armed.binding.inputSchemaRef.version)), armed.env.sample) as Json,
  };
  try {
    const request = await runner.create(armed.rig.context, [source], armed.rig.sink);
    const running = runner.run(armed.rig.context, request, armed.rig.sink);
    await held.reached;
    await armed.rig.revokeConnection();
    held.release();
    const result = await running;
    return {
      detail: `a read revoked in flight ended ${result.groups[0]?.status ?? result.status} with ${String(armed.rig.sends.length)} release(s)`,
      released: armed.rig.sends.length,
    };
  } finally {
    runner.close();
  }
};

const revokedWriteBody = (held: Hold) => async (armed: Armed): Promise<Evidence> => {
  const snapshot = await snapshotOf(armed);
  const pending = confirmAndDispatch(armed.env, armed.actionId, snapshot, HOST_WAIT_MS);
  await held.reached;
  await armed.rig.revokeConnection();
  const dispatched = await pending;
  const operation = await journalState(armed, dispatched.run.operationId);
  return {
    detail: `a write revoked in flight stayed ${operation ?? "unknown"} with ${String(armed.rig.sends.length)} release(s)`,
    ...(operation === undefined ? {} : { operation }), allowed: ["uncertain"], released: armed.rig.sends.length,
    ...await effectFacts(armed, snapshot, dispatched),
  };
};

type ScenarioPlan = { fault: FaultPlan; body: (armed: Armed) => Promise<Evidence> };

const withHold = (path: "dispatch" | "query", body: (held: Hold) => (armed: Armed) => Promise<Evidence>) => (): ScenarioPlan => {
  const held = hold();
  const fault: Fault = held.fault;
  return { fault: { [path]: fault }, body: body(held) };
};

const PLANS: Record<Exclude<ScenarioName, "module-load">, () => ScenarioPlan> = {
  "owner-success": () => ({ fault: {}, body: successBody }),
  "owner-timeout": () => ({ fault: { dispatch: { kind: "timeout" } }, body: uncertainBody("a silent owner") }),
  "owner-invalid-output": () => ({ fault: { dispatch: { kind: "invalid-output" } }, body: uncertainBody("unparseable owner output") }),
  "owner-exit": () => ({ fault: { dispatch: { kind: "exit", code: 7 } }, body: uncertainBody("a non-zero owner exit") }),
  "duplicate-delivery": () => ({ fault: {}, body: redeliveryBody(false) }),
  "restart-after-success": () => ({ fault: {}, body: redeliveryBody(true) }),
  "crash-before-result": withHold("dispatch", crashBody),
  "revoked-query": withHold("query", revokedQueryBody),
  "revoked-write": withHold("dispatch", revokedWriteBody),
};

async function probeCompanion(run: ScenarioRun, originalDir: string, targetActivated: boolean): Promise<CompanionReport> {
  const candidate = run.companion;
  if (!candidate) return { packageDir: originalDir, status: "refused", code: "no_package", samePackage: run.samePackage };
  const base = { packageDir: originalDir, adapterId: candidate.adapterId, samePackage: run.samePackage };
  if (run.samePackage && !targetActivated) return { ...base, status: "not-run" };
  if (credentialOnly(candidate) !== null) return { ...base, status: "not-run", code: "authentication_unsupported" };
  const activated = await run.loader.activate(candidate.packageId);
  if (!activated.ok) return { ...base, status: "refused", code: activated.error.code };
  const outcome = await exercise(run.loader, candidate, run.temp, { packageDir: originalDir, actions: [], credentialRequests: 0 });
  return { ...base, status: outcome.status, ...(outcome.code === undefined ? {} : { code: outcome.code }) };
}

interface RanScenario { report: ScenarioReport; companion: CompanionReport; packageId?: string; adapterId?: string }

async function runScenario(scenario: ScenarioName, packageDir: string, companionDir: string, guard: ReturnType<typeof guardNetwork>): Promise<RanScenario> {
  const started = guard.count();
  const run = await prepareScenario(packageDir, companionDir);
  const candidate = run.target;
  let evidence: Evidence = { detail: "The scenario ran nothing.", calls: emptyOwnerCalls() };
  let activated = false;
  try {
    const loaded = candidate === undefined
      ? { ok: false as const, error: { code: "no_package", message: "No bundled package was discovered at the given path." } }
      : candidate.state.state === "unavailable" ? { ok: false as const, error: { code: candidate.state.code, message: candidate.state.message } }
      : await run.loader.activate(candidate.packageId);
    activated = loaded.ok;
    if (scenario === "module-load") {
      evidence = loaded.ok
        ? { detail: `the package loaded as ${candidate?.adapterId ?? "unknown"} and made no owner call`, calls: emptyOwnerCalls() }
        : { detail: loaded.error.message, code: loaded.error.code, calls: emptyOwnerCalls() };
    } else if (!loaded.ok) {
      evidence = { detail: `${loaded.error.message} No action could be driven.`, code: loaded.error.code, calls: emptyOwnerCalls() };
    } else if (candidate === undefined) {
      evidence = { detail: "No bundled package was discovered at the given path.", code: "no_package", calls: emptyOwnerCalls() };
    } else if (credentialOnly(candidate) !== null) {
      evidence = { detail: credentialOnly(candidate) ?? "", code: "authentication_unsupported", calls: emptyOwnerCalls() };
    } else if (!candidate.manifest.declaration.capabilities.some(capability => capability.kind === "action")) {
      evidence = { detail: "The package declares no action capability, so this scenario could make no owner call.", code: "no_action_capability", calls: emptyOwnerCalls() };
    } else {
      const plan = PLANS[scenario]();
      let armed: Armed | undefined;
      try {
        armed = await arm(run, candidate, plan.fault);
        evidence = await plan.body(armed);
      } catch (error) {
        evidence = { detail: messageOf(error), code: "scenario_threw", incomplete: true, calls: armed?.env.recorded.ownerCalls ?? emptyOwnerCalls() };
      } finally {
        await armed?.close();
      }
    }
    const companion = await probeCompanion(run, companionDir, activated);
    const egress = guard.count() - started;
    return { report: judge(scenario, evidence, companion, egress), companion, ...(candidate === undefined ? {} : { packageId: candidate.packageId, adapterId: candidate.adapterId }) };
  } finally {
    await run.close();
  }
}

/** Drives one package through the named failure scenarios and reports each as isolated or failed. */
export async function runFailureScenarios(packageDir: string, options: FailureOptions = {}): Promise<FailureReport> {
  const guard = guardNetwork();
  const companionDir = resolve(options.companionDir ?? packageDir);
  try {
    const scenarios: ScenarioReport[] = [];
    let companion: CompanionReport = { packageDir: companionDir, status: "not-run", samePackage: companionDir === resolve(packageDir) };
    let identity: { packageId?: string; adapterId?: string } = {};
    for (const scenario of FAILURE_SCENARIOS) {
      const ran = await runScenario(scenario, packageDir, companionDir, guard);
      scenarios.push(ran.report);
      companion = ran.companion;
      identity = { ...(ran.packageId === undefined ? {} : { packageId: ran.packageId }), ...(ran.adapterId === undefined ? {} : { adapterId: ran.adapterId }) };
    }
    const failed = scenarios.find(item => item.verdict === "failed");
    return {
      packageDir, ...identity, status: failed ? "failed" : "isolated", ...(failed?.code === undefined ? {} : { code: failed.code }),
      ...(failed === undefined ? {} : { reason: `Scenario ${failed.scenario} broke isolation: ${failed.detail}` }),
      scenarios, companion, networkRequests: guard.count(),
    };
  } finally {
    guard.release();
  }
}

export function formatFailureReport(report: FailureReport): string {
  const lines = [`${report.status.toUpperCase()}${report.code ? ` ${report.code}` : ""}  ${report.packageId ?? report.packageDir}`];
  if (report.reason) lines.push(`  ${report.reason}`);
  for (const item of report.scenarios) {
    lines.push(`  ${item.verdict.padEnd(9)} ${item.scenario.padEnd(22)}${item.code ? ` [${item.code}]` : ""}${item.operation ? ` ${item.operation}` : ""}  ${item.detail}`);
  }
  lines.push(`  companion: ${report.companion.adapterId ?? report.companion.packageDir} ${report.companion.status}${report.companion.code ? ` [${report.companion.code}]` : ""}; owner calls: ${String(report.scenarios.reduce((sum, item) => sum + totalOwnerCalls(item.ownerCalls), 0))}; network requests: ${String(report.networkRequests)}`);
  return lines.join("\n");
}
