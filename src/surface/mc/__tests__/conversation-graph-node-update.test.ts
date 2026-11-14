import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CreateRequest, OperationRecord } from "../../../conversations/types";
import { capabilities } from "../../../conversations/creation";
import { initDatabase } from "../db/init";
import type { DeskOptions } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import type { WriterResult } from "../desk/create";
import { graphCloseWriter, graphRulingWriter, targetNode } from "../desk/graph-node-update-writer";
import { setGraphRepositoryEnabled } from "../desk/graph-repositories";

const SOMA = "/opt/soma/bin/soma";
const REPO = "github:github.com/example/app";
const DESK: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], somaBin: SOMA };
const databases: ReturnType<typeof initDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function rig(answer: (argv: string[]) => WriterResult = () => ({ code: 0, stdout: "{}", stderr: "" })) {
  const db = initDatabase(":memory:"); databases.push(db);
  setGraphRepositoryEnabled(db, REPO, true, 1);
  const calls: { argv: string[]; file: string | null }[] = [];
  const run = async (argv: string[]): Promise<WriterResult> => {
    const at = argv.findIndex(a => a === "--text-file" || a === "--resolution-file");
    calls.push({ argv, file: at >= 0 ? readFileSync(argv[at + 1] ?? "", "utf8") : null });
    return answer(argv);
  };
  const deps = { db, desk: () => DESK, run, now: () => 5 };
  return { db, calls, ruling: graphRulingWriter(deps), close: graphCloseWriter(deps) };
}

const request = (fields: Record<string, string>, operationId = "op-1"): CreateRequest => ({
  operationId, type: "graph-ruling", fields, activation: "none", signal: new AbortController().signal,
  provenance: { conversationId: "conv-9", proposalId: "p-1", revision: 1, operationId, entryId: null, link: "http://127.0.0.1:8767/desk/conversations/conv-9" },
});
const operation = (operationId: string): OperationRecord => ({ operationId } as OperationRecord);

