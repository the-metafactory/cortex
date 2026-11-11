import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FLOW_NAME, flowPulseRunner, flowYaml, openFlowReadRig, type FlowReadRig } from "../../../conversations/domain-adapters/__tests__/fixtures/flow-read-fixtures";
import { flowSaveReceipt } from "../../../conversations/domain-adapters/flow/save-binding";
import { flowSaveRequest, openFlowSaveRig, type FlowSaveRig } from "../../../conversations/domain-adapters/__tests__/fixtures/flow-save-fixtures";
import { handleDeskFlows } from "../api/desk-flows";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import type { WriterRunner } from "../desk/create";
import { FLOW_CARD_PATH, flowCardPath, type FlowReceipt } from "../desk/flow-surface-schema";
import { createFlowSurfaceReader, flowSurfaceQueries, type FlowSurfaceReader } from "../desk/flow-surfaces";
import { DESK_FLOWS_PATH, type SavedFlow } from "../desk/saved-flow-contract";
import { SavedFlowCard } from "../dashboard-v2/components/desk-conversation-saved-flow";
import { DeskSavedFlows } from "../dashboard-v2/components/desk-saved-flows";
import { loadSavedFlows } from "../dashboard-v2/lib/desk-flows";

const opened: FlowReadRig[] = [];
const saved: FlowSaveRig[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(rig => rig.close()));
  await Promise.all(saved.splice(0).map(rig => rig.close()));
});

const NOW = Date.parse("2026-11-11T10:00:00Z");
const runtime = (pulse: string[]): DeskRuntime => ({ options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], flows: { pulse } }, ledger: new HandledLedger() });
const noFlows: DeskRuntime = { options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [] }, ledger: new HandledLedger() };

interface Desk { readonly desk: DeskRuntime; readonly legacyRun: WriterRunner }
interface TabStack extends Desk { readonly rig: FlowReadRig; readonly reader: (on?: boolean) => FlowSurfaceReader; readonly receipts: Map<string, FlowReceipt> }

async function openTab(options: { enabled?: boolean; conversationPolicy?: "local" | "cloud" } = {}): Promise<TabStack> {
  const rig = await openFlowReadRig({ ...(options.conversationPolicy ? { conversationPolicy: options.conversationPolicy } : {}) });
  opened.push(rig);
  const receipts = new Map<string, FlowReceipt>();
  const reader = (on = options.enabled ?? true): FlowSurfaceReader => createFlowSurfaceReader({
    connectionId: rig.source.connectionId,
    destination: rig.adapter.destination,
    enabled: () => on,
    ...flowSurfaceQueries({ connectionId: rig.source.connectionId, destination: rig.adapter.destination, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink }),
    receipt: id => Promise.resolve(receipts.get(id) ?? null),
  });
  return { rig, reader, receipts, legacyRun: flowPulseRunner({ flowsDir: rig.flowsDir, env: rig.env }), desk: runtime([rig.source.binary]) };
}

const noRun: WriterRunner = () => Promise.reject(new Error("this probe desk runs no Pulse command"));
const bare: Desk = { desk: noFlows, legacyRun: noRun };
const get = (path: string, desk: Desk, access?: () => FlowSurfaceReader | null, method = "GET"): Promise<Response> =>
  handleDeskFlows(new Request(`http://127.0.0.1:8767${path}`, { method }), desk.desk, desk.legacyRun, access);

