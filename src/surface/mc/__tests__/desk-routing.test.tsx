import { z } from "zod";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { handleDeskAsk, handleDeskCreate } from "../api/desk-ask";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { setGrant } from "../desk/autonomy";
import { listOpenNotes } from "../desk/notes";
import { parserRoutingNotice, parserUnavailable, type SelectedParserRouting } from "../desk/parser-routing";
import { askDesk, createFromProposal } from "../dashboard-v2/lib/desk-ask";
import { ProposalCard } from "../dashboard-v2/components/desk-proposal";
import { McSchema } from "../../../common/types/config";

const selection = (provider: "codex" | "pi", unavailable: "capped" | "missing-reading" | "stale-reading" = "capped"): SelectedParserRouting => ({
  version: 1, kind: "selected", provider, reason: provider === "pi" ? "pi-fallback" : "most-headroom",
  attempted: [provider],
  candidates: [{ substrate: "claude", reason: unavailable }, { substrate: "codex", reason: provider === "codex" ? "eligible" : unavailable }, { substrate: "pi", reason: provider === "pi" ? "eligible" : "not-permitted" }],
  fallbackReasons: [], capabilityExclusions: [],
});

const runtime = (): DeskRuntime => ({
  ledger: new HandledLedger(),
  options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "private", label: "Private", color: "", repos: [], goals: [], policy: "local" }], sources: [], ask: { parser: ["parser"], routing: { permitted: ["claude", "codex", "pi"] }, timeoutSeconds: 5, writers: {}, taskMaps: [] } },
});
const request = (body: unknown) => new Request("http://mc/api/desk/ask", { method: "POST", body: JSON.stringify(body) });

