import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProposalView } from "../../../conversations/creation";
import type { CreateRequest, OperationRecord } from "../../../conversations/types";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources, studioRequestId } from "../desk/conversation-sources";
import { parseThreadFile } from "../desk/studio/format";
import { spawnGit, type GitRunner } from "../desk/studio/git";
import { conversationWriterRig } from "./conversation-writer-rig";

const writerRig = conversationWriterRig("conversation-studio-response-", "ai.meta-factory.cortex.studio-response-writer-test");

const thread = (state: string, slug: string): string => `---
type: question
areas: [lab]
state: ${state}
opened: 2026-10-01
${state === "closed" ? "closed: 2026-10-05\noutcome: dropped\n" : ""}---

## Question

What about ${slug}?

## Where I stand

Not settled.
${state === "closed" ? "\n## Outcome\n\nNot worth it.\n" : ""}
## Log

- 2026-10-01: Opened
`;

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string }; types: { type: string; status: string }[] }

function studioRepo(): { dir: string; git: (...args: string[]) => string; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "studio-response-"));
  const git = (...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };
  mkdirSync(join(dir, "threads"));
  mkdirSync(join(dir, "inbox"));
  mkdirSync(join(dir, "proposals"));
  writeFileSync(join(dir, "threads/alpha.md"), thread("active", "alpha"));
  writeFileSync(join(dir, "threads/gamma.md"), thread("parked", "gamma"));
  writeFileSync(join(dir, "threads/omega.md"), thread("closed", "omega"));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.org");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return { dir, git, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

async function rig(options: { studio?: boolean; git?: GitRunner } = {}) {
  const repo = studioRepo();
  const db = writerRig.database();
  const desk: DeskOptions = {
    enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [],
    areas: [{ id: "lab", label: "Lab", color: "#7c3aed", repos: [], goals: [], policy: "local" }],
    ...(options.studio === false ? {} : { studio: { dir: repo.dir, maxActive: 5 } }),
  };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options: desk };
  const { host, call, start, propose, confirm, check } = await writerRig.open<Reply>(db, runtime);
  const sources = conversationSources({ db, desk: () => desk, ...(options.git ? { git: options.git } : {}) });
  await host.attachSources(sources);
  const id = await start("Synthetic Studio response");
  const submit = async (fields: Record<string, string>) => {
    const view = await propose(id, "studio-response", fields);
    return { view, reply: await confirm(id, view) };
  };
  const parsed = (slug: string) => {
    const p = parseThreadFile(`threads/${slug}.md`, readFileSync(join(repo.dir, `threads/${slug}.md`), "utf8"));
    if (!p.ok) throw new Error(p.reason);
    return p.value;
  };
  const commits = (): string[] => repo.git("log", "--format=%H").trim().split("\n");
  const types = async () => (await call("GET", "/api/conversations/capabilities")).body.types;
  return { id, repo, sources, submit, confirm: (view: ProposalView) => confirm(id, view), check: (view: ProposalView) => check(id, view), parsed, commits, types };
}

const operationOf = (view: ProposalView): OperationRecord => {
  if (!view.operation) throw new Error("no operation");
  return view.operation;
};

