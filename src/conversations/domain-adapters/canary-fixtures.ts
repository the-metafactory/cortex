import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableConnection, connectionSetupRig, listConnections } from "../connection-setup-fixtures";
import { ownerResultKit, requestParts } from "./operations/owner-results";
import { receiptStatus } from "./operations/reconciliation";
import { dispatchRigWith, ownerResult, type DispatchRigOptions } from "./operations/dispatch-fixtures";
import { AT } from "./operations/fixtures";
import { objectRef } from "./fixtures";
import { balanceBinding, balanceResponse, draftingRegistry, draftingState, graphBinding } from "./drafting-fixtures";
import { DraftingBindings } from "./drafting";
import { queryArea, queryBinding, queryRegistry, syntheticQueryPage } from "./reads/query-fixtures";
import type { QuerySource } from "./reads/query-types";
import type { DispatchRequest, OwnerResult } from "./operations/types";
import type { ArcSecretStore } from "../../common/config/desk-credential-arc-file-store";
import { DESK_CONNECTIONS_PATH } from "../../surface/mc/api/desk-connections";

export const CANARY = "desk-canary-51e2a7b9c4d1";

export const CANARY_SINKS = ["log", "event", "receipt", "ui", "model"] as const;
export type CanarySink = (typeof CANARY_SINKS)[number];
export type CanarySinks = Record<CanarySink, string[]>;

export const CANARY_PATHS = ["query", "dispatch:owner-result", "draft", "failure:owner-error"] as const;
export type CanaryPath = (typeof CANARY_PATHS)[number];

export const emptyCanarySinks = (): CanarySinks => ({ log: [], event: [], receipt: [], ui: [], model: [] });

const renderError = (error: Error): string => `${error.name}: ${error.message}\n${error.stack ?? ""}`;
const stringify = (value: unknown): string => {
  const text = JSON.stringify(value, (_key, item: unknown) => item instanceof Error ? renderError(item) : item) as string | undefined;
  return text ?? String(value);
};
const rendered = (value: unknown): string => value instanceof Error ? renderError(value) : typeof value === "string" ? value : stringify(value);

interface CapturedLog { lines: string[]; restore(): void }
const LOG_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export function captureLog(): CapturedLog {
  const lines: string[] = [];
  const original = LOG_METHODS.map(method => console[method]);
  for (const method of LOG_METHODS) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map(arg => {
        try { return rendered(arg); } catch { return String(arg); }
      }).join(" "));
    };
  }
  return {
    lines,
    restore() { LOG_METHODS.forEach((method, index) => { const saved = original[index]; if (saved) console[method] = saved; }); },
  };
}

const canaryForms = (canary: string): string[] => [...new Set([
  canary,
  Buffer.from(canary).toString("base64"),
  Buffer.from(canary).toString("hex"),
  encodeURIComponent(canary),
  canary.slice(canary.lastIndexOf("-") + 1),
])];

const occurrencesIn = (entry: string, forms: readonly string[]): number =>
  forms.reduce((most, form) => Math.max(most, form.length === 0 ? 0 : entry.split(form).length - 1), 0);

export interface CanaryFinding {
  readonly sink: CanarySink;
  readonly occurrences: number;
}

export function scanCanary(sinks: CanarySinks, canary: string = CANARY): CanaryFinding[] {
  const forms = canaryForms(canary);
  return CANARY_SINKS.flatMap(sink => {
    const matches = sinks[sink].reduce((total, entry) => total + occurrencesIn(entry, forms), 0);
    return matches > 0 ? [{ sink, occurrences: matches }] : [];
  });
}

export interface CanaryProbeResult {
  readonly covered: CanarySink[];
  readonly missing: CanarySink[];
  readonly findings: CanaryFinding[];
  readonly credentialWritten: boolean;
  readonly credentialHoldsCanary: boolean;
  readonly paths: CanaryPath[];
  readonly entries: Record<CanarySink, number>;
}

export async function storeHoldsCanary(store: ArcSecretStore | null, identity: string, written: string): Promise<boolean> {
  return written === CANARY && store !== null && await store.matches(identity, CANARY);
}

export const canaryExitCode = (result: CanaryProbeResult): number =>
  result.credentialWritten && result.credentialHoldsCanary && result.missing.length === 0 && result.findings.length === 0 ? 0 : 1;

export interface CanaryLine {
  readonly stream: "out" | "err";
  readonly text: string;
}

