import { realpathSync } from "node:fs";
import { z } from "zod/v4";
import type { ToolOutcome } from "../model";
import type { ToolContext, ToolDefinition } from "./capabilities";
import { redactToolText } from "./output";
import { GitFailure, GitReader, type GitReadOptions } from "./repository-git-runner";
import { fileFailure, RepositoryFailure, RepositoryPaths } from "./repository-paths";

const Ref = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]{0,3}){0,4}$/).refine(ref => !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.includes("/../"));
const hasControl = (text: string, allowWhitespace: boolean): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && !(allowWhitespace && (code === 9 || code === 10 || code === 13)) || code === 127) return true;
  }
  return false;
};
const Path = z.string().min(1).max(512).refine(path => !path.startsWith("/") && !path.includes("\\") && !hasControl(path, false) && !path.split("/").includes(".."));
const Project = { project: z.string() };
const Basic = z.object(Project).strict();
const History = z.object({ ...Project, ref: Ref.default("HEAD"), path: Path.optional(), limit: z.number().int().min(1).max(30).default(10) }).strict();
const Show = z.object({ ...Project, ref: Ref.default("HEAD"), path: Path.optional() }).strict();
const Diff = z.object({ ...Project, kind: z.enum(["unstaged", "staged", "working", "committed"]).default("working"), from: Ref.optional(), to: Ref.optional(), path: Path.optional() }).strict().refine(args => args.kind === "committed" ? args.from !== undefined && args.to !== undefined : args.from === undefined && args.to === undefined);
const SAFE_DIFF = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--no-color"];
const OUTPUT_CHARS = 12_000;
const SAFE_MODE = new Set(["000000", "100644", "100755"]);
type Operation = "status" | "head" | "worktrees" | "log" | "show" | "diff";
interface Args { project: string; ref?: string; path?: string; limit?: number; kind?: z.infer<typeof Diff>["kind"]; from?: string; to?: string }
interface Change { path: string; index: string; workingTree: string; tracked: boolean }
interface Commit { revision: string; parents: string[]; committedAt: string; subject: string; paths: string[] }

const scrub = (text: string): string => redactToolText(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|\b[^\s/@:<>"']+@[^\s/:<>"']+:[^\s<>"']+/gi, value => {
  if (!value.includes("://") || /:\/\/[^\s/]*@/.test(value)) return "[redacted-remote]";
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return `${url.protocol}//${url.host}/[redacted-remote]`;
    return value;
  } catch { return "[redacted-remote]"; }
});
const pathArgs = (path?: string): string[] => ["--", ...(path ? [path] : [])];
const sha = (value: string): string => {
  const result = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) throw new GitFailure("unreadable-repository");
  return result;
};
const resolveRef = async (git: GitReader, ref: string): Promise<string> => sha(await git.read(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], "invalid-ref"));

class GitEvidence {
  omitted = 0;
  truncated = false;
  private chars = 0;
  constructor(readonly paths: RepositoryPaths) {}

  permitted(path: string): boolean {
    if (!Path.safeParse(path).success) { this.omitted++; return false; }
    try { this.paths.checkHistorical(path); return true; }
    catch (error) {
      if (!(error instanceof RepositoryFailure)) throw error;
      this.omitted++;
      return false;
    }
  }

  reserve(value: unknown): boolean {
    const size = JSON.stringify(value).length;
    if (this.chars + size > OUTPUT_CHARS) { this.truncated = true; return false; }
    this.chars += size;
    return true;
  }

  changes(raw: string): string[] {
    const records = raw.split("\0");
    if (records.pop() !== "") throw new GitFailure("unreadable-git-output");
    const paths: string[] = [];
    const rawPaths: string[] = [];
    for (let i = 0; i < records.length; i += 2) {
      const header = records[i]?.trim();
      const path = records[i + 1];
      const match = header?.match(/^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]$/);
      if (!match || path === undefined) throw new GitFailure("unreadable-git-output");
      rawPaths.push(path);
      if (rawPaths.length > 100) throw new GitFailure("path-limit");
      if (!SAFE_MODE.has(match[1] ?? "") || !SAFE_MODE.has(match[2] ?? "")) { this.omitted++; continue; }
      if (this.permitted(path)) paths.push(path);
    }
    return paths.filter(path => {
      if (!rawPaths.some(other => other.startsWith(`${path}/`))) return true;
      this.omitted++;
      return false;
    });
  }
}

