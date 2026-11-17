import assert from "node:assert/strict";
import { runWithTemporaryHome } from "./probe-temp-home";
import { openMailRoundRig, roundAt } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";

async function probe(): Promise<void> {
  const now = roundAt(16, 11);
  const rig = await openMailRoundRig(now, { mailInvitations: undefined, mailDigest: undefined });
  try {
    rig.setState({ mail: [] });
    rig.database().query("INSERT INTO desk_notes (kind, text, due_at, created_at) VALUES ('note', 'Fixture note about the pangolin keeper', NULL, ?)").run(now - 60_000);
    const response = await fetch(`${rig.baseUrl()}/api/desk/search?q=pangolin`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-desk-api-version") !== null, true);
    const body = (await response.json()) as { status: string; hits: { kind: string; snippet: string; open: { path: string } }[] };
    assert.equal(body.status, "ok");
    assert.deepEqual(body.hits.map((hit) => [hit.kind, hit.open.path]), [["desk-note", "/api/desk"]]);
    assert.ok(body.hits[0]?.snippet.includes("pangolin"));
    console.log("GET /api/desk/search?q=pangolin: 200, one desk-note hit that opens on /api/desk");
    const refused = await fetch(`${rig.baseUrl()}/api/desk/search?q=`);
    assert.equal(refused.status, 400);
    console.log("GET /api/desk/search?q=: 400");
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
