// glossary-ignore: node, owner
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSERVATION_LIMITS } from "../src/conversations/domain-adapters/reads/observation-policy";
import { runCommand } from "../src/surface/mc/common/spawn";
import { OBSERVED, OBSERVED_NODE, OBSERVED_NODE_THREE, OBSERVED_NODE_TWO, openGraphObservationRig, syntheticListing, syntheticRow, type SyntheticListingRow } from "../src/conversations/domain-adapters/__tests__/fixtures/graph-observation-fixtures";
import { runWithTemporaryHome } from "./probe-temp-home";

const wire = (row: SyntheticListingRow): string => JSON.stringify({ ref: { id: row.id }, title: row.title, status: row.status, kind: row.kind, parent: row.parent, url: row.url });

function somaScript(paths: { log: string; rows: string; present: string; fail: string; probeFail: string }): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(paths.log)}`,
    `if [ -f ${JSON.stringify(paths.fail)} ]; then printf '%s\\n' "soma could not reach the graph owner" >&2; exit 1; fi`,
    'if [ "$1" = "graph" ] && [ "$2" = "list" ]; then',
    '  limit=0; cursor=""',
    '  while [ $# -gt 0 ]; do case "$1" in --limit) limit=$2; shift 2 ;; --cursor) cursor=$2; shift 2 ;; *) shift ;; esac; done',
    "  offset=0",
    `  case "$cursor" in "") offset=0 ;; after:*) offset=\${cursor#after:} ;; *) printf '%s\\n' "the cursor is not one this verb issued" >&2; exit 1 ;; esac`,
    `  total=$(wc -l < ${JSON.stringify(paths.rows)} | tr -d ' ')`,
    "  end=$((offset + limit))",
    '  if [ "$end" -gt "$total" ]; then end=$total; fi',
    '  page=""',
    '  if [ "$end" -gt "$offset" ]; then',
    `    page=$(sed -n "$((offset + 1)),\${end}p" ${JSON.stringify(paths.rows)} | tr '\\n' ',')`,
    "    page=${page%,}",
    "  fi",
    '  if [ "$end" -lt "$total" ]; then next="\\"after:$end\\""; else next=null; fi',
    '  printf \'{"nodes":[%s],"next":%s}\\n\' "$page" "$next"',
    "  exit 0",
    "fi",
    'if [ "$1" = "graph" ] && [ "$2" = "node" ]; then',
    "  ref=$3",
    `  if [ -f ${JSON.stringify(paths.probeFail)} ]; then printf '%s\\n' "Could not resolve host: api.github.com" >&2; exit 1; fi`,
    `  if grep -qxF "$ref" ${JSON.stringify(paths.present)}; then printf '{"ref":{"id":"%s"}}\\n' "\${ref##*#}"; exit 0; fi`,
    '  printf \'%s\\n\' "node $ref not found" >&2',
    "  exit 1",
    "fi",
    'printf \'%s\\n\' "unsupported synthetic verb" >&2',
    "exit 2",
    "",
  ].join("\n");
}

const nodeValue = (row: SyntheticListingRow, connectionId: string) => ({
  title: row.title, status: row.status, kind: row.kind, url: row.url,
  parent: row.parent === null ? null : { adapterId: "work-graph", connectionId, objectType: "node", canonicalId: `${OBSERVED}#${row.parent.id}` },
});