describe("the saved Flows tab reads through the adapter", () => {
  test("the list is the same answer Pulse gives today, with provenance and the same visible page", async () => {
    const stack = await openTab();
    await stack.rig.save();
    await stack.rig.save("F_SECOND_EXAMPLE", flowYaml("F_SECOND_EXAMPLE"));
    const legacy: unknown = await (await get(DESK_FLOWS_PATH, stack)).json();
    const surface: unknown = await (await get(DESK_FLOWS_PATH, stack, () => stack.reader())).json();
    expect(surface).toEqual(legacy);
    const flows = (surface as { flows: SavedFlow[] }).flows;
    expect(flows.map(flow => flow.name).sort()).toEqual(["F_SAVED_EXAMPLE", "F_SECOND_EXAMPLE"]);
    expect(flows.every(flow => /^[0-9a-f]{64}$/.test(flow.sha256))).toBe(true);
    expect(flows.every(flow => flow.origin === "conversation" && flow.conversationId === "conversation-example")).toBe(true);
    expect(renderToStaticMarkup(<DeskSavedFlows state={{ status: "ready", flows }} now={NOW} />)).toBe(renderToStaticMarkup(<DeskSavedFlows state={{ status: "ready", flows: (legacy as { flows: SavedFlow[] }).flows }} now={NOW} />));
  });

  test("the routine target the tab offers survives the adapter list", async () => {
    const stack = await openTab();
    await stack.rig.save();
    const routines = { reflex: ["reflex"], composer: ["compose"], target: "@test/pulse-flow", timeZone: "UTC", timeoutSeconds: 10, composeTimeoutSeconds: 10, readTimeoutSeconds: 1 };
    const desk: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], flows: { pulse: [stack.rig.source.binary] }, routines } };
    const legacy: unknown = await (await get(DESK_FLOWS_PATH, { desk, legacyRun: stack.legacyRun })).json();
    const surface: unknown = await (await get(DESK_FLOWS_PATH, { desk, legacyRun: stack.legacyRun }, () => stack.reader())).json();
    expect(surface).toEqual(legacy);
    expect(surface).toMatchObject({ routine: { target: "@test/pulse-flow", timeZone: "UTC" } });
  });

  test("the expanded definition is the YAML Pulse shows, and a missing one keeps today's 404", async () => {
    const stack = await openTab();
    await stack.rig.save();
    const shown = await stack.rig.pulse(["show", FLOW_NAME]);
    const legacy: unknown = await (await get(`${DESK_FLOWS_PATH}/${FLOW_NAME}`, stack)).json();
    const surface: unknown = await (await get(`${DESK_FLOWS_PATH}/${FLOW_NAME}`, stack, () => stack.reader())).json();
    expect(surface).toEqual(legacy);
    expect(surface).toEqual({ name: FLOW_NAME, sha256: shown.sha256 ?? "", yaml: shown.yaml ?? "" });
    const missing = await get(`${DESK_FLOWS_PATH}/F_NOT_SAVED`, stack, () => stack.reader());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "This saved flow was not found." });
  });

  test("the connection being off answers exactly as the current path does", async () => {
    const stack = await openTab();
    await stack.rig.save();
    const before = stack.rig.rig.calls.read;
    expect(await (await get(DESK_FLOWS_PATH, stack, () => stack.reader(false))).json()).toEqual(await (await get(DESK_FLOWS_PATH, stack)).json());
    expect(await (await get(`${DESK_FLOWS_PATH}/${FLOW_NAME}`, stack, () => stack.reader(false))).json()).toEqual(await (await get(`${DESK_FLOWS_PATH}/${FLOW_NAME}`, stack)).json());
    expect(stack.rig.rig.calls.read).toBe(before);
  });

  test("an unreadable adapter answer is the existing error, never an empty library", async () => {
    const broken = createFlowSurfaceReader({
      connectionId: "connection-example",
      destination: { adapterId: "flow", connectionId: "connection-example", objectType: "stack", canonicalId: "stack-example" },
      enabled: () => true,
      query: () => Promise.reject(new Error("Pulse is not answering.")),
      read: () => Promise.reject(new Error("Pulse is not answering.")),
    });
    for (const path of [DESK_FLOWS_PATH, `${DESK_FLOWS_PATH}/${FLOW_NAME}`]) {
      const response = await get(path, bare, () => broken);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "Pulse could not read the saved flows." });
    }
  });

  test("a connection that may not read answers with the denial instead of an empty list", async () => {
    const stack = await openTab({ conversationPolicy: "cloud" });
    await stack.rig.save();
    expect((await get(DESK_FLOWS_PATH, stack, () => stack.reader())).status).toBe(502);
    expect((await get(`${DESK_FLOWS_PATH}/${FLOW_NAME}`, stack, () => stack.reader())).status).toBe(403);
  });

  test("saved flows stay unread while the connection is off, and archived arc Flows are never listed", async () => {
    const stack = await openTab();
    await stack.rig.save();
    const off = await stack.reader(false).list();
    expect(off).toEqual({ enabled: false });
    expect(await stack.reader(false).definition(FLOW_NAME)).toEqual({ enabled: false });
    expect(stack.rig.rig.calls.read).toBe(0);
    const listed = await stack.reader().list();
    expect(listed).toMatchObject({ enabled: true });
    if (!listed.enabled) throw new Error("the adapter list was off");
    expect(listed.flows.map(flow => flow.name)).toEqual([FLOW_NAME]);
  });

  test("the tab loader keeps reading the same route", async () => {
    const paths: string[] = [];
    await loadSavedFlows(new AbortController().signal, <T,>(path: string): Promise<T> => { paths.push(path); return Promise.resolve({ flows: [] } as T); });
    expect(paths).toEqual([DESK_FLOWS_PATH]);
  });
});