describe("Studio response writer", () => {
  test("adds the response to an active thread once, returns the commit and names the conversation in the log", async () => {
    const r = await rig();
    try {
      const { view, reply } = await r.submit({ thread: "alpha", text: "Lead with the Studio." });
      expect(reply.status).toBe(200);
      expect(reply.body.proposal.feedback).toBe("created");
      const operation = operationOf(reply.body.proposal);
      const [head] = r.commits();
      expect(operation.canonicalId).toBe(head);
      expect(r.repo.git("log", "-n", "1", "--format=%B")).toContain(`Desk-Request: ${studioRequestId(operation.operationId)}`);
      const t = r.parsed("alpha");
      expect(t.responses.map(x => x.text)).toEqual(["Lead with the Studio."]);
      expect(t.log.at(-1)?.text).toBe(`Answered Ivy from Ivy conversation ?desk=conversation&conversation=${r.id}`);

      const again = await r.confirm(view);
      expect(again.status).toBe(200);
      expect(operationOf(again.body.proposal)).toMatchObject({ operationId: operation.operationId, canonicalId: operation.canonicalId, state: "created" });
      expect(r.parsed("alpha").responses).toHaveLength(1);
      expect(r.commits()).toHaveLength(2);
    } finally { r.repo.clean(); }
  });

  test("replays the earlier commit when the writer is called again for the same operation", async () => {
    const r = await rig();
    try {
      const writer = r.sources.writers?.["studio-response"];
      if (!writer) throw new Error("no studio-response writer");
      const request: CreateRequest = {
        operationId: "conv-1:proposal-1:1", type: "studio-response", fields: { thread: "gamma", text: "Parked, but still mine." }, activation: "none", signal: new AbortController().signal,
        provenance: { conversationId: "conv-1", proposalId: "proposal-1", revision: 1, operationId: "conv-1:proposal-1:1", entryId: null, link: "?desk=conversation&conversation=conv-1" },
      };
      const first = await writer.create(request);
      const second = await writer.create(request);
      expect(first).toMatchObject({ state: "created" });
      expect(second).toEqual(first);
      expect(r.parsed("gamma").responses).toHaveLength(1);
      expect(r.commits()).toHaveLength(2);
      const operation = { operationId: request.operationId } as OperationRecord;
      expect(await writer.readback(operation)).toEqual({ found: true, canonicalId: r.commits()[0] ?? "" });
      expect(await writer.readback({ operationId: "conv-1:proposal-1:2" } as OperationRecord)).toEqual({ found: false });
    } finally { r.repo.clean(); }
  });

  test("refuses a thread that does not exist or is closed, and writes nothing", async () => {
    const r = await rig();
    try {
      const missing = await r.submit({ thread: "no-such-thread", text: "Hello?" });
      expect(missing.reply.status).toBe(409);
      expect(missing.reply.body.proposal.feedback).toBe("failed");
      const error = missing.reply.body.proposal.operation?.history.at(-1)?.detail ?? "";
      expect(error).toContain("no-such-thread");
      expect(error.endsWith("Nothing was created.")).toBe(true);

      const closed = await r.submit({ thread: "omega", text: "Too late." });
      expect(closed.reply.status).toBe(409);
      expect(closed.reply.body.proposal.operation?.history.at(-1)?.detail).toBe("“What about omega” is closed. Nothing was created.");

      const long = await r.submit({ thread: "alpha", text: "x".repeat(4001) });
      expect(long.reply.body.proposal.operation?.history.at(-1)?.detail).toBe("The response is longer than 4000 characters. Nothing was created.");
      expect(r.commits()).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("leaves an owner failure that may have committed uncertain, and Check settles it from the Desk-Request trailer", async () => {
    const failingCommit: GitRunner = (args, cwd) => args[0] === "commit" ? Promise.resolve({ code: 1, stdout: "", stderr: "disk full" }) : spawnGit(args, cwd);
    const r = await rig({ git: failingCommit });
    try {
      const { view, reply } = await r.submit({ thread: "alpha", text: "Lead with the Studio." });
      expect(reply.body.proposal.feedback).toBe("uncertain");
      const checked = await r.check(view);
      expect(checked.body.proposal.feedback).toBe("failed");
      expect(r.commits()).toHaveLength(1);
      expect(r.parsed("alpha").responses).toHaveLength(0);
    } finally { r.repo.clean(); }
  });

  test("lists studio-response as ready and studio-close as blocked by its own build, without studio-outcome", async () => {
    const r = await rig();
    const bare = await rig({ studio: false });
    try {
      const statuses = new Map((await r.types()).map(t => [t.type, t.status]));
      expect(statuses.has("studio-outcome")).toBe(false);
      expect(statuses.get("studio-response")).toBe("ready");
      expect(statuses.get("studio-close")).toBe("blocked:3139");
      expect(new Map((await bare.types()).map(t => [t.type, t.status])).get("studio-response")).toBe("blocked:3138");
    } finally {
      r.repo.clean();
      bare.repo.clean();
    }
  });
});