export function canaryReport(result: CanaryProbeResult, leak: CanarySink | null = null): CanaryLine[] {
  const lines: CanaryLine[] = CANARY_SINKS.map(sink => {
    if (result.missing.includes(sink)) return { stream: "err" as const, text: `❌ ${sink}: not covered by the synthetic stack` };
    if (result.findings.some(finding => finding.sink === sink)) return { stream: "err" as const, text: `❌ ${sink}: the canary appeared in the ${sink} render target` };
    return { stream: "out" as const, text: `✅ ${sink}: scanned, the canary appeared nowhere` };
  });
  lines.push(result.credentialWritten && result.credentialHoldsCanary
    ? { stream: "out", text: "✅ credential: the fixture connection's arc-backed secret store holds the canary" }
    : { stream: "err", text: `❌ credential: ${result.credentialWritten ? "the fixture connection's secret store does not hold the canary" : "the fixture connection's secret store was not written"}` });
  if (leak === null) {
    lines.push(canaryExitCode(result) === 0
      ? { stream: "out", text: "Desk adapter canary probe passed: the query, draft, dispatch and failure paths ran in a stack whose connection authorizes against the canary credential, and no log, event, receipt, UI response or model context held the value. Synthetic temporary stack only." }
      : { stream: "err", text: "Desk adapter canary probe failed: see the named render targets above. The value is never printed." });
    return lines;
  }
  const detected = result.findings.some(finding => finding.sink === leak);
  lines.push({ stream: "err", text: detected
    ? `The leaking fixture adapter wrote the canary through the ${leak} path, and the scan named that render target.`
    : `The leaking fixture adapter wrote the canary through the ${leak} path, but the scan did not name it.` });
  return lines;
}

export interface CanaryStack extends Omit<CanaryProbeResult, "findings"> {
  readonly sinks: CanarySinks;
  close(): Promise<void>;
}

export interface CanaryStackOptions {
  root: string;
  leak?: CanarySink | null;
}

export interface CanaryProbeOptions {
  leak?: CanarySink | null;
  root?: string;
}

type DispatchRig = Awaited<ReturnType<typeof dispatchRigWith>>;
interface Closable { close(): Promise<void> }

const eventText = (events: readonly object[]): string[] => events.map(event => rendered(event));

async function captureSettings(root: string, sinks: CanarySinks, opened: Closable[]): Promise<void> {
  const setup = await connectionSetupRig({ dir: join(root, "setup") });
  opened.push(setup);
  const connection = await enableConnection(setup, { primary: { token: CANARY }, backup: { reference: "EXAMPLE_API_KEY" } });
  sinks.ui.push(rendered(connection));
  const settings = await setup.http("local", "GET", DESK_CONNECTIONS_PATH, undefined);
  sinks.ui.push(settings.text);
  const missingConnection = await setup.http("local", "POST", `${DESK_CONNECTIONS_PATH}/00000000-0000-4000-8000-000000000000/enable`, { expectedRevision: 1 });
  sinks.ui.push(missingConnection.text);
  for (const view of await listConnections(setup)) sinks.event.push(...eventText(await setup.host().adapterDiagnostics().events(view.connectionId)));
}

async function captureQuery(live: DispatchRig, sinks: CanarySinks, leaking: CanarySink | null, credential: string): Promise<void> {
  const source: QuerySource = { adapterId: "balance", connectionId: live.connection.connectionId, capabilityId: queryBinding.capabilityId, inputSchemaRef: queryBinding.inputSchemaRef, destinations: [queryArea], input: { area: queryArea, title: "synthetic canary query" } };
  live.hooks.query = () => {
    if (leaking === "log") console.error(new Error(`desk-adapter-fixture: the credential ${credential} could not be used`));
    const page = syntheticQueryPage();
    return Promise.resolve(leaking === "ui" ? { ...page, payload: { items: [{ title: credential, area: queryArea }] } } : page);
  };
  const queries = live.host.readQueries(live.registry, live.bindings);
  const request = await queries.create(live.context, [source], live.sink);
  const queried = await queries.run(live.context, request, live.sink);
  sinks.ui.push(rendered(queried));
  for (const released of live.calls.sends) sinks.ui.push(rendered(released));
}

async function captureDispatch(live: DispatchRig, sinks: CanarySinks, answer: (request: DispatchRequest) => OwnerResult): Promise<void> {
  const confirmed = await live.confirm();
  if (confirmed.kind !== "allowed") throw new Error("Synthetic confirmation denied.");
  if (!await live.activate()) throw new Error("The synthetic dispatch bridge did not activate.");
  live.hooks.dispatch = request => Promise.resolve(answer(request));
  const outcome = await live.dispatch();
  if (outcome.kind !== "settled") throw new Error(`The synthetic dispatch did not settle: ${outcome.kind}`);
  const stored = await live.events();
  sinks.receipt.push(rendered(stored));
  if (stored) {
    sinks.receipt.push(rendered(receiptStatus(stored)));
    sinks.receipt.push(rendered(ownerResultKit("balance").legacyResult(stored, "task")));
  }
  sinks.event.push(...eventText(await live.host.adapterDiagnostics().events(live.connection.connectionId)));
}

