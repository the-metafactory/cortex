import { strict as assert } from "node:assert";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLOSED_NODE, CORTEX, CORTEX_MAP, CORTEX_NODE, GRAPH_NODE_BODIES, MISSING_NODE, UNTICKED, graphRef } from "../src/conversations/domain-adapters/__tests__/fixtures/graph-read-fixtures";
import type { QueryPage } from "../src/conversations/domain-adapters/reads/query-types";
import type { ObjectReference } from "../src/conversations/domain-adapters/types";
import { canonicalGraphRef, createWorkGraphReadAdapter } from "../src/conversations/domain-adapters/work-graph/read";
import { withTempHome } from "./probe-temp-home";

const CONNECTION = "connection-graph-probe";
const UNTICKED_NODE = `${UNTICKED}#7`;
const repository = (canonicalId: string): ObjectReference => graphRef(CONNECTION, "repository", canonicalId);
const node = (canonicalId: string): ObjectReference => graphRef(CONNECTION, "node", canonicalId);
const foreignRepository = (canonicalId: string): ObjectReference => ({ adapterId: "balance", connectionId: CONNECTION, objectType: "repository", canonicalId });

function somaScript(log: string): string {
  const arms = Object.entries(GRAPH_NODE_BODIES).map(([target, body]) => `  *"${target}"*) printf '%s' ${JSON.stringify(JSON.stringify(body))} ;;`);
  return ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, "case \"$*\" in", ...arms, "  *) printf 'node %s not found' \"$3\" >&2; exit 1 ;;", "esac", ""].join("\n");
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
  const argvLines = async (): Promise<string[]> => {
    const text = (await readFile(log, "utf8")).trimEnd();
    return text.length === 0 ? [] : text.split("\n");
  };

  const destinations = await adapter.destinations();
  assert.deepEqual(destinations.annotations.map(annotation => [annotation.ref.objectType, annotation.ref.canonicalId]), [["repository", CORTEX], ["map", CORTEX_MAP], ["node", CORTEX_NODE]]);
  assert.deepEqual((destinations.payload as { items: { title: string }[] }).items.map(item => item.title), [canonicalGraphRef(CORTEX), CORTEX_MAP, CORTEX_NODE]);
  assert.ok(destinations.annotations.every(annotation => annotation.destination.objectType === "repository" && annotation.destination.canonicalId === CORTEX));
  console.log("destinations: the exact stored repository ref and the linked map and node, every one scoped to that repository.");

  const open = await adapter.query({
    readVersion: "1.0.0", queryId: "probe-open", capabilityId: "work-graph.node.read", input: { ref: node(CORTEX_NODE) },
    destinations: [repository(CORTEX), repository(UNTICKED), foreignRepository(UNTICKED)], limit: 1,
  });
  const [openNode] = released(open);
  assert.deepEqual(openNode?.ref, node(CORTEX_NODE));
  assert.deepEqual(openNode?.value, { title: "Read graph destinations and nodes", status: "open", kind: "build", parent: node(`${CORTEX}#3293`), url: "https://github.com/the-metafactory/cortex/issues/3348" });
  console.log("open node: soma graph node --json answered, the stored reference stays as written and the parent is qualified.");

  const closed = await adapter.query({ readVersion: "1.0.0", queryId: "probe-closed", capabilityId: "work-graph.node.read", input: { ref: node(CLOSED_NODE) }, destinations: [repository(CORTEX)], limit: 1 });
  assert.equal(released(closed)[0]?.value.status, "closed");
  assert.deepEqual(released(closed)[0]?.value.parent, node(`${CORTEX}#3293`));
  console.log("closed node: status closed is available with its parent, not an unavailable read.");

  await assert.rejects(
    adapter.query({ readVersion: "1.0.0", queryId: "probe-missing", capabilityId: "work-graph.node.read", input: { ref: node(MISSING_NODE) }, destinations: [repository(CORTEX)], limit: 1 }),
    /work-graph\.node_unavailable/,
  );
  console.log("missing node: unavailable and proves nothing about a historic operation.");

  const seen = (await argvLines()).length;
  await assert.rejects(
    adapter.query({ readVersion: "1.0.0", queryId: "probe-mismatched", capabilityId: "work-graph.node.read", input: { ref: node(CORTEX_NODE) }, destinations: [repository(UNTICKED)], limit: 1 }),
    /work-graph\.destination_denied/,
  );
  await assert.rejects(
    adapter.query({ readVersion: "1.0.0", queryId: "probe-unticked", capabilityId: "work-graph.node.read", input: { ref: node(UNTICKED_NODE) }, destinations: [repository(UNTICKED)], limit: 1 }),
    /work-graph\.destination_denied/,
  );
  assert.equal((await argvLines()).length, seen);
  console.log("denied references: a node outside the requested repository and a node in a repository that is not ticked both refuse before soma runs, so the argv log stays unchanged.");

  const argv = await argvLines();
  assert.deepEqual(argv, [`graph node ${CORTEX}#3348 --read-repo ${CORTEX} --json`, `graph node ${CORTEX}#3350 --read-repo ${CORTEX} --json`, `graph node ${CORTEX}#9999 --read-repo ${CORTEX} --json`]);
  console.log("argv: every soma call is recorded with only the node's own ticked repository as read scope; the synthetic executable ran three reads and no denied one.");
});