describe("graph node update writers", () => {
  test("the node reference accepts owner/name#N, a qualified ref and an issue URL, and refuses anything else", () => {
    const expected = { repository: REPO, id: "31" };
    expect(targetNode("example/app#31")).toEqual(expected);
    expect(targetNode(" github:github.com/example/app#31 ")).toEqual(expected);
    expect(targetNode("https://github.com/example/app/issues/31")).toEqual(expected);
    expect(targetNode("gitlab:gitlab.example.org/group/proj#4")).toEqual({ repository: "gitlab:gitlab.example.org/group/proj", id: "4" });
    for (const bad of ["31", "example/app", "example/app#0", "--repo", "https://example.org/example/app/issues/31", "gitlab:gitlab.example.org/group/proj&4"]) expect(targetNode(bad)).toBeNull();
  });

  test("a ruling runs soma graph rule on the named node with the ruling and its provenance in a file", async () => {
    const { ruling, calls } = rig();
    const result = await ruling.create(request({ node: "https://github.com/example/app/issues/31", text: "D1 Use SQLite.\nD2 Keep Redis out." }));
    expect(result).toEqual({ state: "created", canonicalId: "example/app#31", url: "https://github.com/example/app/issues/31" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.argv.slice(0, 4)).toEqual([SOMA, "graph", "rule", "31"]);
    expect(call?.argv.slice(6)).toEqual(["--repo", REPO, "--json"]);
    expect(call?.file).toContain("D1 Use SQLite.\nD2 Keep Redis out.");
    expect(call?.file).toContain("conversation conv-9, operation op-1");
  });

  test("a close runs soma graph close with the resolution file and the gist, and never passes --json", async () => {
    const { close, calls } = rig(() => ({ code: 0, stdout: "Closed node 31.", stderr: "" }));
    const result = await close.create(request({ node: "example/app#31", gist: "SQLite, no Redis", resolution: "We chose SQLite because operation stays simple." }));
    expect(result).toMatchObject({ state: "created", canonicalId: "example/app#31" });
    const argv = calls[0]?.argv ?? [];
    expect(argv.slice(0, 4)).toEqual([SOMA, "graph", "close", "31"]);
    expect(argv.slice(6)).toEqual(["--gist", "SQLite, no Redis", "--repo", REPO]);
    expect(calls[0]?.file).toContain("We chose SQLite because operation stays simple.");
  });

  test("soma's refusal reason reaches the principal and says the node was not closed", async () => {
    const { close } = rig(() => ({ code: 1, stdout: "", stderr: "Close refused: node 31 is already closed.\n\nNothing was written, and no probe ran.\n" }));
    expect(await close.create(request({ node: "example/app#31", resolution: "Done." }))).toEqual({ state: "failed", error: "Close refused: node 31 is already closed. The node was not closed." });
  });

  test("an unticked repository, a malformed node or an empty text is refused before soma runs", async () => {
    const { ruling, close, calls } = rig();
    expect(await ruling.create(request({ node: "other/repo#3", text: "D1" }))).toEqual({ state: "failed", error: "This conversation may not write to github:github.com/other/repo. Nothing was recorded." });
    expect(await ruling.create(request({ node: "#3", text: "D1" }))).toMatchObject({ state: "failed" });
    expect(await ruling.create(request({ node: "example/app#31", text: "  " }))).toEqual({ state: "failed", error: "Write the ruling to record. Nothing was recorded." });
    expect(await close.create(request({ node: "example/app#31", gist: "x" }))).toEqual({ state: "failed", error: "Write the resolution the node closes with. The node was not closed." });
    expect(calls).toHaveLength(0);
  });

  test("readback finds a ruling by its exact operation, allows a close retry only while the node is open, and cannot credit a closed node to this close", async () => {
    let body = "## Rulings\n";
    let status = "open";
    const { ruling, close, calls } = rig(argv => argv[2] === "node" ? { code: 0, stdout: JSON.stringify({ status, body }), stderr: "" } : { code: 0, stdout: "{}", stderr: "" });
    await ruling.create(request({ node: "example/app#31", text: "D1" }, "op-r"));
    expect(await ruling.readback(operation("op-r"))).toEqual({ found: false });
    body += "- 2026-11-09 (jc): earlier\n  Filed from conversation conv-8, operation op-r2.\n";
    expect(await ruling.readback(operation("op-r"))).toEqual({ found: false });
    const sent = calls.find(c => c.argv[2] === "rule")?.file ?? "";
    const [first = "", ...rest] = sent.trimEnd().split("\n");
    body += [`- 2026-11-10 10:00 (jc): ${first}`, ...rest.map(line => line ? `  ${line}` : "")].join("\n");
    expect(await ruling.readback(operation("op-r"))).toEqual({ found: true, canonicalId: "example/app#31", url: "https://github.com/example/app/issues/31" });
    await close.create(request({ node: "example/app#31", resolution: "Done." }, "op-c"));
    expect(await close.readback(operation("op-c"))).toEqual({ found: false });
    status = "closed";
    expect(await close.readback(operation("op-c"))).toBeNull();
    expect(calls.filter(c => c.argv[2] === "node").every(c => c.argv.join(" ") === `${SOMA} graph node 31 --repo ${REPO} --json`)).toBe(true);
    expect(await ruling.readback(operation("never-ran"))).toBeNull();
  });

  test("with soma configured, a conversation lists the ruling and the close as ready", () => {
    const db = initDatabase(":memory:"); databases.push(db);
    const listed = capabilities(conversationSources({ db, desk: () => DESK }).writers ?? {});
    const byType = new Map(listed.map(c => [c.type, c.status]));
    expect(byType.get("graph-ruling")).toBe("ready");
    expect(byType.get("graph-close")).toBe("ready");
    const without = capabilities(conversationSources({ db, desk: () => ({ ...DESK, somaBin: undefined }) }).writers ?? {});
    expect(new Map(without.map(c => [c.type, c.status])).get("graph-close")).toBe("blocked:3457");
  });
});