async function captureDraft(live: DispatchRig, sinks: CanarySinks, leaking: CanarySink | null, credential: string): Promise<void> {
  const balance = balanceBinding();
  const guidance = leaking === "model"
    ? { ...balance.guidance, instructions: `Draft a review task for the credential ${credential}.` }
    : balance.guidance;
  const drafting = draftingRegistry();
  const bindings = new DraftingBindings(drafting.registry);
  for (const binding of [{ ...balance, guidance }, graphBinding()]) {
    const registered = bindings.register(binding);
    if (!registered.ok) throw new Error(registered.error.code);
  }
  const draft = draftingState();
  draft.state.response = () => balanceResponse();
  const drafts = live.host.drafts({ registry: drafting.registry, bindings, sources: draft.sources, policy: draft.policy, model: draft.model, destinations: draft.destinations, now: () => new Date(AT) });
  await drafts.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: live.connection.connectionId });
  sinks.model.push(...draft.state.requests.map(rendered));
}

export async function openCanaryStack(options: CanaryStackOptions): Promise<CanaryStack> {
  const leaking = options.leak ?? null;
  const log = captureLog();
  const sinks: CanarySinks = { ...emptyCanarySinks(), log: log.lines };
  const opened: Closable[] = [];
  const paths: CanaryPath[] = [];
  const teardown = async (): Promise<void> => {
    for (const item of [...opened].reverse()) await item.close();
    log.restore();
  };
  try {
    await captureSettings(options.root, sinks, opened);

    const liveOptions: DispatchRigOptions = { dir: join(options.root, "live"), credential: CANARY, readSetup: { registry: queryRegistry(), binding: queryBinding } };
    const live = await dispatchRigWith(liveOptions);
    opened.push(live);
    if (live.secretPath === null) throw new Error("The canary credential has no secret store.");
    const credential = await readFile(live.secretPath, "utf8");
    const credentialWritten = live.credentialWrite === "created";
    const credentialHoldsCanary = await storeHoldsCanary(live.secrets, live.secretIdentity, credential);

    if (leaking === "event") await live.host.adapterDiagnostics().record({ event: "desk.adapter.query_refused", adapterId: "balance", connectionId: live.connection.connectionId, state: "refused", errorCode: credential });
    await live.host.adapterDiagnostics().record({ event: "desk.adapter.connection_status", adapterId: "balance", connectionId: live.connection.connectionId, state: "not-a-state" });

    await captureQuery(live, sinks, leaking, credential);
    paths.push("query");

    await captureDispatch(live, sinks, request => leaking === "receipt"
      ? ownerResultKit("balance").succeeded(requestParts(request), objectRef("balance", "task", "task-example"), { committed: true, ticket: credential }, AT)
      : ownerResult(request, "succeeded"));
    paths.push("dispatch:owner-result");

    await captureDraft(live, sinks, leaking, credential);
    paths.push("draft");

    const failed = await dispatchRigWith({ dir: join(options.root, "failed"), credential: CANARY });
    opened.push(failed);
    await captureDispatch(failed, sinks, request => ownerResultKit("balance").refused(request, "The owner refused because the destination is closed.", AT));
    paths.push("failure:owner-error");

    const covered = CANARY_SINKS.filter(sink => sinks[sink].some(entry => entry.length > 0));
    const missing = CANARY_SINKS.filter(sink => !covered.includes(sink));
    return {
      sinks,
      covered,
      missing,
      credentialHoldsCanary,
      credentialWritten,
      paths,
      entries: Object.fromEntries(CANARY_SINKS.map(sink => [sink, sinks[sink].length])) as Record<CanarySink, number>,
      close: teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

export async function runCanaryProbe(options: CanaryProbeOptions = {}): Promise<CanaryProbeResult> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "desk-adapter-canary-"));
  try {
    const stack = await openCanaryStack({ root: join(root, "stack"), leak: options.leak ?? null });
    try {
      const { sinks, ...rest } = stack;
      return { ...rest, findings: scanCanary(sinks) };
    } finally {
      await stack.close();
    }
  } finally {
    if (options.root === undefined) await rm(root, { recursive: true, force: true });
  }
}

export const canarySinkNames = (value: string): value is CanarySink => (CANARY_SINKS as readonly string[]).includes(value);
