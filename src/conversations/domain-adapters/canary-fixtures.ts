import { join } from "node:path";
import { enableConnection, connectionSetupRig, listConnections, type ConnectionSetupRig } from "../connection-setup-fixtures";
import { ownerResultKit } from "./operations/owner-results";
import { receiptStatus } from "./operations/reconciliation";
import { dispatchRig, ownerResult } from "./operations/dispatch-fixtures";
import { AT } from "./operations/fixtures";
import { balanceBinding, balanceResponse, draftingRegistry, draftingState, graphBinding } from "./drafting-fixtures";
import { DraftingBindings } from "./drafting";
import { queryArea, queryBinding, queryRegistry, syntheticQueryPage } from "./reads/query-fixtures";
import type { QuerySource } from "./reads/query-types";
import { DESK_CONNECTIONS_PATH } from "../../surface/mc/api/desk-connections";

export const CANARY = "desk-canary-51e2a7b9c4d1";

export const CANARY_SINKS = ["log", "event", "receipt", "ui", "model"] as const;
export type CanarySink = (typeof CANARY_SINKS)[number];
export type CanarySinks = Record<CanarySink, string[]>;

export const CANARY_PATHS = ["query", "dispatch:owner-result", "draft", "failure:owner-error"] as const;
export type CanaryPath = (typeof CANARY_PATHS)[number];

export const emptyCanarySinks = (): CanarySinks => ({ log: [], event: [], receipt: [], ui: [], model: [] });

const rendered = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);

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

export interface CanaryStack {
  readonly sinks: CanarySinks;
  readonly covered: CanarySink[];
  readonly missing: CanarySink[];
  readonly credentialHoldsCanary: boolean;
  readonly credentialWritten: boolean;
  readonly paths: CanaryPath[];
  readonly entries: Record<CanarySink, number>;
  close(): Promise<void>;
}

export interface CanaryStackOptions {
  root: string;
  leak?: CanarySink | null;
}

const eventText = (events: readonly object[]): string[] => events.map(event => rendered(event));

export async function openCanaryStack(options: CanaryStackOptions): Promise<CanaryStack> {
  const leak = options.leak ?? null;
  const log = captureLog();
  const sinks: CanarySinks = { ...emptyCanarySinks(), log: log.lines };
  const opened: { close(): Promise<void> }[] = [];
  const paths: CanaryPath[] = [];
  const leakCredential = (): void => {
    if (leak === "log") console.error(`desk-adapter-fixture: resolving credential ${CANARY}`);
    else if (leak !== null) sinks[leak].push(CANARY);
  };
  try {
    const setup: ConnectionSetupRig = await connectionSetupRig({ dir: join(options.root, "setup") });
    opened.push(setup);
    const connection = await enableConnection(setup, { primary: { token: CANARY }, backup: { reference: "EXAMPLE_API_KEY" } });
    sinks.ui.push(rendered(connection));
    const settings = await setup.http("local", "GET", DESK_CONNECTIONS_PATH, undefined);
    sinks.ui.push(settings.text);
    const missingConnection = await setup.http("local", "POST", `${DESK_CONNECTIONS_PATH}/00000000-0000-4000-8000-000000000000/enable`, { expectedRevision: 1 });
    sinks.ui.push(missingConnection.text);
    for (const view of await listConnections(setup)) sinks.event.push(...eventText(await setup.host().adapterDiagnostics().events(view.connectionId)));

    const live = await dispatchRig(30_000, undefined, () => new Date(AT), undefined, { dir: join(options.root, "live"), credential: CANARY, readSetup: { registry: queryRegistry(), binding: queryBinding } });
    opened.push(live);
    const secrets = live.secrets;
    const credentialWritten = secrets !== null && live.credential !== null;
    const credentialHoldsCanary = secrets !== null && live.credential !== null && await secrets.matches(live.secretIdentity, CANARY);

    const queries = live.host.readQueries(live.registry, live.bindings);
    live.hooks.query = () => {
      leakCredential();
      return Promise.resolve(syntheticQueryPage());
    };
    const source: QuerySource = { adapterId: "balance", connectionId: live.connection.connectionId, capabilityId: queryBinding.capabilityId, inputSchemaRef: queryBinding.inputSchemaRef, destinations: [queryArea], input: { area: queryArea, title: "synthetic canary query" } };
    const request = await queries.create(live.context, [source], live.sink);
    const queried = await queries.run(live.context, request, live.sink);
    paths.push("query");
    sinks.ui.push(rendered(queried));
    for (const released of live.calls.sends) sinks.ui.push(rendered(released));

    live.hooks.dispatch = dispatchRequest => Promise.resolve(ownerResult(dispatchRequest, "succeeded"));
    await live.prepare();
    await live.activate();
    await live.dispatch();
    paths.push("dispatch:owner-result");
    const stored = await live.events();
    sinks.receipt.push(rendered(stored));
    if (stored) {
      sinks.receipt.push(rendered(receiptStatus(stored)));
      sinks.receipt.push(rendered(ownerResultKit("balance").legacyResult(stored, "task")));
    }
    sinks.event.push(...eventText(await live.host.adapterDiagnostics().events(live.connection.connectionId)));

    const drafting = draftingRegistry();
    const bindings = new DraftingBindings(drafting.registry);
    for (const binding of [balanceBinding(), graphBinding()]) {
      const registered = bindings.register(binding);
      if (!registered.ok) throw new Error(registered.error.code);
    }
    const draft = draftingState();
    draft.state.response = () => balanceResponse();
    const drafts = live.host.drafts({ registry: drafting.registry, bindings, sources: draft.sources, policy: draft.policy, model: draft.model, destinations: draft.destinations, now: () => new Date(AT) });
    await drafts.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: live.connection.connectionId });
    paths.push("draft");
    sinks.model.push(...draft.state.requests.map(rendered));

    const failed = await dispatchRig(30_000, undefined, () => new Date(AT), undefined, { dir: join(options.root, "failed"), credential: CANARY });
    opened.push(failed);
    failed.hooks.dispatch = dispatchRequest => Promise.resolve(ownerResultKit("balance").refused(dispatchRequest, "The owner refused because the destination is closed.", AT));
    await failed.prepare();
    await failed.activate();
    await failed.dispatch();
    paths.push("failure:owner-error");
    const refused = await failed.events();
    sinks.receipt.push(rendered(refused));
    if (refused) sinks.receipt.push(rendered(ownerResultKit("balance").legacyResult(refused, "task")));
    sinks.event.push(...eventText(await failed.host.adapterDiagnostics().events(failed.connection.connectionId)));

    console.error("desk-adapter-canary: log capture is active");
    const covered = CANARY_SINKS.filter(sink => sinks[sink].some(entry => entry.length > 0));
    const missing = CANARY_SINKS.filter(sink => !covered.includes(sink));
    const result: CanaryStack = {
      sinks,
      covered,
      missing,
      credentialHoldsCanary,
      credentialWritten,
      paths,
      entries: Object.fromEntries(CANARY_SINKS.map(sink => [sink, sinks[sink].length])) as Record<CanarySink, number>,
      async close() {
        for (const item of opened.reverse()) await item.close();
        log.restore();
      },
    };
    return result;
  } catch (error) {
    for (const item of opened.reverse()) await item.close();
    log.restore();
    throw error;
  }
}
