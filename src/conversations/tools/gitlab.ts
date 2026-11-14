import { z } from "zod/v4";
import { ProjectSchema, type ToolProject } from "../../common/types/desk-conversations";
import { runCommand, type CommandResult } from "../../surface/mc/common/spawn";
import { SourceId, type ToolDefinition } from "./capabilities";

export type GitlabRunner = (argv: string[], timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;
export interface GitlabToolOptions { run?: GitlabRunner; now?: () => Date; requestTimeoutMs?: number }
interface Target { host: string; repo: string; path: string; url: string }
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Page = z.number().int().min(1).max(20).default(1);
const Kind = z.enum(["issue", "mr"]);
const Paging = { page: Page, perPage: z.number().int().min(1).max(10).default(5) };
const ItemInput = z.object({ project: SourceId, kind: Kind, number: Id }).strict();
const MrInput = z.object({ project: SourceId, number: Id, ...Paging }).strict();
const Metadata = z.object({ id: Id, path_with_namespace: z.string(), web_url: z.string(), visibility: z.enum(["private", "internal", "public"]), description: z.string().nullable().optional(), default_branch: z.string().nullable().optional(), archived: z.boolean().optional() });
const Item = z.object({ iid: Id, project_id: Id, web_url: z.string(), title: z.string(), state: z.string(), description: z.string().nullable().optional(), updated_at: z.string().optional(), sha: Sha.nullable().optional(), head_pipeline: z.object({ id: Id }).nullable().optional() });
const Note = z.object({ id: Id, body: z.string(), author: z.object({ username: z.string() }), created_at: z.string(), project_id: Id.optional(), noteable_iid: Id.optional(), resolved: z.boolean().optional() });
const Discussion = z.object({ id: z.string(), notes: z.array(Note).max(1000) });
const Change = z.object({ old_path: z.string(), new_path: z.string(), diff: z.string().optional(), collapsed: z.boolean().optional(), too_large: z.boolean().optional(), new_file: z.boolean().optional(), deleted_file: z.boolean().optional() });
const Commit = z.object({ id: Sha, title: z.string(), web_url: z.string(), committed_date: z.string() });
const Pipeline = z.object({ id: Id, sha: Sha, web_url: z.string(), status: z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"]), project_id: Id.optional(), updated_at: z.string().optional() });
const Job = z.object({ id: Id, name: z.string(), status: z.string(), stage: z.string(), web_url: z.string(), pipeline: z.object({ id: Id, project_id: Id, sha: Sha }), commit: z.object({ id: Sha }) });
const clip = (text: string | null | undefined, limit = 1500): string => text && text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text ?? "";

class ReadFailure extends Error {
  constructor(readonly status: string, message: string) { super(message); }
}
export function gitlabTarget(project: ToolProject): Target | string {
  if (!ProjectSchema.safeParse(project).success || project.forge?.kind !== "gitlab") return "A valid GitLab project must be configured for this source.";
  const host = (project.forge.host ?? "gitlab.com").toLowerCase();
  const repo = project.forge.repo;
  try {
    const url = new URL(`https://${host}/${repo}`);
    if (url.host !== host || url.pathname !== `/${repo}` || !host.split(":")[0]?.split(".").every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return "The configured GitLab host or project is invalid.";
  } catch { return "The configured GitLab host or project is invalid."; }
  return { host, repo, path: `projects/${encodeURIComponent(repo)}`, url: `https://${host}/${repo}` };
}
const classify = (result: CommandResult): ReadFailure => {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/401|not logged|no accounts|not authenticated|auth login|unauthorized|invalid token/i.test(text)) return new ReadFailure("login-required", "The configured host has no usable GitLab login.");
  if (/429|rate.limit/i.test(text)) return new ReadFailure("rate-limited", "GitLab rate limit reached; retry later.");
  if (/403|forbidden|access denied/i.test(text)) return new ReadFailure("permission-denied", "The GitLab owner denied this project read.");
  if (/ENOENT|not installed|command not found|no such file|unreachable|connection refused|no route|network|timeout|timed out|dial tcp|could not resolve/i.test(text) || result.code === 127) return new ReadFailure("unavailable", "The GitLab client or configured host is unavailable; no fallback was attempted.");
  if (/404|not found/i.test(text)) return new ReadFailure("not-found", "The item is missing or hidden from the GitLab owner.");
  return new ReadFailure("provider-failure", "GitLab could not complete the read.");
};
const requireIdentity = (matches: boolean): void => { if (!matches) throw new ReadFailure("identity-mismatch", "GitLab returned content outside the configured project or requested identity; it was withheld."); };
const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const result = schema.safeParse(data);
  if (!result.success) throw new ReadFailure("invalid-payload", "GitLab returned an invalid payload; content was withheld.");
  return result.data;
};
const itemPath = (kind: z.infer<typeof Kind>, number: number): string => `/${kind === "mr" ? "merge_requests" : "issues"}/${number}`;
const itemUrl = (target: Target, kind: z.infer<typeof Kind>, number: number): string => `${target.url}/-${itemPath(kind, number)}`;

export function createGitlabTools(options: GitlabToolOptions = {}): ToolDefinition[] {
  const run: GitlabRunner = options.run ?? ((argv, timeout, signal) => runCommand(argv, timeout, undefined, undefined, true, { maxOutputBytes: 1_000_000, signal }));
  const now = options.now ?? (() => new Date());
  const attempt = async (argv: string[], signal?: AbortSignal): Promise<CommandResult> => {
    try { return await run(argv, options.requestTimeoutMs ?? 10_000, signal); }
    catch { throw new ReadFailure("unavailable", "The GitLab client or configured host could not be reached; no fallback was attempted."); }
  };
  const get = async (target: Target, suffix: string, signal: AbortSignal, params: Record<string, string | number> = {}): Promise<unknown> => {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    const result = await attempt(["glab", "api", "--hostname", target.host, "--method", "GET", `${target.path}${suffix}${query ? `?${query}` : ""}`], signal);
    if (result.code !== 0) throw classify(result);
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw new ReadFailure("invalid-payload", "GitLab returned unreadable JSON; content was withheld."); }
  };
  const readItem = async (target: Target, projectId: number, kind: z.infer<typeof Kind>, number: number, signal: AbortSignal) => {
    const item = parse(Item, await get(target, itemPath(kind, number), signal));
    requireIdentity(item.project_id === projectId && item.iid === number && item.web_url === itemUrl(target, kind, number));
    if (kind === "mr" && !item.sha) throw new ReadFailure("invalid-payload", "GitLab returned no MR head SHA.");
    return item;
  };
  const ensureHead = (before: z.infer<typeof Item>, after: z.infer<typeof Item>): void => {
    if (before.sha !== after.sha) throw new ReadFailure("head-changed", "The MR head changed during the read; evidence was withheld. Read it again.");
  };
  const pageResult = (input: { page: number; perPage: number }, count: number) => ({ page: input.page, nextPage: count === input.perPage && input.page < 20 ? input.page + 1 : null, mayHaveMore: count === input.perPage, pageLimitReached: input.page === 20 && count === input.perPage });
  const define = <T extends { project: string }>(name: string, description: string, input: z.ZodType<T>, body: (input: T, target: Target, projectId: number, signal: AbortSignal, metadata: z.infer<typeof Metadata>) => Promise<object>): ToolDefinition => ({
    name, description, input, operation: "forge.read",
    dependency: project => { const target = gitlabTarget(project); return typeof target === "string" ? target : null; },
    provider: async project => {
      const target = gitlabTarget(project);
      if (typeof target === "string") return target;
      try {
        const result = await attempt(["glab", "auth", "status", "--hostname", target.host]);
        return result.code === 0 ? null : `${classify(result).status}: ${classify(result).message}`;
      } catch (error) { return error instanceof ReadFailure ? `${error.status}: ${error.message}` : "unavailable: GitLab client could not be reached."; }
    },
    run: async (raw, context) => {
      const target = context.project ? gitlabTarget(context.project) : "No configured GitLab project.";
      if (typeof target === "string") return { outcome: "refused", text: target };
      const outcome = (status: string, data: object) => {
        const provenance = { source: { host: target.host, project: target.repo, url: target.url }, fetchedAt: now().toISOString() };
        const text = JSON.stringify({ status, ...provenance, ...data });
        return text.length <= 18_000 ? text : JSON.stringify({ status: "result-too-large", ...provenance, message: "The result exceeded the bounded read size. Request a smaller page; content was withheld." });
      };
      try {
        const metadata = parse(Metadata, await get(target, "", context.signal));
        requireIdentity(metadata.path_with_namespace === target.repo && metadata.web_url === target.url);
        return outcome("ok", await body(raw as T, target, metadata.id, context.signal, metadata));
      } catch (error) {
        if (!(error instanceof ReadFailure)) throw error;
        return outcome(error.status, { message: error.message });
      }
    },
  });
  const project = define("gitlab_project", "Read configured GitLab project metadata, visibility and canonical URL.", z.object({ project: SourceId }).strict(), (_input, _target, _id, _signal, metadata) => Promise.resolve({ project: { ...metadata, description: clip(metadata.description, 500) } }));
  const search = define("gitlab_search", "Search a bounded page of issues or MRs within the configured GitLab project only. Text is a literal project search; nextPage continues.", z.object({ project: SourceId, kind: Kind, query: z.string().max(256).regex(/^[^\r\n\0]*$/).default(""), state: z.enum(["opened", "closed", "all"]).default("all"), ...Paging }).strict(), async (input, target, projectId, signal) => {
    const entries = parse(z.array(Item).max(input.perPage), await get(target, input.kind === "mr" ? "/merge_requests" : "/issues", signal, { search: input.query, state: input.state, scope: "all", page: input.page, per_page: input.perPage, order_by: "updated_at", sort: "desc" }));
    for (const item of entries) {
      requireIdentity(item.project_id === projectId && item.web_url === itemUrl(target, input.kind, item.iid));
      if (input.kind === "mr" && !item.sha) throw new ReadFailure("invalid-payload", "GitLab returned no MR head SHA.");
    }
    return { ...pageResult(input, entries.length), items: entries.map(item => ({ number: item.iid, title: clip(item.title, 300), state: item.state, url: item.web_url, updatedAt: item.updated_at, ...(item.sha ? { headSha: item.sha } : {}) })) };
  });
  const item = define("gitlab_item", "Read one authorized GitLab issue or MR. MRs include their observed head SHA.", ItemInput, async (input, target, projectId, signal) => {
    const data = await readItem(target, projectId, input.kind, input.number, signal);
    return { url: data.web_url, ...(input.kind === "mr" ? { headSha: data.sha } : {}), item: { number: data.iid, title: clip(data.title, 300), state: data.state, body: clip(data.description, 6000), updatedAt: data.updated_at } };
  });
  const discussions = define("gitlab_discussions", "Read a bounded page of issue or MR discussion threads with three notes per thread. notesPage continues within threads; linked content is never followed.", ItemInput.extend({ ...Paging, notesPage: Page }).strict(), async (input, target, projectId, signal) => {
    const before = await readItem(target, projectId, input.kind, input.number, signal);
    const threads = parse(z.array(Discussion).max(input.perPage), await get(target, `${itemPath(input.kind, input.number)}/discussions`, signal, { page: input.page, per_page: input.perPage }));
    for (const thread of threads) for (const note of thread.notes) requireIdentity((note.project_id === undefined || note.project_id === projectId) && (note.noteable_iid === undefined || note.noteable_iid === input.number));
    if (input.kind === "mr") ensureHead(before, await readItem(target, projectId, "mr", input.number, signal));
    const noteOffset = (input.notesPage - 1) * 3;
    return { url: before.web_url, ...(before.sha ? { headSha: before.sha } : {}), ...pageResult(input, threads.length), notesPage: input.notesPage, discussions: threads.map(thread => ({ id: clip(thread.id, 100), incomplete: input.notesPage > 1 || thread.notes.length > 3, nextNotesPage: thread.notes.length > noteOffset + 3 && input.notesPage < 20 ? input.notesPage + 1 : null, notesLimitReached: input.notesPage === 20 && thread.notes.length > noteOffset + 3, notes: thread.notes.slice(noteOffset, noteOffset + 3).map(note => ({ id: note.id, body: clip(note.body, 200), author: clip(note.author.username, 64), createdAt: clip(note.created_at, 40), resolved: note.resolved, url: `${before.web_url}#note_${note.id}` })) })) };
  });
  const mrPage = <T>(name: string, description: string, suffix: string, schema: z.ZodType<T>, convert: (entry: T, target: Target) => object) => define(name, description, MrInput, async (input, target, projectId, signal) => {
    const before = await readItem(target, projectId, "mr", input.number, signal);
    const entries = parse(z.array(schema).max(input.perPage), await get(target, `${itemPath("mr", input.number)}/${suffix}`, signal, { page: input.page, per_page: input.perPage }));
    const values = entries.map(entry => convert(entry, target));
    const after = await readItem(target, projectId, "mr", input.number, signal);
    ensureHead(before, after);
    if (suffix === "pipelines" && before.head_pipeline?.id !== after.head_pipeline?.id) throw new ReadFailure("state-changed", "The MR pipeline changed during the read; results were withheld.");
    return { url: before.web_url, headSha: before.sha, ...pageResult(input, entries.length), entries: values };
  });
  const changes = mrPage("gitlab_mr_changes", "Read a bounded page of MR file diffs pinned to its observed head SHA; collapsed, too-large and clipped diffs remain explicit.", "diffs", Change, entry => ({ oldPath: entry.old_path, newPath: entry.new_path, diff: clip(entry.diff, 1000), incomplete: entry.collapsed === true || entry.too_large === true || entry.diff === undefined || entry.diff.length > 1000, newFile: entry.new_file, deletedFile: entry.deleted_file }));
  const commits = mrPage("gitlab_mr_commits", "Read a bounded MR commit page, withholding evidence if its head changes.", "commits", Commit, (entry, target) => {
    requireIdentity(entry.web_url === `${target.url}/-/commit/${entry.id}`);
    return { sha: entry.id, title: clip(entry.title, 300), url: entry.web_url, committedAt: entry.committed_date };
  });
  const pipelines = mrPage("gitlab_pipelines", "Read a bounded MR pipeline page with each pipeline's SHA and status. These are observations, not an aggregate passing verdict.", "pipelines", Pipeline, (entry, target) => {
    requireIdentity(entry.web_url === `${target.url}/-/pipelines/${entry.id}`);
    return { id: entry.id, sha: entry.sha, status: entry.status, url: entry.web_url, updatedAt: entry.updated_at };
  });
  const jobs = define("gitlab_jobs", "Read a bounded job-status page for a pipeline at the MR's current head. Withhold results when the MR or pipeline changes; never read logs or artifacts.", MrInput.extend({ pipeline: Id }).strict(), async (input, target, projectId, signal) => {
    const before = await readItem(target, projectId, "mr", input.number, signal);
    const readPipeline = async () => {
      const data = parse(Pipeline, await get(target, `/pipelines/${input.pipeline}`, signal));
      requireIdentity(data.id === input.pipeline && data.project_id === projectId && data.web_url === `${target.url}/-/pipelines/${input.pipeline}`);
      return data;
    };
    const pipeline = await readPipeline();
    if (pipeline.sha !== before.sha) throw new ReadFailure("stale", "The pipeline describes another commit; job evidence was withheld.");
    const entries = parse(z.array(Job).max(input.perPage), await get(target, `/pipelines/${input.pipeline}/jobs`, signal, { page: input.page, per_page: input.perPage }));
    for (const entry of entries) requireIdentity(entry.pipeline.id === input.pipeline && entry.pipeline.project_id === projectId && entry.pipeline.sha === before.sha && entry.commit.id === before.sha && entry.web_url === `${target.url}/-/jobs/${entry.id}`);
    const after = await readPipeline();
    const mrAfter = await readItem(target, projectId, "mr", input.number, signal);
    ensureHead(before, mrAfter);
    if (after.sha !== pipeline.sha || after.status !== pipeline.status || after.updated_at !== pipeline.updated_at || before.head_pipeline?.id !== mrAfter.head_pipeline?.id) throw new ReadFailure("state-changed", "The pipeline changed during the read; job evidence was withheld. Read it again.");
    return { url: pipeline.web_url, headSha: before.sha, pipeline: { id: pipeline.id, status: pipeline.status }, ...pageResult(input, entries.length), jobs: entries.map(entry => ({ id: entry.id, name: clip(entry.name, 200), stage: clip(entry.stage, 100), status: entry.status, url: entry.web_url })) };
  });
  return [project, search, item, discussions, changes, commits, pipelines, jobs];
}
