import { DEFAULT_CONFIG } from "../../config";
import { initDatabase } from "../../db/init";
import { saveBalanceState } from "../../desk/balance-store";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { linkToMeeting } from "../../desk/links";
import type { MeetingBrief } from "../../desk/meeting-brief-contract";
import { addNote } from "../../desk/notes";
import { startServer } from "../../server";
import { briefOptions, EVENT, NOW, PRINCIPAL, seed } from "./meeting-brief";

const PREVIOUS_EVENT = "cal:cal:previous-week";
const DAY = 86_400_000;
const iso = (at: number): string => new Date(at).toISOString();

const PREVIOUS_PINS = new URL("../../../../../docs/desk/examples/meeting-brief-previous-v1.json", import.meta.url);

interface Exchange {
  name: string;
  request: { method: string; path: string; body?: unknown };
  status: number;
  response: unknown;
}

export async function meetingBriefPreviousHttpProbe() {
  const dir = mkdtempSync(join(tmpdir(), "meeting-brief-previous-http-"));
  const db = initDatabase(join(dir, "fixture.sqlite"));
  saveBalanceState(db, seed());
  const note = addNote(db, "note", "Agreed: the venue is booked", null, NOW);
  const previousAt = NOW - 2 * DAY;
  assert.equal(linkToMeeting(db, { kind: "note", key: `note:${note.id}`, title: "Untrusted saved title", mail: null }, { kind: "meeting", key: PREVIOUS_EVENT, title: "Weekly sync", at: previousAt, end: previousAt + 3_600_000 }, {
    id: "probe-previous-link", requestId: "00000000-0000-4000-8000-000000000001", origin: "desk", now: NOW,
  }).ok, true);
  writeFileSync(join(dir, "source.json"), JSON.stringify({
    events: [
      { id: "standup", title: "Weekly sync", start: iso(NOW + 3_600_000), end: iso(NOW + 7_200_000) },
      { id: "previous-week", title: "Weekly sync", start: iso(previousAt), end: iso(previousAt + 3_600_000) },
    ],
    items: [],
  }));
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: [PRINCIPAL], localPrincipal: PRINCIPAL } }, db, { desk: briefOptions(dir) });
  const base = `http://localhost:${ctx.server.port}`;
  const exchanges: Exchange[] = [];
  const send = async (name: string, path: string, body: unknown, email = PRINCIPAL, origin = base) => {
    const response = await fetch(base + path, { method: "POST", headers: { origin, "content-type": "application/json", "Cf-Access-Authenticated-User-Email": email }, body: JSON.stringify(body) });
    const json: unknown = await response.json();
    exchanges.push({ name, request: { method: "POST", path, body }, status: response.status, response: json });
    if (response.status !== 403) assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, json };
  };
  const previous = "/api/desk/meeting-brief/previous";
  const release = (): void => {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    ctx.stop(true);
  };
  try {
    assert.equal((await send("denied-identity", previous, { event: EVENT, previousEvent: PREVIOUS_EVENT }, "stranger@example.com")).status, 403);
    assert.equal((await send("denied-origin", previous, { event: EVENT, previousEvent: PREVIOUS_EVENT }, PRINCIPAL, "https://untrusted.example.org")).status, 403);
    assert.equal((await send("set-previous", previous, { event: EVENT, previousEvent: PREVIOUS_EVENT })).status, 200);
    const identified = (await send("brief-identified", "/api/desk/meeting-brief", { event: EVENT })).json as MeetingBrief;
    assert.equal(identified.previousMeeting.state, "identified");
    assert.deepEqual(identified.previousMeeting.facts?.map((fact) => fact.text), ["Note: Agreed: the venue is booked"]);
    assert.equal((await send("reject-self", previous, { event: EVENT, previousEvent: EVENT })).status, 409);
    assert.equal((await send("reject-unknown-field", previous, { event: EVENT, previousEvent: PREVIOUS_EVENT, description: "untrusted" })).status, 400);
    assert.equal((await send("clear-previous", previous, { event: EVENT, previousEvent: null })).status, 200);
    const cleared = (await send("brief-unidentified", "/api/desk/meeting-brief", { event: EVENT })).json as MeetingBrief;
    assert.equal(cleared.previousMeeting.state, "unidentified");
    assert.notEqual(cleared.revision, identified.revision);
    const pins = JSON.parse(readFileSync(PREVIOUS_PINS, "utf8")) as { fixtureVersion: number; cases: Exchange[] };
    assert.equal(pins.fixtureVersion, 1);
    assert.deepEqual(pins.cases.map((pin) => pin.name), exchanges.map((exchange) => exchange.name));
    for (const pin of pins.cases) {
      const actual = exchanges.find((exchange) => exchange.name === pin.name);
      assert.ok(actual);
      assert.deepEqual(actual.request, pin.request);
      assert.equal(actual.status, pin.status);
      const normalized = actual.status === 200 && pin.name.startsWith("brief-")
        ? { ...(actual.response as MeetingBrief), revision: "opaque-evidence-revision", preparedAt: "2026-11-04T09:00:00.000Z" }
        : actual.response;
      assert.deepEqual(normalized, pin.response);
    }
    return { isolated: true, modelConfigured: false, exchanges };
  } finally {
    release();
  }
}