async function commit(git: GitReader, evidence: GitEvidence, revision: string, path?: string): Promise<Commit | null> {
  const paths = evidence.changes(await git.read(["show", "--format=", "--raw", "--no-abbrev", "-z", "--diff-merges=first-parent", ...SAFE_DIFF, revision, ...pathArgs(path)]));
  if (!paths.length) return null;
  const fields = (await git.read(["show", "-s", "--no-notes", "--format=%H%x00%P%x00%cI%x00%s", revision])).trimEnd().split("\0");
  if (fields.length !== 4 || fields[0] !== revision) throw new GitFailure("unreadable-git-output");
  return { revision, parents: fields[1] ? fields[1].split(" ").map(sha) : [], committedAt: fields[2] ?? "", subject: (fields[3] ?? "").slice(0, 500), paths };
}

async function patch(git: GitReader, evidence: GitEvidence, prefix: string[], files: string[]): Promise<string> {
  if (!files.length) return "";
  const text = await git.read([...prefix, "--patch", "--unified=3", ...SAFE_DIFF, "--", ...files]);
  if (hasControl(text, true)) throw new GitFailure("non-text-diff");
  if (text.length > 8_000) { evidence.truncated = true; return `${text.slice(0, 8_000)}\n[truncated]`; }
  return text;
}