describe("the saved Flow card keeps the receipt", () => {
  test("a deleted Flow reads as unavailable while its receipt stands", async () => {
    const stack = await openTab();
    await stack.rig.save();
    const shown = await stack.rig.pulse(["show", FLOW_NAME]);
    stack.receipts.set("operation-example", { name: FLOW_NAME, sha256: String(shown.sha256) });
    expect(await stack.reader().card(FLOW_NAME, "operation-example")).toMatchObject({ enabled: true, state: "available", changed: false, name: FLOW_NAME, sha256: shown.sha256 });
    await stack.rig.pulse(["delete", FLOW_NAME, "--expected-sha256", String(shown.sha256)]);
    const card = await stack.reader().card(FLOW_NAME, "operation-example");
    expect(card).toEqual({ enabled: true, state: "unavailable", receipt: { name: FLOW_NAME, sha256: String(shown.sha256) } });
    expect((await get(`${DESK_FLOWS_PATH}/${FLOW_NAME}`, stack, () => stack.reader())).status).toBe(404);
    const response = await get(flowCardPath(FLOW_NAME, "operation-example"), stack, () => stack.reader());
    expect(await response.json()).toEqual(card);
    expect(renderToStaticMarkup(<SavedFlowCard reading={{ kind: "ready", card: card as Extract<typeof card, { enabled: true }> }} />)).toContain("no longer available");
  });

  test("different content under the same name shows that the current sha256 differs from the receipt", async () => {
    const stack = await openTab();
    await stack.rig.save();
    const first = await stack.rig.pulse(["show", FLOW_NAME]);
    stack.receipts.set("operation-first", { name: FLOW_NAME, sha256: String(first.sha256) });
    await stack.rig.pulse(["delete", FLOW_NAME, "--expected-sha256", String(first.sha256)]);
    await stack.rig.save(FLOW_NAME, `${flowYaml(FLOW_NAME)}description: Changed after the receipt\n`);
    const second = await stack.rig.pulse(["show", FLOW_NAME]);
    expect(second.sha256).not.toEqual(first.sha256);
    const card = await stack.reader().card(FLOW_NAME, "operation-first");
    expect(card).toMatchObject({ enabled: true, state: "available", changed: true, sha256: second.sha256, receipt: { name: FLOW_NAME, sha256: first.sha256 } });
    const html = renderToStaticMarkup(<SavedFlowCard reading={{ kind: "ready", card: card as Extract<typeof card, { enabled: true }> }} />);
    expect(html).toContain("differs from the receipt");
    expect(html).toContain(String(first.sha256).slice(0, 12));
    expect(html).toContain(String(second.sha256).slice(0, 12));
  });

  test("a card without a journal receipt shows nothing, and the connection being off shows nothing", async () => {
    const stack = await openTab();
    await stack.rig.save();
    expect(await stack.reader().card(FLOW_NAME, "operation-unknown")).toEqual({ enabled: true, state: "unrecorded" });
    expect(await stack.reader(false).card(FLOW_NAME, "operation-unknown")).toEqual({ enabled: false });
    expect(renderToStaticMarkup(<SavedFlowCard reading={{ kind: "ready", card: { enabled: true, state: "unrecorded" } }} />)).toBe("");
    expect(renderToStaticMarkup(<SavedFlowCard reading={{ kind: "waiting" }} />)).toBe("");
    expect(await (await get(FLOW_CARD_PATH, stack)).json()).toEqual({ enabled: false });
    expect(await (await get(flowCardPath(FLOW_NAME, "operation-unknown"), stack, () => stack.reader(false))).json()).toEqual({ enabled: false });
    expect((await get(FLOW_CARD_PATH, stack, () => stack.reader())).status).toBe(400);
    expect((await get(flowCardPath(FLOW_NAME, ""), stack, () => stack.reader())).status).toBe(400);
    expect((await get(flowCardPath("not-a-flow", "operation-first"), stack, () => stack.reader())).status).toBe(400);
    expect((await get(flowCardPath(FLOW_NAME, "operation-first"), stack, () => stack.reader(), "POST")).status).toBe(405);
  });

  test("the receipt comes from the journal record of the Flow save, and only for this connection", async () => {
    const rig = await openFlowSaveRig();
    saved.push(rig);
    expect(await flowSaveReceipt(rig.journal, { operationId: flowSaveRequest().operationId, connectionId: "connection-example" })).toBe(null);
    await rig.create();
    const shown = JSON.parse((await rig.command(["show", "F_SAVE_EXAMPLE"])).stdout) as { name: string; sha256: string };
    expect(await flowSaveReceipt(rig.journal, { operationId: flowSaveRequest().operationId, connectionId: "connection-other" })).toBe(null);
    expect(await flowSaveReceipt(rig.journal, { operationId: "conversation-example:unknown:1", connectionId: "connection-example" })).toBe(null);
    expect(await flowSaveReceipt(rig.journal, { operationId: flowSaveRequest().operationId, connectionId: "connection-example" })).toEqual({ name: shown.name, sha256: shown.sha256 });
  });

  test("the card renders the receipt for the states that carry one", () => {
    const receipt = { name: FLOW_NAME, sha256: "a".repeat(64) };
    const changed = renderToStaticMarkup(<SavedFlowCard reading={{ kind: "ready", card: { enabled: true, state: "available", receipt, changed: true, name: FLOW_NAME, sha256: "b".repeat(64), savedAt: "2026-11-11T09:00:00Z", origin: "conversation", conversationId: "conversation-example" } }} now={NOW} />);
    expect(changed).toContain("Changed since the receipt");
    expect(changed).toContain("Saved 1h ago");
    expect(changed).toContain("from a conversation");
    const same = renderToStaticMarkup(<SavedFlowCard reading={{ kind: "ready", card: { enabled: true, state: "available", receipt, changed: false, name: FLOW_NAME, sha256: "a".repeat(64), savedAt: "2026-11-11T09:00:00Z", origin: "cli", conversationId: null } }} now={NOW} />);
    expect(same).toContain("still matches the receipt");
    expect(same).toContain("from the command line");
    expect(renderToStaticMarkup(<SavedFlowCard reading={{ kind: "ready", card: { enabled: true, state: "withheld", receipt } }} />)).toContain("Content withheld");
    expect(renderToStaticMarkup(<SavedFlowCard reading={{ kind: "failed" }} />)).toContain("could not be read");
  });
});
