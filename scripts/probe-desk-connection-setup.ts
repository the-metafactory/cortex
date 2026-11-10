import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { connectionSetupRig, OTHER, SELECTION, SYNTHETIC_TOKEN } from "../src/conversations/connection-setup-fixtures";
import { ConnectionSetupBody } from "../src/surface/mc/dashboard-v2/components/desk-connection-setup";
import type { ConnectionView, PackageForm } from "../src/surface/mc/dashboard-v2/lib/desk-connection-setup";

const priorHome = process.env.HOME;
const lines: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
const rig = await connectionSetupRig();
process.env.HOME = rig.dir;
const PATH = "/api/desk/connections";
const inputs = { primary: { token: SYNTHETIC_TOKEN }, backup: { token: `${SYNTHETIC_TOKEN}-backup` } };
const seen: string[] = [];
const connectionOf = (body: Record<string, unknown>): ConnectionView => body.connection as ConnectionView;

try {
  for (const mode of ["local", "hosted"] as const) {
    const base = { ...rig.counts };
    const listed = await rig.http(mode, "GET", PATH, undefined);
    assert.equal(listed.status, 200);
    const forms = listed.body.packages as PackageForm[];
    const html = renderToStaticMarkup(createElement(ConnectionSetupBody, { snapshot: { ok: true, packages: forms, connections: [] }, note: null, busy: false, apply: async () => {} }));
    assert.ok(html.includes('type="password"') && html.includes('aria-label="Write access"'));
    assert.equal(rig.counts.secretWrites, base.secretWrites);

    const local = await rig.http(mode, "POST", PATH, { packageId: "example-local-package", ...SELECTION });
    assert.equal(connectionOf(local.body).state, "disabled");

    rig.hooks.publishFails = true;
    const partial = await rig.http(mode, "POST", PATH, { packageId: "example-package", ...SELECTION, inputs });
    const incomplete = connectionOf(partial.body);
    assert.equal(incomplete.state, "incomplete");
    assert.equal((await rig.http(mode, "POST", `${PATH}/${incomplete.connectionId}/enable`, { expectedRevision: incomplete.revision })).status, 409);
    rig.hooks.publishFails = false;
    await rig.reopen();
    const resumed = connectionOf((await rig.http(mode, "POST", `${PATH}/${incomplete.connectionId}/provision`, { expectedRevision: incomplete.revision, inputs })).body);
    assert.equal(resumed.state, "disabled");

    const before = { ...rig.counts };
    const denied = [
      await rig.http(mode, "POST", PATH, { packageId: "example-package", ...SELECTION, inputs }, OTHER),
      await rig.http(mode, "POST", `${PATH}/${resumed.connectionId}/enable`, { expectedRevision: resumed.revision }, OTHER),
      await rig.http(mode, "POST", `${PATH}/${resumed.connectionId}/enable`, { expectedRevision: resumed.revision + 9 }),
    ];
    assert.ok(denied.every(item => item.status >= 400 && item.status < 500));
    assert.deepEqual(rig.counts, before);

    const enabled = connectionOf((await rig.http(mode, "POST", `${PATH}/${resumed.connectionId}/enable`, { expectedRevision: resumed.revision })).body);
    assert.equal(enabled.state, "enabled");
    const disabled = connectionOf((await rig.http(mode, "POST", `${PATH}/${resumed.connectionId}/disable`, { expectedRevision: enabled.revision })).body);
    assert.equal(disabled.state, "disabled");
    assert.ok(rig.counts.bridgesClosed.includes(resumed.connectionId));
    seen.push(listed.text, partial.text, JSON.stringify(denied.map(item => item.text)));
  }

  await rig.reopen();
  const after = await rig.http("local", "GET", PATH, undefined);
  const states = (after.body.connections as ConnectionView[]).map(item => item.state);
  assert.ok(states.length === 4 && states.every(state => state === "disabled"));
  rig.catalog.splice(0, 1);
  const missing = await rig.http("local", "GET", PATH, undefined);
  assert.ok((missing.body.connections as ConnectionView[]).some(item => item.state === "unavailable" && item.reason === "package_missing"));
  assert.equal(rig.counts.ownerMutations, 0);

  const everything = JSON.stringify([seen, after.text, missing.text, lines, rig.heads.map(head => Object.keys(head))]);
  assert.ok(!everything.includes(SYNTHETIC_TOKEN));
  await rig.host().close();
  const files = readdirSync(join(rig.dir, "host"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  assert.ok(files.every(entry => !readFileSync(join(entry.parentPath, entry.name)).toString("latin1").includes(SYNTHETIC_TOKEN)));
  await rig.reopen();
  process.stderr.write = realWrite;
  console.log(`Synthetic connection setup (local and hosted): ${rig.counts.secretWrites} secret writes, ${rig.counts.headUpdates} head updates, ${rig.counts.authorityPublishes} authority publications, ${rig.counts.ownerMutations} owner mutations; partial failure stayed incomplete and resumed after reopen; wrong-principal, forged and stale requests changed nothing; explicit enable and disable closed bridges and kept all records; missing package shown as unavailable; no secret in responses, logs or the host store.`);
} finally {
  process.stderr.write = realWrite;
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  await rig.close();
}
