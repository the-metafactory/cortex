import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { handleDeskFlows } from "../api/desk-flows";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import type { WriterRunner } from "../desk/create";
import { DESK_FLOWS_PATH, type SavedFlow } from "../../../conversations/saved-flow-contract";
import { DeskSavedFlows, SavedFlowRow } from "../dashboard-v2/components/desk-saved-flows";
import { DeskRoutineEditor } from "../dashboard-v2/components/desk-routine-editor";
import { defaultRoutinesLocation, readRoutinesLocation, routinesSearch } from "../dashboard-v2/hooks/use-routines-location";
import { loadSavedFlowDefinition, flowsShown, loadSavedFlows, routinePageTabs, type ShownFlowsState } from "../dashboard-v2/lib/desk-flows";
import { ApiFailure, type getJson } from "../dashboard-v2/lib/api";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { startServer } from "../server";

const runtime = { options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], flows: { pulse: ["pulse-on-stack", "--scope", "test"] } }, ledger: new HandledLedger() } satisfies DeskRuntime;
const hash = "a".repeat(64);
const older = { name: "F_OLDER", source: "saved", sha256: hash, provenance: { origin: "cli", conversation: null, saved_at: "2026-11-05T09:00:00Z" } };
const newer = { name: "F_NEWER", source: "saved", sha256: hash, provenance: { origin: "conversation", conversation: "conversation-example", saved_at: "2026-11-06T09:00:00Z" } };
const now = Date.parse("2026-11-06T10:00:00Z");
const request = (path = ""): Request => new Request(`http://localhost${DESK_FLOWS_PATH}${path}`);
const runner = (reply: unknown, code = 0): { calls: string[][]; run: WriterRunner } => {
  const calls: string[][] = [];
  return { calls, run: (argv, stdin, timeout) => { calls.push(argv); expect(stdin).toBe(""); expect(timeout).toBe(5000); return Promise.resolve({ code, stdout: JSON.stringify(reply), stderr: "" }); } };
};
const apiRead = (run: WriterRunner): typeof getJson => async <T,>(path: string): Promise<T> => {
  const response = await handleDeskFlows(new Request(`http://localhost${path}`), runtime, run);
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new ApiFailure({ status: response.status, message: body.error ?? "Read failed." });
  return body as T;
};

const shown = (state: Parameters<typeof flowsShown>[0]): ShownFlowsState => { if (!flowsShown(state)) throw new Error("flows are not shown"); return state; };

