import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { MailReadSource } from "../../conversations/domain-adapters/mail-read-source";
import type { MailExecutionConnections } from "../../conversations/domain-adapters/mail-execution-source";
import type { MailExecutionSource } from "../../conversations/domain-adapters/mail-execution";
import { mailAccountRef } from "../../conversations/domain-adapters/mail/move-contract";
import { snapshotDigest } from "../../conversations/domain-adapters/operations/validation";
import type { ApprovedSnapshot, Json, Provenance } from "../../conversations/domain-adapters/operations/types";
import { DeskPackageLoader } from "../../conversations/domain-adapters/package";
import { actionProvenance, confirmAndDispatch } from "./actions";
import { CONFORMANCE_CONNECTION_ID } from "./connection";
import { guardNetwork } from "./network";
import { schemaIndex, type ProbeEnv } from "./probes";
import type { OwnerCalls } from "./report";
import { ConformanceRefusal, STACK, type ConformanceRig } from "./rig";
import { recordConnector } from "./connectors";
import { canonicalWire } from "../../conversations/domain-adapters/operations/validation";
import { authorizeConnection, conformanceMailBinding, openConformanceConnection, openConformanceStore } from "./run";

/** Data for constructing a Mail approval inside a synthetic local conversation. */
export interface MailActionScenarioContext {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly account: string;
  readonly provenance: Provenance;
}

const MAIL_ACTION_STEPS = ["repeat", "reopen", "restart", "reconcile"] as const;
/** Bounded lifecycle steps over the same approved operation, never another provider attempt. */
export type MailActionScenarioStep = (typeof MAIL_ACTION_STEPS)[number];

/** The snapshot callback supplies data only; the runner computes its digest and invokes normal authority. */
export interface MailActionScenarioOptions {
  capabilityId: string;
  mail: MailReadSource;
  snapshot(context: MailActionScenarioContext): Omit<ApprovedSnapshot, "digest">;
  steps?: readonly MailActionScenarioStep[];
  dispatchWaitMs?: number;
  execution?: MailExecutionConnections;
}

/** A stage observed from the production journal, including its actual receipt entries. */
export interface MailActionScenarioStage {
  step: "dispatch" | MailActionScenarioStep;
  outcome: string;
  state: string | null;
  snapshotDigest: string | null;
  attemptIds: string[];
  receipts: Json[];
}

/** Evidence, not an acceptance verdict: consumers assert their expected states and provider effects. */
export interface MailActionScenarioReport {
  packageDir: string;
  packageId: string;
  adapterId: string;
  capabilityId: string;
  operationId: string;
  snapshot: ApprovedSnapshot;
  stages: MailActionScenarioStage[];
  events: Json[];
  ownerCalls: OwnerCalls;
  networkRequests: number;
  credentialRequests: number;
  reconstructions: number;
}