async function probe(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "desk-probe-home-"));
  try {
  const dir = join(home, "bin");
  await mkdir(dir, { recursive: true });
  const paths = { log: join(home, "argv.log"), rows: join(home, "rows.txt"), present: join(home, "present.txt"), fail: join(home, "fail.txt"), probeFail: join(home, "probe-fail.txt") };
  const soma = join(dir, "soma");
  await writeFile(soma, somaScript(paths));
  await chmod(soma, 0o755);
  const stage = async (rows: readonly SyntheticListingRow[], present: readonly string[]): Promise<void> => {
    await writeFile(paths.rows, rows.map(row => `${wire(row)}\n`).join(""));
    await writeFile(paths.present, present.map(ref => `${ref}\n`).join(""));
  };
  const calls = async (): Promise<string[]> => {
    const text = (await readFile(paths.log, "utf8")).trimEnd();
    return text.length === 0 ? [] : text.split("\n");
  };
  const listed = async (limit: number): Promise<{ ref: { id: string }; title: string }[]> => {
    const result = await runCommand([soma, "graph", "list", "--repo", OBSERVED, "--state", "all", "--limit", String(limit), "--read-repo", OBSERVED, "--json"], 8_000);
    assert.equal(result.code, 0);
    return (JSON.parse(result.stdout) as { nodes: { ref: { id: string }; title: string }[] }).nodes;
  };

  const rows = syntheticListing();
  await stage(rows, [OBSERVED_NODE, OBSERVED_NODE_TWO, OBSERVED_NODE_THREE]);
  const rig = await openGraphObservationRig(undefined, { pageItems: 2, somaBin: soma });
  try {
    const first = await rig.check();
    assert.equal(first.status, "ok");
    assert.equal(first.changed, 3);
    const argv = await calls();
    assert.equal(argv.filter(line => line.startsWith("graph list")).length, 2);
    assert.ok(argv[1]?.includes("--cursor after:2"));
    const views = await rig.views();
    const verb = await listed(10);
    assert.deepEqual(views.map(view => view.ref.canonicalId).sort(), verb.map(row => `${OBSERVED}#${row.ref.id}`).sort());
    for (const row of rows) assert.deepEqual(views.find(view => view.ref.canonicalId === `${OBSERVED}#${row.id}`)?.value, nodeValue(row, rig.connectionId));
    assert.ok(views.every(view => view.status === "fresh" && view.evidenceCount === 1));
    console.log("page boundary: two bounded verb pages, one projection per node, equal to the verb rows");

    const repeat = await rig.check();
    assert.equal(repeat.changed, 0);
    assert.equal((await rig.views()).length, 3);
    assert.ok((await rig.views()).every(view => view.evidenceCount === 1));
    console.log("repeat: nothing duplicated, one evidence entry per node");

    rig.links.push({ owner: "graph-node", id: OBSERVED_NODE_THREE });
    await rig.store.link(rig.source, { adapterId: "work-graph", connectionId: rig.connectionId, objectType: "node", canonicalId: OBSERVED_NODE_THREE }, "conversation-probe");
    await stage(rows.filter(row => row.id !== "3350"), [OBSERVED_NODE, OBSERVED_NODE_TWO, OBSERVED_NODE_THREE]);
    assert.equal((await rig.check()).status, "ok");
    const kept = (await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE);
    assert.deepEqual(kept?.value, nodeValue(rows[2] ?? syntheticRow("3350", "Read the graph picker", "closed"), rig.connectionId));
    rig.time.advance(OBSERVATION_LIMITS.staleMs);
    assert.equal((await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE)?.status, "stale");
    console.log("disappearance: the owner still has the node, so it stays with its value and goes stale");

    await writeFile(paths.probeFail, "\n");
    assert.equal((await rig.check()).status, "ok");
    const unreachable = (await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE);
    assert.deepEqual(unreachable?.value, nodeValue(rows[2] ?? syntheticRow("3350", "Read the graph picker", "closed"), rig.connectionId));
    assert.equal(unreachable?.kind, "present");
    await rm(paths.probeFail);
    console.log("transport failure on the deletion probe: the retained value stays, nothing is read as deleted");

    await stage(rows.filter(row => row.id !== "3350"), [OBSERVED_NODE, OBSERVED_NODE_TWO]);
    assert.equal((await rig.check()).status, "ok");
    assert.equal((await rig.views()).length, 2);
    const marker = (await rig.views(true)).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE);
    assert.equal(marker?.kind, "deleted");
    assert.equal(marker?.value, undefined);
    assert.equal((await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE)?.kind, "present");
    console.log("owner deletion: a not-found from the owner removes the row and keeps no value");

    await writeFile(paths.fail, "\n");
    const failed = await rig.check();
    assert.equal(failed.status, "unavailable");
    const stale = await rig.views();
    assert.equal(stale.length, 2);
    assert.ok(stale.every(view => view.kind === "present" && view.status === "stale"));
    console.log("failing verb: stale, nothing treated as empty or deleted");

    const before = (await calls()).length;
    await rig.untick();
    assert.equal((await rig.check()).status, "denied");
    assert.equal((await calls()).length, before);
    assert.equal((await rig.read()).kind, "withheld");
    console.log("untick: results withheld at once, no further verb call");
  } finally {
    await rig.close();
  }
  } finally { await rm(home, { recursive: true, force: true }); }
}

await runWithTemporaryHome(import.meta.path, probe);
