import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreatableType } from "../../../conversations/catalog";
import type { ProposalView } from "../../../conversations/creation";
import type { CreateRequest, OperationRecord } from "../../../conversations/types";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources, studioRequestId } from "../desk/conversation-sources";
import { parseThreadFile } from "../desk/studio/format";
import type { GitRunner } from "../desk/studio/git";
import { conversationWriterRig, type ConversationWriterReply } from "./conversation-writer-rig";

export const gitAt = (dir: string) => (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

export type StudioThreadState = "active" | "parked" | "closed";

export const studioThreadFile = (state: StudioThreadState, slug: string): string => `---
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

interface StudioReply extends Omit<ConversationWriterReply, "types"> { types: { type: string; status: string; fields: { name: string; required: boolean; destination?: boolean }[] }[] }

function studioRepo(prefix: string, threads: Record<string, StudioThreadState>): { dir: string; git: (...args: string[]) => string; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = gitAt(dir);
  for (const folder of ["threads", "inbox", "proposals"]) mkdirSync(join(dir, folder));
  for (const [slug, state] of Object.entries(threads)) writeFileSync(join(dir, `threads/${slug}.md`), studioThreadFile(state, slug));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.org");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return { dir, git, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface StudioRigOptions { studio?: boolean; git?: GitRunner; maxActive?: number }

export function studioConversationRig(prefix: string, type: CreatableType, threads: Record<string, StudioThreadState>) {
  const writerRig = conversationWriterRig(prefix, `ai.meta-factory.cortex.${prefix.replace(/-+$/, "")}-test`);
  return async (options: StudioRigOptions = {}) => {
    const repo = studioRepo(prefix, threads);
    const db = writerRig.database();
    const desk: DeskOptions = {
      enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [],
      areas: [{ id: "lab", label: "Lab", color: "#7c3aed", repos: [], goals: [], policy: "local" }],
      ...(options.studio === false ? {} : { studio: { dir: repo.dir, maxActive: options.maxActive ?? 5 } }),
    };
    const runtime: DeskRuntime = { ledger: new HandledLedger(), options: desk };
    const { host, call, start, propose, confirm, check } = await writerRig.open<StudioReply>(db, runtime);
    const sources = conversationSources({ db, desk: () => desk, ...(options.git ? { git: options.git } : {}) });
    await host.attachSources(sources);
    const id = await start(`Synthetic ${type}`);
    const submit = async (fields: Record<string, string>) => {
      const view = await propose(id, type, fields);
      return { view, reply: await confirm(id, view) };
    };
    const parsed = (slug: string) => {
      const p = parseThreadFile(`threads/${slug}.md`, readFileSync(join(repo.dir, `threads/${slug}.md`), "utf8"));
      if (!p.ok) throw new Error(p.reason);
      return p.value;
    };
    const writer = () => {
      const found = sources.writers?.[type];
      if (!found) throw new Error(`no ${type} writer`);
      return found;
    };
    const commits = (): string[] => repo.git("log", "--format=%H").trim().split("\n");
    const created = (reply: { status: number; body: StudioReply }): OperationRecord => {
      expect(reply.status).toBe(200);
      expect(reply.body.proposal.feedback).toBe("created");
      const operation = operationOf(reply.body.proposal);
      expect(operation.canonicalId).toBe(commits()[0] ?? "");
      expect(repo.git("log", "-n", "1", "--format=%B")).toContain(`Desk-Request: ${studioRequestId(operation.operationId)}`);
      return operation;
    };
    const confirmedAgain = async (view: ProposalView, operation: OperationRecord): Promise<void> => {
      const again = await confirm(id, view);
      expect(again.status).toBe(200);
      expect(operationOf(again.body.proposal)).toMatchObject({ operationId: operation.operationId, canonicalId: operation.canonicalId, state: "created" });
      expect(commits()).toHaveLength(2);
    };
    const replayed = async (fields: Record<string, string>): Promise<void> => {
      const request = directRequest(type, fields);
      const first = await writer().create(request);
      expect(first).toMatchObject({ state: "created" });
      expect(await writer().create(request)).toEqual(first);
      expect(commits()).toHaveLength(2);
      expect(await writer().readback({ operationId: request.operationId } as OperationRecord)).toEqual({ found: true, canonicalId: commits()[0] ?? "" });
      expect(await writer().readback({ operationId: "conv-1:proposal-1:2" } as OperationRecord)).toEqual({ found: false });
    };
    return {
      id, repo, submit, writer, parsed, commits, created, confirmedAgain, replayed,
      confirm: (view: ProposalView) => confirm(id, view),
      check: (view: ProposalView) => check(id, view),
      threads: (): string[] => readdirSync(join(repo.dir, "threads")).sort(),
      types: async () => (await call("GET", "/api/conversations/capabilities")).body.types,
      status: async (of: string) => (await call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === of)?.status,
    };
  };
}

export const operationOf = (view: ProposalView): OperationRecord => {
  if (!view.operation) throw new Error("no operation");
  return view.operation;
};

export const failureOf = (view: ProposalView): string => view.operation?.history.at(-1)?.detail ?? "";

export function directRequest(type: CreatableType, fields: Record<string, string>): CreateRequest {
  const operationId = "conv-1:proposal-1:1";
  return {
    operationId, type, fields, activation: "none", signal: new AbortController().signal,
    provenance: { conversationId: "conv-1", proposalId: "proposal-1", revision: 1, operationId, entryId: null, link: "?desk=conversation&conversation=conv-1" },
  };
}
