import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleGetDesk } from "../api/desk";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import type { RangerState } from "../desk/sources/ranger";
import type { WaitingTask } from "../desk/sources/waiting";
import type { DeskView } from "../desk/types";
import { DEFAULT_CONFIG } from "../config";
import { startServer } from "../server";

const DESK: DeskOptions = {
  enabled: true, displayName: "", topN: 5, sources: [], rangerUrl: "",
  areas: [{ id: "work", label: "Work", color: "", repos: ["example/area"], goals: [] }],
  conversationProjects: [{ forge: { kind: "github", host: "github.example.test", repo: "example/project" } }, { forge: { kind: "gitlab", host: "lab.example.test", repo: "group/widget" } }],
};

describe("GET /api/desk mentions", () => {
  let db: Database;
  let ranger: ReturnType<typeof Bun.serve>;
  let server: ReturnType<typeof Bun.serve>;
  let state: RangerState;
  let runtime: DeskRuntime;
  beforeEach(() => {
    db = initDatabase(":memory:");
    state = { current: [], needsYou: [], maps: [{ key: "map", repo: "example/map" }] };
    ranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(state) });
    runtime = { options: { ...DESK, rangerUrl: ranger.url.origin }, ledger: new HandledLedger() };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/api/desk" ? handleGetDesk(db, runtime, undefined) : new Response(null, { status: 404 }) });
  });
  afterEach(async () => { await server.stop(true); await ranger.stop(true); db.close(); });
  const read = async (): Promise<DeskView> => {
    const response = await fetch(new URL("/api/desk", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return await response.json() as DeskView;
  };

  it("serves one blocked Ranger item per reference form using all stack repository sources", async () => {
    const references = ["other/exporter#11", "area#12", "project#13", "map#14", "#15", "node 16", "node #17", "widget#18"];
    state.needsYou = references.map((text, i) => ({ key: "map", repo: "example/app", nodeId: String(i + 1), title: `Waiting ${i}`, status: "blocked", reason: { class: "blocked", detail: `The adapter needs ${text}.` } }));
    const view = await read();
    expect(view.items).toHaveLength(references.length);
    expect(view.items.map(row => row.mentions)).toEqual([
      [{ text: "other/exporter#11", url: "https://github.com/other/exporter/issues/11" }],
      [{ text: "area#12", url: "https://github.com/example/area/issues/12" }],
      [{ text: "project#13", url: "https://github.example.test/example/project/issues/13" }],
      [{ text: "map#14", url: "https://github.com/example/map/issues/14" }],
      [{ text: "#15", url: "https://github.com/example/app/issues/15" }],
      [{ text: "node 16", url: "https://github.com/example/app/issues/16" }],
      [{ text: "node #17", url: "https://github.com/example/app/issues/17" }],
      [{ text: "widget#18", url: "https://lab.example.test/group/widget/-/issues/18" }],
    ]);
    expect(view.items[0]).toMatchObject({ title: '"Waiting 0" waits for your ruling.', question: { condition: null, reason: "The adapter needs other/exporter#11." }, detail: { summary: "blocked: The adapter needs other/exporter#11.", refs: ["example/app#1", "map"] } });
    expect(Object.keys(view.items[0]?.mentions?.[0] ?? {}).sort()).toEqual(["text", "url"]);
  });

  it("reads the final waiting-task title and reason and omits unresolved mentions", async () => {
    state.needsYou = [
      { key: "map", repo: "example/app", nodeId: "1", title: "Old title", status: "blocked", reason: { class: "blocked" } },
      { key: "map", repo: "example/app", nodeId: "2", title: "Unknown missing#3", status: "blocked", reason: { class: "blocked", detail: "No decision yet." } },
    ];
    runtime.waitingTasks = { read: async () => new Map<string, WaitingTask>([["example/app#1", { kind: "open", title: "Wait for area#20", question: "Needs project#21", url: "https://github.com/example/app/pull/1" }]]) };
    const view = await read();
    expect(view.items[0]?.mentions).toEqual([
      { text: "area#20", url: "https://github.com/example/area/issues/20" },
      { text: "project#21", url: "https://github.example.test/example/project/issues/21" },
    ]);
    expect(view.items[1]).not.toHaveProperty("mentions");
  });

  it("curl serves a blocked Ranger cross-repository mention through the running MC stack", async () => {
    state.needsYou = [{ key: "map", repo: "gitlab:forge.example.test/group/app", nodeId: "1", title: "Choose the adapter", status: "blocked", reason: { class: "blocked", detail: "The adapter needs project#11." } }];
    const stack = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { desk: runtime.options });
    try {
      const curl = Bun.spawn(["curl", "--silent", "--show-error", "--fail-with-body", "-i", `http://127.0.0.1:${stack.port}/api/desk`], { stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(curl.stdout).text(), new Response(curl.stderr).text(), curl.exited]);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      const [headers, body] = output.split("\r\n\r\n");
      expect(headers).toContain("200 OK");
      const view = JSON.parse(body ?? "null") as DeskView;
      expect(view.items[0]).toMatchObject({ kind: "agent-blocked", question: { reason: "The adapter needs project#11." }, mentions: [{ text: "project#11", url: "https://github.example.test/example/project/issues/11" }] });
      console.log(JSON.stringify({ probe: "curl /api/desk", status: 200, mentions: view.items[0]?.mentions, temporaryStackOnly: true }));
    } finally { stack.stop(true); }
  });
});