/** Drives an external Mail fixture through real approval, dispatch, durable reopening and lookup reconciliation. */
export async function runMailActionScenario(packageDir: string, options: MailActionScenarioOptions): Promise<MailActionScenarioReport> {
  const steps = [...options.steps ?? []];
  const waitMs = options.dispatchWaitMs ?? 100;
  if (steps.length > 16) throw new Error("A Mail action scenario permits at most sixteen lifecycle steps.");
  for (const step of steps) if (!MAIL_ACTION_STEPS.includes(step)) throw new Error(`Unknown Mail action scenario step: ${step}`);
  if (!Number.isFinite(waitMs) || waitMs < 1 || waitMs > 10_000) throw new Error("A Mail action scenario dispatch wait must be between one and ten thousand milliseconds.");
  const temp = await mkdtemp(join(tmpdir(), "desk-mail-action-"));
  const guard = guardNetwork();
  try {
    const { engine, store } = await openConformanceStore(temp);
    try {
      const activeRig: { current?: ConformanceRig } = {};
      const mailExecution: MailExecutionSource | undefined = options.execution ? { connection: binding => options.execution?.connection(binding), journal: () => {
        if (!activeRig.current) throw new Error("The Mail scenario has no active journal.");
        return activeRig.current.host.lifecycleJournal(activeRig.current.registry);
      } } : undefined;
      const makeLoader = () => new DeskPackageLoader({ bundledPackages: [resolve(packageDir)], store, mail: options.mail, ...(mailExecution ? { mailExecution } : {}) });
      let loader = makeLoader();
      const discovery = await loader.discover();
      const candidate = discovery.candidates[0];
      if (!candidate) throw new ConformanceRefusal(discovery.issues[0]?.code ?? "no_package", discovery.issues[0]?.message ?? "No Desk adapter package was found.");
      if (candidate.state.state === "unavailable") throw new ConformanceRefusal(candidate.state.code, candidate.state.message);
      if (!candidate.manifest.setup.authMethods.some(method => method.kind === "local")) throw new ConformanceRefusal("authentication_unsupported", "Mail scenarios require a local synthetic fixture and request no credential.");
      const activated = await loader.activate(candidate.packageId);
      if (!activated.ok) throw new ConformanceRefusal(activated.error.code, activated.error.message);
      const mailBinding = conformanceMailBinding(options.mail, candidate.adapterId);
      if (!mailBinding) throw new ConformanceRefusal("mail_binding_missing", "A Mail scenario requires exactly one synthetic binding for its connection.");
      const connectionId = CONFORMANCE_CONNECTION_ID;
      const built = loader.trustedConnector(candidate.adapterId, { adapterId: candidate.adapterId, connectionId }, { authorizeConnection, actionCapabilityId: options.capabilityId });
      if (!built.ok) throw new ConformanceRefusal(built.error.code, built.error.message);
      let plain = built.value.connector;
      const destinations = [mailAccountRef(candidate.adapterId, connectionId, mailBinding.account)];
      const opened = await openConformanceConnection(loader, candidate, temp, { connectionId, plain, actionId: options.capabilityId, destinations, mailBinding, historicalLookup: true });
      const rig = opened.rig;
      activeRig.current = rig;
      let recorded = opened.recorded;
      let reconstructions = 0;
      const previousCalls = { dispatch: 0, cancel: 0, lookup: 0, readback: 0 };
      try {
        const env: ProbeEnv = { rig, manifest: candidate.manifest, sample: { schemas: schemaIndex(candidate.manifest), destinations, adapterId: candidate.adapterId, connectionId }, recorded, plain, adapterId: candidate.adapterId, connectionId };
        const supplied = options.snapshot({ adapterId: candidate.adapterId, connectionId, account: mailBinding.account, provenance: actionProvenance(rig.conversationId) });
        const { digest: _suppliedDigest, ...parts } = { ...supplied, digest: "" };
        const snapshot: ApprovedSnapshot = { ...parts, digest: snapshotDigest(parts) };
        const dispatched = await confirmAndDispatch(env, options.capabilityId, snapshot, waitMs);
        let bridge = dispatched.run.bridge;
        const operationId = dispatched.run.operationId;
        const stages: MailActionScenarioStage[] = [];
        const observe = async (step: MailActionScenarioStage["step"], outcome: string): Promise<void> => {
          const stored = await rig.host.lifecycleJournal(rig.registry).read(operationId);
          stages.push({ step, outcome, state: stored?.journal.state ?? null, snapshotDigest: stored && "digest" in stored.journal.snapshot ? stored.journal.snapshot.digest : null,
            attemptIds: stored?.journal.events.flatMap(entry => entry.event.kind === "attempt-prepared" ? [entry.event.attempt.attemptId] : []) ?? [],
            receipts: stored?.outbox.map(entry => z.json().parse(entry)) ?? [] });
        };
        await observe("dispatch", dispatched.run.outcome?.kind ?? dispatched.report.code ?? "refused");
        for (const step of steps) {
          if (!await rig.host.lifecycleJournal(rig.registry).read(operationId)) break;
          if (step === "reopen" || step === "restart") {
            let rebuilt;
            if (step === "restart") {
              const next = makeLoader();
              const found = await next.discover();
              const current = found.candidates.find(item => item.packageId === candidate.packageId && item.releaseDigest === candidate.releaseDigest);
              if (!current) throw new ConformanceRefusal("package_changed", "The package changed before reconstruction.");
              const activated = await next.activate(current.packageId);
              if (!activated.ok) throw new ConformanceRefusal(activated.error.code, activated.error.message);
              const replacement = next.trustedConnector(candidate.adapterId, { adapterId: candidate.adapterId, connectionId }, { authorizeConnection, actionCapabilityId: options.capabilityId });
              if (!replacement.ok) throw new ConformanceRefusal(replacement.error.code, replacement.error.message);
              if (plain.writerOwner !== replacement.value.connector.writerOwner || canonicalWire(plain.support) !== canonicalWire(replacement.value.connector.support)) throw new ConformanceRefusal("connection_changed", "The reconstructed connector changed its writer contract.");
              for (const key of ["dispatch", "cancel", "lookup", "readback"] as const) previousCalls[key] += recorded.ownerCalls[key];
              plain = replacement.value.connector;
              rebuilt = recordConnector(plain);
              recorded = rebuilt.recorded;
              loader = next;
              reconstructions++;
            }
            await rig.reopen(rebuilt?.connector);
            bridge = rig.host.lifecycleBridge(rig.registry, rig.bindings, () => plain.support, waitMs);
            if (!await bridge.activate({ stack: STACK, owner: plain.writerOwner, adapterId: candidate.adapterId, connectionId, capabilityId: options.capabilityId }, rig.lease)) throw new ConformanceRefusal("writer_inactive", "The reopened writer could not activate.");
            await observe(step, "reopened");
          } else if (step === "reconcile") {
            const outcome = await rig.host.lifecycleReconciler(rig.registry, rig.bindings, bridge, () => plain.support).check(rig.context, operationId, rig.sink);
            await observe(step, outcome.kind);
          } else {
            const outcome = await bridge.dispatch(rig.context, operationId, rig.lease);
            if (outcome.kind !== "timed-out") await bridge.settled();
            await observe(step, outcome.kind);
          }
        }
        const stored = await rig.host.lifecycleJournal(rig.registry).read(operationId);
        return { packageDir: resolve(packageDir), packageId: candidate.packageId, adapterId: candidate.adapterId, capabilityId: options.capabilityId, operationId, snapshot,
          stages, events: stored?.journal.events.map(entry => z.json().parse(entry)) ?? [], ownerCalls: { dispatch: previousCalls.dispatch + recorded.ownerCalls.dispatch, cancel: previousCalls.cancel + recorded.ownerCalls.cancel, lookup: previousCalls.lookup + recorded.ownerCalls.lookup, readback: previousCalls.readback + recorded.ownerCalls.readback }, networkRequests: guard.count(), credentialRequests: 0, reconstructions };
      } finally { await rig.close(); }
    } finally { await engine.close(BACKGROUND_CONTEXT); }
  } finally { guard.release(); await rm(temp, { recursive: true, force: true }); }
}