describe("routed command bar", () => {
  for (const provider of ["codex", "pi"] as const) {
    it(`shows ${provider} and its reason without creating until confirmation`, async () => {
      const db = initDatabase(":memory:");
      try {
        const desk = runtime();
        const paths: string[] = [];
        const routing = selection(provider);
        const fetcher = async (path: string, init: RequestInit) => {
          paths.push(path);
          const req = new Request(`http://mc${path}`, init);
          return path === "/api/desk/create" ? handleDeskCreate(req, db, desk) : handleDeskAsk(req, desk, { runParser: () => Promise.resolve(JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing })) }, db);
        };
        const answer = await askDesk("note Probe", fetcher);
        expect(answer.ok).toBe(true);
        if (!answer.ok) throw new Error(answer.text);
        expect(answer.proposal.routing).toEqual(routing);
        expect(answer.proposal.automatic).toBeUndefined();
        const html = renderToStaticMarkup(<ProposalCard proposal={answer.proposal} said="note Probe" maps={[]} now={Date.now()} busy={false} onConfirm={() => undefined} onCancel={() => undefined} onGoto={() => undefined} onFieldsChange={() => undefined} />);
        expect(html).toContain(`Answered by ${provider === "pi" ? "Pi" : "Codex"}.`);
        expect(html).toContain("Claude has reached its usage limit");
        expect(html).toContain("Nothing happens until you confirm.");
        expect(paths).toEqual(["/api/desk/ask"]);
        expect(listOpenNotes(db)).toHaveLength(0);
        expect((await createFromProposal("routing-probe-001", "note", answer.proposal.fields, fetcher)).ok).toBe(true);
        expect((await createFromProposal("routing-probe-001", "note", answer.proposal.fields, fetcher)).ok).toBe(false);
        expect(listOpenNotes(db)).toHaveLength(1);
      } finally { db.close(); }
    });
  }

  for (const reading of ["missing-reading", "stale-reading"] as const) {
    it(`preserves Ranger's ${reading} reason without choosing a provider itself`, async () => {
      const res = await handleDeskAsk(request({ text: "note Probe" }), runtime(), { runParser: () => Promise.resolve(JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing: selection("pi", reading) })) });
      const answer: unknown = await res.json();
      expect(answer).toMatchObject({ proposal: { routing: { candidates: [{ substrate: "claude", reason: reading }, { substrate: "codex", reason: reading }, { substrate: "pi", reason: "eligible" }] } } });
    });
  }

  it("retains dispatch-time quota fallback evidence", async () => {
    const routing = { ...selection("codex"), attempted: ["claude", "codex"], fallbackReasons: [{ provider: "claude", reason: "quota-exhausted" }] };
    const res = await handleDeskAsk(request({ text: "note Probe" }), runtime(), { runParser: () => Promise.resolve(JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing })) });
    expect(await res.json()).toMatchObject({ proposal: { routing } });
  });

  it("explains unavailable in the command-bar result and never dispatches create", async () => {
    const routing = { ...parserUnavailable("no-eligible-substrate"), candidates: selection("pi").candidates.map((c) => ({ ...c, reason: "not-permitted" })) };
    const paths: string[] = [];
    const answer = await askDesk("note Probe", async (path, init) => {
      paths.push(path);
      return handleDeskAsk(new Request(`http://mc${path}`, init), runtime(), { runParser: () => Promise.resolve(JSON.stringify({ kind: "none", reason: "Parser unavailable", routing })) });
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("expected unavailable");
    expect(answer.text).toContain("No permitted provider is available");
    expect(paths).toEqual(["/api/desk/ask"]);
  });

  it("intersects request, configured and local area permissions before parsing", async () => {
    let calls = 0;
    const res = await handleDeskAsk(request({ text: "note Probe", area: "private", routing: { permitted: ["claude", "pi"] } }), runtime(), { runParser: (_argv, stdin) => {
      calls++;
      expect(z.object({ routing: z.object({ permitted: z.array(z.string()) }) }).parse(JSON.parse(stdin)).routing).toEqual({ permitted: ["pi"] });
      return Promise.resolve(JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing: selection("pi") }));
    } });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("sends the selected area from the browser", async () => {
    await askDesk("note Probe", (_path, init) => {
      expect(JSON.parse(z.string().parse(init.body))).toEqual({ text: "note Probe", area: "private" });
      return Promise.resolve(Response.json({ error: "No provider" }, { status: 503 }));
    }, "private");
  });

  it("forwards empty permissions and refuses providers outside them", async () => {
    const res = await handleDeskAsk(request({ text: "note Probe", routing: { permitted: [] } }), runtime(), { runParser: (_argv, stdin) => {
      expect(z.object({ routing: z.object({ permitted: z.array(z.string()) }) }).parse(JSON.parse(stdin)).routing).toEqual({ permitted: [] });
      return Promise.resolve(JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing: selection("codex") }));
    } });
    expect(res.status).toBe(503);
  });

  for (const output of ["not JSON", "null", JSON.stringify({ kind: "note", fields: { text: "Probe" } }), JSON.stringify({ kind: "note", fields: {}, routing: selection("codex") }), JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing: { version: 2 } }), JSON.stringify({ kind: "task", fields: { title: "Probe", map: "other/repo#1" }, routing: selection("codex") }), JSON.stringify({ kind: "note", fields: { text: "Probe" }, routing: parserUnavailable("no-eligible-substrate") })]) {
    it(`fails closed on invalid routed output ${output.slice(0, 45)}`, async () => {
      const db = initDatabase(":memory:");
      try {
        const res = await handleDeskAsk(request({ text: "note Probe" }), runtime(), { runParser: () => Promise.resolve(output), runWriter: () => Promise.reject(new Error("must not write")) }, db);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ routing: { reason: "invalid-output" } });
        expect(listOpenNotes(db)).toHaveLength(0);
      } finally { db.close(); }
    });
  }

  it("does not fall back to rules on routed command failure", async () => {
    const res = await handleDeskAsk(request({ text: "note Probe" }), runtime(), { runParser: () => Promise.reject(new Error("down")) });
    expect(res.status).toBe(503);
  });

  it("rejects invalid request restrictions before invoking a parser", async () => {
    for (const body of [{ text: "note Probe", routing: { permitted: ["other"] } }, { text: "note Probe", area: "unknown" }]) {
      expect((await handleDeskAsk(request(body), runtime(), { runParser: () => Promise.reject(new Error("must not run")) })).status).toBe(400);
    }
  });

  it("never restores rules or automatic capture for malformed routed output in legacy mode", async () => {
    const db = initDatabase(":memory:");
    try {
      setGrant(db, "studio.capture", true, Date.now());
      const desk = runtime();
      if (desk.options?.ask) delete desk.options.ask.routing;
      for (const answer of [{ kind: "capture", fields: { text: "Probe" }, reason: 123, routing: selection("codex") }, { fields: { text: "Probe" }, routing: selection("codex") }]) {
        const res = await handleDeskAsk(request({ text: "capture Probe" }), desk, { runParser: () => Promise.resolve(JSON.stringify(answer)) }, db);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ routing: { reason: "invalid-output" } });
        expect(listOpenNotes(db)).toHaveLength(0);
      }
    } finally { db.close(); }
  });

  it("keeps a routed capture explicit even when automatic capture is granted", async () => {
    const db = initDatabase(":memory:");
    try {
      setGrant(db, "studio.capture", true, Date.now());
      const res = await handleDeskAsk(request({ text: "capture Probe" }), runtime(), { runParser: () => Promise.resolve(JSON.stringify({ kind: "capture", fields: { text: "Probe" }, routing: selection("codex") })) }, db);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ proposal: { kind: "capture" } });
      expect(JSON.stringify(body)).not.toContain('"automatic"');
      expect(listOpenNotes(db)).toHaveLength(0);
    } finally { db.close(); }
  });

  it("gives safe, distinct causes and actions for known unavailable results", () => {
    expect(parserRoutingNotice(parserUnavailable("deadline exceeded"))).toContain("took too long");
    expect(parserRoutingNotice(parserUnavailable("integration-unavailable"))).toContain("connection is unavailable");
    expect(parserRoutingNotice(parserUnavailable("all providers attempted"))).toContain("usage limits");
    expect(parserRoutingNotice(parserUnavailable("private failure at /secret/path"))).not.toContain("/secret/path");
  });

  it("rejects local requests on a legacy parser and accepts routed config", async () => {
    const desk = runtime();
    if (desk.options?.ask) delete desk.options.ask.routing;
    expect((await handleDeskAsk(request({ text: "note Probe", area: "private" }), desk)).status).toBe(503);
    const parsed = McSchema.parse({ desk: { ask: { routing: { permitted: ["pi"] } } } });
    expect(parsed.desk.ask.routing).toEqual({ permitted: ["pi"] });
  });
});
