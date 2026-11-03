import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { ProposalView } from "../../../conversations/creation";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { studioRequestId } from "../desk/conversation-ids";
import { conversationSources } from "../desk/conversation-sources";
import { WriterTimeout, type WriterResult } from "../desk/create";
import { setGraphRepositoryEnabled } from "../desk/graph-repositories";
import { conversationWriterRig, type ConversationWriterReply as Reply } from "./conversation-writer-rig";

const SOMA = "/opt/soma/bin/soma";
const DESK = "github:github.com/jcfischer/desk";
const GITLAB = "gitlab:gitlab.switch.ch/csoc/graph";
const writerRig = conversationWriterRig("conversation-graph-node-", "ai.meta-factory.cortex.graph-node-writer-test");
const ok = (data: unknown): WriterResult => ({ code: 0, stdout: JSON.stringify(data, null, 2), stderr: "" });
const refuse = (stderr: string): WriterResult => ({ code: 1, stdout: "", stderr });

interface Filed { node: string; repo: string; parent: string | null; body: string; args: string[] }

function fakeSoma() {
  const nodes = new Map<string, Filed>();
  const calls: string[][] = [];
  const files: string[] = [];
  let next = 7;
  let override: ((argv: string[]) => WriterResult | Promise<WriterResult>) | undefined;
  const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1] ?? "";
  const shown = (repo: string): string => (repo.startsWith("github:github.com/") ? repo.slice("github:github.com/".length) : repo);
  const add = (argv: string[], attach = true): WriterResult => {
    const marker = flag(argv, "--once");
    const repo = shown(flag(argv, "--repo"));
    const prior = nodes.get(marker);
    if (prior) return ok({ repo, node: prior.node, parent: prior.parent, blockedBy: [], existing: true });
    const path = flag(argv, "--body-file");
    files.push(path);
    const node = String(next++);
    nodes.set(marker, { node, repo, parent: attach ? argv[3] ?? "" : null, body: `${readFileSync(path, "utf8").trimEnd()}\n\n${marker}`, args: argv });
    if (!attach) return { code: 1, stdout: "", stderr: JSON.stringify({ repo, node, parent: argv[3], written: [], already: [], failed: [], attached: false, existing: false }, null, 2) };
    return ok({ repo, node, parent: argv[3], blockedBy: [], existing: false });
  };
  const chart = (argv: string[]): WriterResult => {
    const marker = flag(argv, "--once");
    const repo = shown(flag(argv, "--repo"));
    const prior = nodes.get(marker);
    if (prior) return ok({ repo, node: prior.node, existing: true });
    const path = flag(argv, "--body-file");
    files.push(path);
    const node = String(next++);
    nodes.set(marker, { node, repo, parent: null, body: `${readFileSync(path, "utf8").trimEnd()}\n\n${marker}`, args: argv });
    return ok({ repo, node, existing: false });
  };
  const file = (argv: string[]): WriterResult => (argv[2] === "chart" ? chart(argv) : add(argv));
  const report = (argv: string[]): WriterResult => {
    const hit = nodes.get(flag(argv, "--once"));
    return ok(hit ? { found: true, repo: hit.repo, node: hit.node, parent: hit.parent === null ? null : hit.parent.replace(/^.*#/, "") } : { found: false });
  };
  const run = async (argv: string[]): Promise<WriterResult> => {
    calls.push(argv);
    if (argv.includes("--dry-run")) return report(argv);
    if (override) return override(argv);
    return file(argv);
  };
  return { nodes, calls, files, run, add, file, answerNext: (reply: typeof override) => { override = reply; } };
}

async function rig(somaBin: string | null = SOMA, allowed: string[] = [DESK], type: "graph-node" | "graph-map" = "graph-node") {
  const db = writerRig.database();
  for (const ref of allowed) setGraphRepositoryEnabled(db, ref, true, 1);
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(somaBin ? { somaBin } : {}) };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const rig = await writerRig.open<Reply>(db, runtime);
  const soma = fakeSoma();
  await rig.host.attachSources(conversationSources({ db, desk: () => options, runGraph: soma.run }));
  const id = await rig.start(`Synthetic ${type}`, "cloud");
  const propose = (fields: Record<string, string>) => rig.propose(id, type, fields);
  const confirm = (view: ProposalView) => rig.confirm(id, view);
  const check = (view: ProposalView) => rig.check(id, view);
  const capability = async () => (await rig.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === type);
  return { id, options, soma, propose, confirm, check, capability };
}

const PROBE = { repository: DESK, parent: "jcfischer/desk#1", title: "Ivy probe 0a1b", body: "Ivy probe 0a1b", checkpoint: "ivy-probe-0a1b" };
const MAP = { repository: DESK, title: "Ivy probe map 0a1b", body: "Ivy probe map 0a1b", checkpoint: "ivy-probe-map-0a1b" };
const operationIdOf = (view: ProposalView): string => view.operation?.operationId ?? "";
const markerOf = (view: ProposalView): string => `<!-- conversation-operation ${studioRequestId(operationIdOf(view))} -->`;
const forbidden = (argv: string[]): boolean => argv.includes("claim") || argv.includes("close");
const adds = (calls: string[][]): string[][] => calls.filter(argv => !argv.includes("--dry-run"));
const timedOut = (): Promise<WriterResult> => Promise.reject(new WriterTimeout("timed out after 28 s"));

interface WriterCase {
  type: "graph-node" | "graph-map";
  blocker: string;
  fields: Record<string, string>;
  fieldNames: string[];
  chosen: Record<string, string>;
  argv: (file: string, marker: string) => string[];
  existing: Record<string, unknown>;
}

const CASES: WriterCase[] = [
  {
    type: "graph-node",
    blocker: "blocked:3033",
    fields: PROBE,
    fieldNames: ["repository", "parent", "title", "body", "checkpoint", "dependencies", "autonomy", "kind"],
    chosen: { dependencies: "jcfischer/desk#2, jcfischer/desk#3", autonomy: "propose", kind: "build" },
    argv: (file, marker) => [
      SOMA, "graph", "add", "jcfischer/desk#1", "--repo", DESK, "--title", "Ivy probe 0a1b", "--autonomy", "propose", "--kind", "build", "--label", "ivy:conversation",
      "--checkpoint", "ivy-probe-0a1b", "--body-file", file, "--blocked-by", "jcfischer/desk#2", "--blocked-by", "jcfischer/desk#3", "--once", marker, "--json",
    ],
    existing: { repo: "jcfischer/desk", node: "42", parent: "1", blockedBy: [], existing: true },
  },
  {
    type: "graph-map",
    blocker: "blocked:3034",
    fields: MAP,
    fieldNames: ["repository", "title", "body", "checkpoint", "autonomy", "serves"],
    chosen: { autonomy: "propose", serves: "G5" },
    argv: (file, marker) => [
      SOMA, "graph", "chart", "--repo", DESK, "--title", "Ivy probe map 0a1b", "--autonomy", "propose", "--checkpoint", "ivy-probe-map-0a1b", "--label", "ivy:conversation",
      "--serves", "G5", "--body-file", file, "--once", marker, "--json",
    ],
    existing: { repo: "jcfischer/desk", node: "42", existing: true },
  },
];

describe.each(CASES)("$type writer for conversation proposals", c => {
  const open = (allowed: string[] = [DESK], somaBin: string | null = SOMA) => rig(somaBin, allowed, c.type);

  test("the type is ready only with soma configured on an enabled Desk, with the ruled fields", async () => {
    const ready = await open();
    const capability = await ready.capability();
    expect([capability?.status, capability?.fields.map(f => f.name)]).toEqual(["ready", c.fieldNames]);
    ready.options.enabled = false;
    expect((await ready.capability())?.status).toBe(c.blocker);
    expect((await (await open([DESK], null)).capability())?.status).toBe(c.blocker);
  });

  test("a confirmed proposal calls soma with exactly the owner argv, and the identical confirm writes nothing more", async () => {
    const r = await open();
    const view = await r.propose({ ...c.fields, ...c.chosen });
    const first = await r.confirm(view);
    expect([first.status, first.body.proposal.feedback]).toEqual([200, "created"]);
    expect(first.body.proposal.operation).toMatchObject({ canonicalId: "jcfischer/desk#7", url: "https://github.com/jcfischer/desk/issues/7" });
    const marker = markerOf(first.body.proposal);
    const [file = ""] = r.soma.files;
    expect(r.soma.calls).toEqual([c.argv(file, marker)]);
    expect(existsSync(file)).toBe(false);
    expect(r.soma.nodes.get(marker)?.body).toBe(`${c.fields.body ?? ""}\n\nFiled from Ivy conversation ${r.id}, operation ${operationIdOf(first.body.proposal)}.\n\n${marker}`);
    const again = await r.confirm(view);
    expect([again.status, again.body.proposal.operation?.canonicalId]).toEqual([200, "jcfischer/desk#7"]);
    expect(adds(r.soma.calls)).toHaveLength(1);
    expect(r.soma.calls.some(forbidden)).toBe(false);
  });

  test("what soma already holds under the marker is the created object, and nothing new is written", async () => {
    const r = await open();
    r.soma.answerNext(() => ok(c.existing));
    const reply = await r.confirm(await r.propose(c.fields));
    expect([reply.status, reply.body.proposal.feedback, reply.body.proposal.operation?.canonicalId]).toEqual([200, "created", "jcfischer/desk#42"]);
    expect(r.soma.nodes.size).toBe(0);
  });

  test("a repository not ticked in Settings fails with 409 before soma runs", async () => {
    const r = await open([]);
    const refused = await r.confirm(await r.propose(c.fields));
    expect([refused.status, refused.body.proposal.feedback, refused.body.error]).toEqual([409, "failed", `This conversation may not file to ${DESK}. Nothing was created.`]);
    expect(r.soma.calls).toEqual([]);
  });

  test("auto autonomy is refused before soma runs, and absent or blank autonomy is approve", async () => {
    const r = await open();
    const auto = await r.confirm(await r.propose({ ...c.fields, autonomy: "auto" }));
    expect([auto.status, auto.body.error]).toEqual([409, "A conversation may file only approve or propose nodes. Nothing was created."]);
    expect(r.soma.calls).toEqual([]);
    for (const blank of [{} as Record<string, string>, { autonomy: "" }, { autonomy: "  " }]) await r.confirm(await r.propose({ ...c.fields, ...blank }));
    expect(r.soma.calls.map(argv => argv[argv.indexOf("--autonomy") + 1])).toEqual(["approve", "approve", "approve"]);
  });

  test("an uncertain operation whose object exists is created by Check, which only asks with --dry-run", async () => {
    const r = await open();
    r.soma.answerNext(argv => {
      r.soma.file(argv);
      return timedOut();
    });
    const view = await r.propose(c.fields);
    expect((await r.confirm(view)).body.proposal.feedback).toBe("uncertain");
    r.soma.answerNext(undefined);
    const checked = await r.check(view);
    expect([checked.body.proposal.feedback, checked.body.proposal.operation?.canonicalId]).toEqual(["created", "jcfischer/desk#7"]);
    const last = r.soma.calls.at(-1) ?? [];
    expect([last.slice(0, 3), last.at(-1), last.includes("--body-file")]).toEqual([[SOMA, "graph", c.type === "graph-map" ? "chart" : "add"], "--dry-run", false]);
    expect(adds(r.soma.calls)).toHaveLength(1);
  });

  test("Check fails an uncertain operation only when soma proves nothing carries the marker", async () => {
    const r = await open();
    r.soma.answerNext(timedOut);
    const view = await r.propose(c.fields);
    expect((await r.confirm(view)).body.proposal.feedback).toBe("uncertain");
    expect((await r.check(view)).body.proposal.feedback).toBe("failed");
  });
});

describe("graph node writer specifics", () => {
  test("absent, empty or blank kind files a grilling node, and an unknown kind is refused before soma runs", async () => {
    const r = await rig();
    for (const blank of [{} as Record<string, string>, { kind: "" }, { kind: " " }]) await r.confirm(await r.propose({ ...PROBE, ...blank }));
    expect(r.soma.calls.map(argv => argv[argv.indexOf("--kind") + 1])).toEqual(["grilling", "grilling", "grilling"]);
    const kind = await r.confirm(await r.propose({ ...PROBE, kind: "epic" }));
    expect([kind.status, kind.body.error]).toEqual([409, "A conversation may file only research, grilling, prototype, task or build nodes. Nothing was created."]);
    expect(r.soma.calls).toHaveLength(3);
  });

  test("a parent or dependency shaped like an option is refused before soma runs", async () => {
    const r = await rig();
    for (const fields of [{ parent: "--autonomy=auto" } as Record<string, string>, { dependencies: "jcfischer/desk#2 --repo=other/x" }]) {
      const refused = await r.confirm(await r.propose({ ...PROBE, ...fields }));
      expect([refused.status, refused.body.error]).toEqual([409, "The parent and the dependencies must be node references, not options. Nothing was created."]);
    }
    expect(r.soma.calls).toEqual([]);
  });

  test("a node soma created but did not attach leaves the operation uncertain, and Check stays uncertain", async () => {
    const r = await rig();
    r.soma.answerNext(argv => r.soma.add(argv, false));
    const view = await r.propose(PROBE);
    const confirmed = await r.confirm(view);
    expect(confirmed.body.proposal.feedback).toBe("uncertain");
    expect(JSON.stringify(confirmed.body.proposal.operation?.history)).toContain("soma made node 7 but did not attach it");
    expect((await r.check(view)).body.proposal.feedback).toBe("uncertain");
    expect(r.soma.calls.at(-1)).toContain("--dry-run");
    expect(adds(r.soma.calls)).toHaveLength(1);
  });

  test("a node found under another parent cannot be told apart, so Check stays uncertain", async () => {
    const r = await rig();
    r.soma.answerNext(argv => {
      r.soma.add(argv);
      const filed = [...r.soma.nodes.values()][0];
      if (filed) filed.parent = "jcfischer/desk#99";
      return timedOut();
    });
    const view = await r.propose(PROBE);
    await r.confirm(view);
    expect((await r.check(view)).body.proposal.feedback).toBe("uncertain");
  });

  test("any other soma refusal fails with soma's last stderr line", async () => {
    const r = await rig();
    r.soma.answerNext(() => refuse("soma graph add: resolving parent\nNode jcfischer/desk#1 is closed; reopen it before adding under it."));
    const refused = await r.confirm(await r.propose(PROBE));
    expect([refused.status, refused.body.error]).toEqual([409, "Node jcfischer/desk#1 is closed; reopen it before adding under it. Nothing was created."]);
  });

  test("a GitLab repository is passed to soma verbatim", async () => {
    const r = await rig(SOMA, [GITLAB]);
    const reply = await r.confirm(await r.propose({ ...PROBE, repository: GITLAB, parent: "csoc/graph#12" }));
    expect([reply.status, reply.body.proposal.operation?.canonicalId]).toEqual([200, `${GITLAB}#7`]);
    const [argv = []] = r.soma.calls;
    expect(argv.slice(0, 6)).toEqual([SOMA, "graph", "add", "csoc/graph#12", "--repo", GITLAB]);
    expect(argv[argv.indexOf("--label") + 1]).toBe("ivy:conversation");
  });
});

describe("graph map writer specifics", () => {
  const mapRig = (allowed: string[] = [DESK]) => rig(SOMA, allowed, "graph-map");

  test("without serves the argv has no --serves, and a serves value that is not a goal is refused before soma runs", async () => {
    const r = await mapRig();
    await r.confirm(await r.propose(MAP));
    expect(r.soma.calls[0]).not.toContain("--serves");
    const serves = await r.confirm(await r.propose({ ...MAP, serves: "--repo=other/x" }));
    expect([serves.status, serves.body.error]).toEqual([409, "A map may serve only a goal written as G<n>, such as G5. Nothing was created."]);
    expect(r.soma.calls).toHaveLength(1);
  });

  test("a GitLab repository is passed verbatim with the project itself as --home-project", async () => {
    const r = await mapRig([GITLAB]);
    const reply = await r.confirm(await r.propose({ ...MAP, repository: GITLAB }));
    expect([reply.status, reply.body.proposal.operation?.canonicalId]).toEqual([200, `${GITLAB}#7`]);
    const [argv = []] = r.soma.calls;
    expect(argv.slice(0, 7)).toEqual([SOMA, "graph", "chart", "--repo", GITLAB, "--home-project", "csoc/graph"]);
  });
});
