import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config";
import { initDatabase } from "../../db/init";
import { saveBalanceState } from "../../desk/balance-store";
import { linkToMeeting, type LinkSubject } from "../../desk/links";
import type { MeetingBrief } from "../../desk/meeting-brief-contract";
import { addNote } from "../../desk/notes";
import { startServer } from "../../server";
import { briefOptions, EVENT, fixture, NOW, PRINCIPAL, seed } from "./meeting-brief";

export async function meetingBriefHttpProbe() {
  const dir = mkdtempSync(join(tmpdir(), "meeting-brief-http-"));
  const db = initDatabase(join(dir, "fixture.sqlite"));
  saveBalanceState(db, seed());
  const note = addNote(db, "note", "Bring the budget sheet", null, NOW);
  const subjects: LinkSubject[] = [
    { kind: "mail", key: "mail:m1", title: "Untrusted saved title", mail: { sourceId: "cal", sender: "ada@example.org", senderName: "Ada Lovelace", receivedAt: new Date(NOW).toISOString(), url: null, account: "work" } },
    { kind: "task", key: "task:kickoff", title: "Untrusted saved title", mail: null },
    { kind: "note", key: `note:${note.id}`, title: "Untrusted saved title", mail: null },
  ];
  for (const [index, subject] of subjects.entries()) {
    assert.equal(linkToMeeting(db, subject, { kind: "meeting", key: EVENT, title: "Weekly sync", at: NOW, end: NOW + 1 }, {
      id: `probe-link-${index}`, requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, origin: "desk", now: NOW,
    }).ok, true);
  }
  const write = (data: ReturnType<typeof fixture>) => writeFileSync(join(dir, "source.json"), JSON.stringify(data));
  write(fixture());
  const options = briefOptions(dir);
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: [PRINCIPAL], localPrincipal: PRINCIPAL } }, db, { desk: options });
  const base = `http://localhost:${ctx.server.port}`;
  const exchanges: { request: { method: string; path: string; body?: unknown }; status: number; response: unknown }[] = [];
  const send = async (method: string, body?: unknown, email = PRINCIPAL, origin = base, host?: string) => {
    const path = `/api/desk/meeting-brief${method === "GET" ? `?event=${EVENT}` : ""}`;
    const response = await fetch(base + path, {
      method, headers: { origin, "content-type": "application/json", "Cf-Access-Authenticated-User-Email": email, ...(host ? { host } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await response.json();
    exchanges.push({ request: { method, path, ...(body === undefined ? {} : { body }) }, status: response.status, response: json });
    if (response.status !== 403) assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, json };
  };
  try {
    const prepared = await send("POST", { event: EVENT });
    assert.equal(prepared.status, 200);
    const first = prepared.json as MeetingBrief;
    assert.equal(first.facts.length, 3);
    assert.deepEqual((await send("GET")).json, first);
    for (const method of ["GET", "POST"]) {
      const body = method === "POST" ? { event: EVENT } : undefined;
      assert.equal((await send(method, body, "stranger@example.com")).status, 403);
      assert.equal((await send(method, body, PRINCIPAL, "https://untrusted.example.org")).status, 403);
      assert.equal((await send(method, body, PRINCIPAL, base, "untrusted.example.org")).status, 403);
    }
    assert.equal((await send("POST", { event: EVENT, description: "untrusted" })).status, 400);
    write(fixture({ items: [] }));
    const stale = await send("GET");
    assert.equal(stale.status, 409);
    assert.equal(JSON.stringify(stale.json).includes("venue"), false);
    const next = await send("POST", { event: EVENT, refresh: true });
    assert.equal(next.status, 200);
    const refreshed = next.json as MeetingBrief;
    assert.notEqual(refreshed.revision, first.revision);
    assert.equal(refreshed.facts.length, 2);
    assert.deepEqual(refreshed.gaps.map(gap => [gap.source.kind, gap.source.item, gap.reason]), [["mail", "mail:m1", "read-failed"]]);
    assert.deepEqual((await send("GET")).json, refreshed);
    const areas = options.areas;
    options.areas = [];
    const revoked = await send("GET");
    assert.equal(revoked.status, 409);
    assert.equal(JSON.stringify(revoked.json).includes("Kickoff"), false);
    const denied = await send("POST", { event: EVENT, refresh: true });
    assert.equal(denied.status, 200);
    const deniedBrief = denied.json as MeetingBrief;
    assert.ok(deniedBrief.gaps.some(gap => gap.source.kind === "task" && gap.reason === "access-denied"));
    assert.equal(JSON.stringify(deniedBrief).includes("Kickoff prep"), false);
    options.areas = areas;
    write(fixture({ events: [] }));
    assert.equal((await send("GET")).status, 404);
    const pins = JSON.parse(readFileSync(new URL("../../../../../docs/desk/examples/meeting-brief-v1.json", import.meta.url), "utf8")) as { fixtureVersion: number; cases: typeof exchanges };
    assert.equal(pins.fixtureVersion, 1);
    for (const pin of pins.cases) {
      const actual = exchanges.find(exchange => exchange.status === pin.status && JSON.stringify(exchange.request) === JSON.stringify(pin.request));
      assert.ok(actual);
      if (actual.status === 200) {
        const brief = actual.response as MeetingBrief;
        assert.match(brief.revision, /^[a-f0-9]{64}$/);
        assert.equal(Number.isNaN(Date.parse(brief.preparedAt)), false);
        assert.deepEqual({ ...brief, revision: "opaque-evidence-revision", preparedAt: "2026-11-04T09:00:00.000Z" }, pin.response);
      } else assert.deepEqual(actual.response, pin.response);
    }
    return { isolated: true, modelConfigured: false, exchanges };
  } finally {
    ctx.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