describe("Desk saved flows", () => {
  it("lists only saved flows newest first and renders names, saved dates and conversation provenance", async () => {
    const seam = runner({ status: "ok", flows: [older, { source: "arc", name: "F_ARC", sha256: null, provenance: null }, newer] });
    const response = await handleDeskFlows(request(), runtime, seam.run);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { flows: SavedFlow[] };
    expect(body.flows).toEqual([
      { name: newer.name, sha256: hash, savedAt: newer.provenance.saved_at, origin: "conversation", conversationId: "conversation-example" },
      { name: older.name, sha256: hash, savedAt: older.provenance.saved_at, origin: "cli", conversationId: null },
    ]);
    expect(seam.calls).toEqual([["pulse-on-stack", "--scope", "test", "flow", "list", "--saved", "--json"]]);
    const html = renderToStaticMarkup(<DeskSavedFlows state={{ status: "ready", flows: body.flows }} now={now} />);
    expect(html.indexOf("F_NEWER")).toBeLessThan(html.indexOf("F_OLDER"));
    expect(html).toContain("Saved 1h ago");
    expect(html).toContain("Saved 1d ago");
    expect(html).toContain('href="/conversations/conversation-example"');
    expect(html).toContain("From a conversation");
    expect(html).toContain("From the command line");
    expect(html).not.toContain("F_ARC");
    expect(html).toContain("Show definition");
    expect(html).not.toContain("Make a routine");
    expect(html).not.toContain("textarea");
  });

  it("loads the named saved flow and shows its YAML as read-only text", async () => {
    const yaml = "name: F_NEWER\nactions:\n  - return: '<example>'\n";
    const seam = runner({ name: newer.name, source: "saved", sha256: hash, yaml, path: "/private/owner/path" });
    const definition = await loadSavedFlowDefinition(newer.name, new AbortController().signal, apiRead(seam.run));
    expect(definition).toEqual({ name: newer.name, sha256: hash, yaml });
    expect(seam.calls).toEqual([["pulse-on-stack", "--scope", "test", "flow", "show", "F_NEWER", "--json"]]);
    const flow: SavedFlow = { name: newer.name, sha256: hash, savedAt: newer.provenance.saved_at, origin: "conversation", conversationId: "conversation-example" };
    const html = renderToStaticMarkup(<SavedFlowRow flow={flow} now={now} state={{ status: "ready", definition }} onToggle={() => undefined} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Hide definition");
    expect(html).toContain("&lt;example&gt;");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("/private/owner/path");
    expect(renderToStaticMarkup(<SavedFlowRow flow={flow} now={now} state={{ status: "error", error: "Pulse could not read the saved flows." }} onToggle={() => undefined} />)).toContain('role="alert"');
  });

  it("keeps unreadable owner replies as an error sentence rather than an empty library", async () => {
    for (const [reply, code] of [[{ status: "unreadable", reason: "/private/owner/path" }, 2], [{ status: "unreadable" }, 0], [{ status: "ok", flows: [] }, 1], [{ status: "ok", flows: [{ ...newer, sha256: null }] }, 0]] as const) {
      const seam = runner(reply, code);
      const state = await loadSavedFlows(new AbortController().signal, apiRead(seam.run));
      expect(state).toEqual({ status: "error", error: "Pulse could not read the saved flows." });
      const html = renderToStaticMarkup(<DeskSavedFlows state={shown(state)} />);
      expect(html).toContain('role="alert"');
      expect(html).toContain("Pulse could not read the saved flows.");
      expect(html).not.toContain("No saved flows yet");
      expect(html).not.toContain("/private/owner/path");
    }
    for (const run of [() => Promise.reject(new Error("timeout")), () => Promise.resolve({ code: 0, stdout: "invalid JSON", stderr: "" })] satisfies WriterRunner[]) {
      const response = await handleDeskFlows(request(), runtime, run);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "Pulse could not read the saved flows." });
    }
  });

  it("refuses decoded traversal, malformed encodings and invalid names before calling Pulse", async () => {
    const seam = runner({});
    for (const name of ["..%2Fx", "F_LOWERcase", "F_", `F_${"A".repeat(65)}`, "F_A%2FB", "F_A%5Cx", "F_A/extra", "%FF", "F_A%00", ""]) {
      expect((await handleDeskFlows(request(`/${name}`), runtime, seam.run)).status).toBe(400);
    }
    expect(seam.calls).toHaveLength(0);
    const valid = runner({ status: "not-found" }, 1);
    expect((await handleDeskFlows(request(`/F_${"A".repeat(64)}`), runtime, valid.run)).status).toBe(404);
    expect(valid.calls).toHaveLength(1);
  });

  it("reports missing saved definitions, excludes arc definitions and refuses mismatched readbacks", async () => {
    for (const [reply, code, status] of [
      [{ status: "not-found" }, 1, 404],
      [{ name: "F_NEWER", source: "arc", sha256: hash, yaml: "arc" }, 0, 404],
      [{ name: "F_OTHER", source: "saved", sha256: hash, yaml: "wrong" }, 0, 502],
      [{ status: "unreadable" }, 2, 502],
      [{ name: "F_NEWER", source: "saved", sha256: hash, yaml: "wrong" }, 2, 502],
    ] as const) {
      expect((await handleDeskFlows(request("/F_NEWER"), runtime, runner(reply, code).run)).status).toBe(status);
    }
  });

  it("renders the empty state only after a successful empty list", async () => {
    const state = await loadSavedFlows(new AbortController().signal, apiRead(runner({ status: "ok", flows: [] }).run));
    expect(renderToStaticMarkup(<DeskSavedFlows state={shown(state)} />)).toContain("No saved flows yet. Ask Ivy to make a flow in a conversation.");
  });

  it("returns 404 without configuration, hides the tab, and does not call Pulse", async () => {
    const seam = runner({});
    const unconfigured = { ...runtime, options: { ...runtime.options, flows: undefined } };
    for (const path of ["", "/F_NEWER"]) {
      const response = await handleDeskFlows(request(path), unconfigured, seam.run);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Saved flows are not configured on this stack." });
    }
    expect((await handleDeskFlows(request(), { ...runtime, options: { ...runtime.options, enabled: false } }, seam.run)).status).toBe(404);
    expect(seam.calls).toHaveLength(0);
    const read: typeof getJson = () => Promise.reject(new ApiFailure({ status: 404, message: "Saved flows are not configured on this stack." }));
    const state = await loadSavedFlows(new AbortController().signal, read);
    expect(state).toEqual({ status: "unconfigured" });
    expect(routinePageTabs(state)).toEqual({ flowsAvailable: false, tabs: ["schedule", "workspace"] });
    const html = renderToStaticMarkup(<DeskRoutineEditor onBack={() => undefined} location={{ ...defaultRoutinesLocation(), tab: "flows" }} />);
    expect(html).not.toContain('id="routines-tab-flows"');
    expect(html).toContain('id="routines-tab-schedule"');
  });

  it("offers the Saved flows tab only when flows are ready or failed", () => {
    expect(routinePageTabs({ status: "checking" }).tabs).toEqual(["schedule", "workspace"]);
    expect(routinePageTabs({ status: "unconfigured" }).tabs).toEqual(["schedule", "workspace"]);
    expect(routinePageTabs({ status: "ready", flows: [] }).tabs).toEqual(["schedule", "workspace", "flows"]);
    expect(routinePageTabs({ status: "error", error: "x" }).tabs).toEqual(["schedule", "workspace", "flows"]);
  });

  it("shows a readable sentence, not parser output, when the response body is malformed", async () => {
    const state = await loadSavedFlows(new AbortController().signal, (() => Promise.resolve({ flows: "nope" })) as typeof getJson);
    expect(state).toEqual({ status: "error", error: "Mission Control could not read the saved flows." });
  });

  it("round trips the flows tab without losing the existing routine workspace", () => {
    const location = { ...defaultRoutinesLocation(), tab: "flows" as const, workspace: "flow" as const, routine: "example" };
    expect(readRoutinesLocation(routinesSearch("?api=local", location))).toEqual(location);
  });

  it("only permits GET and gates both routes by Mission Control identity", async () => {
    const seam = runner({});
    const response = await handleDeskFlows(new Request(request().url, { method: "POST" }), runtime, seam.run);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(seam.calls).toHaveLength(0);
    const db = initDatabase(":memory:");
    const context = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"] } }, db, { desk: { ...runtime.options, flows: undefined } });
    try {
      for (const path of [DESK_FLOWS_PATH, `${DESK_FLOWS_PATH}/F_NEWER`]) {
        const url = `http://localhost:${context.server.port}${path}`;
        expect((await fetch(url, { headers: { "Cf-Access-Authenticated-User-Email": "stranger@example.com" } })).status).toBe(403);
        expect((await fetch(url, { headers: { "Cf-Access-Authenticated-User-Email": "principal@example.com", Origin: "https://evil.example" } })).status).toBe(403);
        expect((await fetch(url, { headers: { "Cf-Access-Authenticated-User-Email": "principal@example.com", Host: "evil.example" } })).status).toBe(403);
        const accepted = await fetch(url, { headers: { "Cf-Access-Authenticated-User-Email": "principal@example.com" } });
        expect(accepted.status).toBe(404);
        expect(await accepted.json()).toEqual({ error: "Saved flows are not configured on this stack." });
      }
    } finally { context.stop(true); db.close(); }
  });
});