async function inspect(operation: Operation, args: Args, context: ToolContext, git: GitReader, evidence: GitEvidence): Promise<object> {
  if (args.path) evidence.paths.checkHistorical(args.path);
  const head = await git.head();
  if (operation === "head") return { provenance: { source: "repository", ...head } };
  if (operation === "status") {
    const raw = await git.read(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all"]);
    const changes: Change[] = [];
    for (const entry of raw.split("\0").filter(Boolean)) {
      const path = entry.slice(3);
      if (entry[2] !== " ") throw new GitFailure("unreadable-git-output");
      if (!evidence.permitted(path)) continue;
      const change = { path, index: entry[0] ?? "", workingTree: entry[1] ?? "", tracked: !entry.startsWith("??") };
      if (!evidence.reserve(change)) break;
      changes.push(change);
    }
    return { provenance: { source: "working-tree", ...head }, changes, clean: changes.length === 0 && evidence.omitted === 0 && !evidence.truncated ? true : changes.length ? false : null };
  }
  if (operation === "worktrees") {
    const worktrees: object[] = [];
    for (const record of (await git.worktrees()).split("\0\0").filter(Boolean)) {
      const fields = record.split("\0");
      const location = fields.find(field => field.startsWith("worktree "))?.slice(9);
      if (!location) throw new GitFailure("unreadable-git-output");
      let found = false;
      for (const project of context.projects) {
        try {
          const paths = new RepositoryPaths(context, project);
          if (realpathSync.native(location) !== realpathSync.native(paths.root)) continue;
          paths.validateRoot();
          if (paths.policy === "local") evidence.paths.policy = "local";
          const item = { project: project.id, path: ".", revision: fields.find(field => field.startsWith("HEAD "))?.slice(5) ?? null, branch: fields.find(field => field.startsWith("branch "))?.slice(7) ?? null, detached: fields.includes("detached"), bare: fields.includes("bare") };
          if (evidence.reserve(item)) worktrees.push(item);
          found = true;
          break;
        } catch (error) {
          if (!(error instanceof RepositoryFailure) && fileFailure(error).status !== "missing") throw error;
        }
      }
      if (!found) evidence.omitted++;
    }
    return { provenance: { source: "repository", ...head }, worktrees };
  }
  if (operation === "log") {
    const revision = await resolveRef(git, args.ref ?? "HEAD");
    const limit = args.limit ?? 10;
    const candidates = (await git.read(["log", "--first-parent", "--no-notes", "--format=%H", `--max-count=${limit + 1}`, revision, ...pathArgs(args.path)])).trim().split("\n").filter(Boolean);
    const commits: Commit[] = [];
    let scanned = 0;
    for (const candidate of candidates.slice(0, limit)) {
      scanned++;
      const item = await commit(git, evidence, sha(candidate), args.path);
      if (!item) continue;
      if (!evidence.reserve(item)) break;
      commits.push(item);
    }
    return { provenance: { source: "committed", revision }, commits, scanned, hasMore: candidates.length > scanned };
  }
  if (operation === "show") {
    const revision = await resolveRef(git, args.ref ?? "HEAD");
    const item = await commit(git, evidence, revision, args.path);
    if (!item) throw new RepositoryFailure("denied", "no-permitted-changes");
    if (!evidence.reserve(item)) throw new GitFailure("output-limit");
    return { provenance: { source: "committed", revision }, commit: item, diff: await patch(git, evidence, ["show", "--format=", "--diff-merges=first-parent", revision], item.paths) };
  }
  const kind = args.kind ?? "working";
  if (kind === "working" && head.revision === null) throw new GitFailure("unborn-head");
  const from = kind === "committed" ? await resolveRef(git, args.from ?? "") : kind === "unstaged" ? null : head.revision;
  const to = kind === "committed" ? await resolveRef(git, args.to ?? "") : null;
  const prefix = ["diff", ...(kind === "staged" ? ["--cached"] : []), ...(from ? [from] : []), ...(to ? [to] : [])];
  const files = evidence.changes(await git.read([...prefix, "--raw", "--no-abbrev", "-z", ...SAFE_DIFF, ...pathArgs(args.path)]));
  return { provenance: { source: kind === "committed" ? "committed" : kind === "staged" ? "index" : "working-tree", kind, from, to, ...head }, paths: files, diff: await patch(git, evidence, prefix, files), untrackedIncluded: false };
}

export function createRepositoryGitTools(options: GitReadOptions = {}): ToolDefinition[] {
  const define = (operation: Operation, input: z.ZodType<object>, description: string): ToolDefinition => ({
    name: `repo_git_${operation}`, operation: "repo.read", bindRegistry: true, input, description,
    run: async (input, context): Promise<ToolOutcome> => {
      let git: GitReader | undefined;
      let sourcePolicy = context.project?.policy;
      try {
        if (!context.project) throw new RepositoryFailure("denied", "source-required");
        const paths = new RepositoryPaths(context, context.project);
        const evidence = new GitEvidence(paths);
        git = await GitReader.open(paths.root, context.signal, options);
        const result = await inspect(operation, input as Args, context, git, evidence);
        await paths.validate();
        sourcePolicy = paths.policy;
        const text = JSON.stringify({ status: evidence.truncated ? "truncated" : "ok", project: (input as Args).project, ...result, omitted: evidence.omitted, truncated: evidence.truncated }, (_key, value: unknown) => typeof value === "string" ? scrub(value) : value);
        if (text.length > 16_000) throw new GitFailure("output-limit");
        return { outcome: "done", sourcePolicy, text };
      } catch (error) {
        context.signal.throwIfAborted();
        const failure = error instanceof GitFailure ? error.status : error instanceof RepositoryFailure ? error.reason : "unreadable-repository";
        return { outcome: error instanceof RepositoryFailure && error.status === "denied" ? "refused" : "error", sourcePolicy, text: JSON.stringify({ status: failure, disclosedBytes: 0 }) };
      } finally { await git?.close(); }
    },
  });
  return [
    define("status", Basic, "Read scoped tracked and untracked changes, distinguishing index and working-tree status. Omitted changes prevent a clean claim."),
    define("head", Basic, "Read the current branch and commit SHA; an unborn branch has no revision and a detached head has no branch."),
    define("worktrees", Basic, "List this repository's worktrees registered as permitted projects. Locations are project-relative; other worktrees are omitted."),
    define("log", History, "Read a bounded first-parent commit log, optionally for a literal project-relative path. Excluded-only commits are omitted; hasMore describes the scan bound."),
    define("show", Show, "Read a commit's provenance and bounded patch for permitted regular files, optionally under a literal project-relative path."),
    define("diff", Diff, "Read a bounded tracked-file diff: working (HEAD to files), unstaged (index to files), staged (HEAD to index), or committed (from and to required). Untracked file contents are not included."),
  ];
}
