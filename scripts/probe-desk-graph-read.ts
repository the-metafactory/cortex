import { strict as assert } from "node:assert";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueryPage } from "../src/conversations/domain-adapters/reads/query-types";
import type { ObjectReference } from "../src/conversations/domain-adapters/types";
import { canonicalGraphRef, createWorkGraphReadAdapter } from "../src/conversations/domain-adapters/work-graph/read";
import { withTempHome } from "./probe-temp-home";

const CORTEX = "github:github.com/the-metafactory/cortex";
const OTHER = "github:github.com/the-metafactory/other";
const CORTEX_MAP = `${CORTEX}#3000`;
const CORTEX_NODE = "the-metafactory/cortex#3348";
const CLOSED_NODE = `${CORTEX}#3350`;
const MISSING_NODE = `${CORTEX}#9999`;
const CONNECTION = "connection-graph-probe";
const repository = (canonicalId: string): ObjectReference => ({ adapterId: "work-graph", connectionId: CONNECTION, objectType: "repository", canonicalId });
const node = (canonicalId: string): ObjectReference => ({ adapterId: "work-graph", connectionId: CONNECTION, objectType: "node", canonicalId });

const OPEN = JSON.stringify({ repo: CORTEX, ref: { id: "3348" }, status: "open", url: "https://github.com/the-metafactory/cortex/issues/3348", node: { title: "Read graph destinations and nodes", kind: "build" }, parent: { id: "3293" } });
const CLOSED = JSON.stringify({ repo: CORTEX, ref: { id: "3350" }, status: "closed", url: "https://github.com/the-metafactory/cortex/issues/3350", node: { title: "Publish graph repository ticks", kind: "build" }, parent: null });

function somaScript(log: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> ${JSON.stringify(log)}`,
    "case \"$*\" in",
    `  *\"cortex#3348\"*) printf '%s' ${JSON.stringify(OPEN)} ;;`,
    `  *\"cortex#3350\"*) printf '%s' ${JSON.stringify(CLOSED)} ;;`,
    "  *) printf '%s' \"node not found\" >&2; exit 1 ;;",
    "esac",
    "",
  ].join("\n");
}

function released(page: QueryPage): { ref: ObjectReference; value: Record<string, unknown> }[] {
  const items = (page.payload as { items: Record<string, unknown>[] }).items;
  return page.annotations.map((annotation, index) => ({ ref: annotation.ref, value: items[index] ?? {} }));
}

await withTempHome(async home => {
  const dir = join(home, "bin");
  await mkdir(dir, { recursive: true });
  const log = join(home, "argv.log");
  const soma = join(dir, "soma");
  await writeFile(soma, somaScript(log));
  await chmod(soma, 0o755);
  const adapter = createWorkGraphReadAdapter({
    connectionId: CONNECTION,
    repositories: () => [CORTEX],
    links: () => [{ owner: "graph-map", id: CORTEX_MAP }, { owner: "graph-node", id: CORTEX_NODE }],
    somaBin: soma,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
  });

  const destinations = await adapter.destinations();
  assert.deepEqual(destinations.annotations.map(annotation => [annotation.ref.objectType, annotation.ref.canonicalId]), [["repository", CORTEX], ["map", CORTEX_MAP], ["node", CORTEX_NODE]]);
  assert.deepEqual((destinations.payload as { items: { title: string }[] }).items.map(item => item.title), [canonicalGraphRef(CORTEX), CORTEX_MAP, CORTEX_NODE]);
  assert.ok(destinations.annotations.every(annotation => annotation.destination.objectType === "repository" && annotation.destination.canonicalId === CORTEX));
  console.log("destinations: the exact stored repository ref and the linked map and node, every one scoped to that repository.");

  const open = await adapter.query({ readVersion: "1.0.0", queryId: "probe-open", capabilityId: "work-graph.node.read", input: { ref: node(CORTEX_NODE) }, destinations: [repository(CORTEX)], limit: 1 });
  const [openNode] = released(open);
  assert.deepEqual(openNode?.ref, node(CORTEX_NODE));
  assert.deepEqual(openNode?.value, { title: "Read graph destinations and nodes", status: "open", kind: "build", parent: node(`${CORTEX}#3293`), url: "https://github.com/the-metafactory/cortex/issues/3348" });
  console.log("open node: soma graph node --json answered, the stored reference stays as written and the parent is qualified.");

  const closed = await adapter.query({ readVersion: "1.0.0", queryId: "probe-closed", capabilityId: "work-graph.node.read", input: { ref: node(CLOSED_NODE) }, destinations: [repository(CORTEX)], limit: 1 });
  assert.equal(released(closed)[0]?.value.status, "closed");
  console.log("closed node: status closed is available, not an unavailable read.");

  await assert.rejects(
    adapter.query({ readVersion: "1.0.0", queryId: "probe-missing", capabilityId: "work-graph.node.read", input: { ref: node(MISSING_NODE) }, destinations: [repository(CORTEX)], limit: 1 }),
    /work-graph\.node_unavailable/,
  );
  console.log("missing node: unavailable and proves nothing about a historic operation.");

  const seen = (await readFile(log, "utf8")).trimEnd().split("\n").length;
  await assert.rejects(
    adapter.query({ readVersion: "1.0.0", queryId: "probe-denied", capabilityId: "work-graph.node.read", input: { ref: node(CORTEX_NODE) }, destinations: [repository(OTHER)], limit: 1 }),
    /work-graph\.destination_denied/,
  );
  const after = (await readFile(log, "utf8")).trimEnd().split("\n").length;
  assert.equal(after, seen);
  console.log("denied reference: the repository is not a destination, so the refusal precedes soma and the argv log stays unchanged.");

  const argv = (await readFile(log, "utf8")).trimEnd().split("\n");
  assert.deepEqual(argv, [`graph node ${CORTEX}#3348 --read-repo ${CORTEX} --json`, `graph node ${CORTEX}#3350 --read-repo ${CORTEX} --json`, `graph node ${CORTEX}#9999 --read-repo ${CORTEX} --json`]);
  console.log("argv: every soma call is recorded; the synthetic executable ran three reads and no denied one.");
});
