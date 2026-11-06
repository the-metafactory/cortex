import { realpathSync } from "node:fs";
import { z } from "zod/v4";
import type { ToolOutcome } from "../model";
import type { ToolContext, ToolDefinition } from "./capabilities";
import { fileFailure, RepositoryPaths } from "./repository-paths";

export interface RepositoryGitOptions { git?: string; timeoutMs?: number }
type GitStatus = "denied" | "missing" | "unreadable" | "binary" | "truncated" | "git-missing" | "not-a-repository" | "invalid-ref" | "timeout" | "unsafe-config";
class GitFailure extends Error {
  constructor(readonly status: GitStatus, readonly reason: string) { super(reason); }
}
interface Captured { stdout: string; truncated: boolean }

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_BYTES = 1024 * 1024;
const ENTRY_LIMIT = 100;
const PATCH_PATHS = 200;
const PATCH_WINDOW = 12_000;
const MESSAGE_LIMIT = 4_000;
const REMOTE_LIMIT = 20;
const FIELD = "\x01";
const HARDENED_CONFIG = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "core.pager=cat", "core.attributesFile=/dev/null", "core.untrackedCache=false", "core.quotePath=false", "diff.autoRefreshIndex=false", "diff.renames=false", "log.showSignature=false", "submodule.recurse=false", "status.submoduleSummary=false", "status.relativePaths=false", "safe.bareRepository=explicit", "color.ui=false", "gc.auto=0", "maintenance.auto=false"];
const EXECUTABLE_KEY = /^(?:filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:command|textconv))$/i;
const REQUIRED_FILTER_KEY = /^filter\..+\.required$/i;
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all"];
const STATUS_FIELDS: Record<string, number> = { "1": 8, "2": 9, u: 10 };

const Ref = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/).refine(ref => !ref.includes(".."), "use base and head for a range");
const Path = z.string().max(512).optional();
const Window = { offset: z.number().int().min(0).max(COMMAND_BYTES).default(0), limit: z.number().int().min(1).max(PATCH_WINDOW).default(PATCH_WINDOW) };
const ProjectInput = z.object({ project: z.string() }).strict();
const LogInput = z.object({ project: z.string(), ref: Ref.default("HEAD"), path: Path, limit: z.number().int().min(1).max(50).default(20), skip: z.number().int().min(0).max(100_000).default(0) }).strict();
const ShowInput = z.object({ project: z.string(), ref: Ref.default("HEAD"), path: Path, ...Window }).strict();
const DiffInput = z.object({ project: z.string(), scope: z.enum(["unstaged", "staged", "commits"]).default("unstaged"), base: Ref.optional(), head: Ref.optional(), path: Path, ...Window }).strict().refine(input => input.scope === "commits" ? input.base !== undefined : input.base === undefined && input.head === undefined, "base and head belong to the commits scope, which requires base");

const remoteUrl = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1").replace(/^[^/@\s:]+:[^/@\s]*@/, "").replace(/[?#].*$/, "");
const present = (text: string | null): string | null => text?.trim() ? text.trim() : null;
const literal = (path: string): string => `:(top,literal)${path}`;
const tokens = (text: string): string[] => text.split("\0").filter(token => token.length > 0);

class Repository {
  readonly reasons = new Set<string>();
  private overrides: string[] = [];
  head: string | null = null;
  branch: string | null = null;

  constructor(readonly paths: RepositoryPaths, private readonly context: ToolContext, private readonly options: Required<RepositoryGitOptions>) {}

  async open(): Promise<void> {
    const top = await this.git(["rev-parse", "--show-toplevel"], "not-a-repository");
    if (realpathSync.native(top.stdout.trim()) !== this.paths.root) throw new GitFailure("not-a-repository", "root-is-not-repository-top");
    const names = tokens((await this.git(["config", "--includes", "--null", "--name-only", "--list"])).stdout);
    if (names.some(name => /[=\s]/.test(name) && (EXECUTABLE_KEY.test(name) || REQUIRED_FILTER_KEY.test(name)))) throw new GitFailure("unsafe-config", "unparseable-executable-setting");
    this.overrides = names.flatMap(name => EXECUTABLE_KEY.test(name) ? [`${name}=`] : REQUIRED_FILTER_KEY.test(name) ? [`${name}=false`] : []);
    this.head = present(await this.attempt(["rev-parse", "--verify", "--quiet", "HEAD"]));
    this.branch = present(await this.attempt(["symbolic-ref", "--quiet", "--short", "HEAD"]));
  }

  private env(): Record<string, string> {
    return { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", PAGER: "cat" };
  }

  async git(args: string[], onFailure: GitStatus = "unreadable"): Promise<Captured> {
    this.context.signal.throwIfAborted();
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.options.git, "--no-pager", ...[...HARDENED_CONFIG, ...this.overrides].flatMap(setting => ["-c", setting]), ...args], { cwd: this.paths.root, env: this.env(), stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.any([this.context.signal, timeout]), killSignal: "SIGKILL" });
    } catch (_err) {
      throw new GitFailure("git-missing", "git-not-executable");
    }
    const [captured, stderr, code] = await Promise.all([this.capture(proc), new Response(proc.stderr).text(), proc.exited]);
    this.context.signal.throwIfAborted();
    if (timeout.aborted) throw new GitFailure("timeout", "git-timed-out");
    if (code !== 0 && !captured.truncated) throw new GitFailure(/not a git repository/i.test(stderr) ? "not-a-repository" : onFailure, onFailure === "invalid-ref" ? "unknown-revision" : "git-command-failed");
    return captured;
  }

  private async capture(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<Captured> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = proc.stdout.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(next.value);
      bytes += next.value.length;
      if (bytes > COMMAND_BYTES) {
        proc.kill("SIGKILL");
        return { stdout: Buffer.concat(chunks).subarray(0, COMMAND_BYTES).toString("utf8"), truncated: true };
      }
    }
    return { stdout: Buffer.concat(chunks).toString("utf8"), truncated: false };
  }

  private async attempt(args: string[]): Promise<string | null> {
    try { return (await this.git(args)).stdout; }
    catch (error) {
      if (error instanceof GitFailure && (error.status === "unreadable" || error.status === "not-a-repository")) return null;
      throw error;
    }
  }

  permits(path: string): boolean {
    try { this.paths.permit(path); return true; }
    catch (error) {
      if (fileFailure(error).status === "denied") return false;
      throw error;
    }
  }

  revision(ref: string): Promise<string> {
    return this.git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], "invalid-ref").then(result => result.stdout.trim());
  }

  requested(path: string | undefined): string[] {
    if (path === undefined || path === ".") return [];
    this.paths.permit(path);
    return [literal(path)];
  }

  async patch(revisions: string[], path: string | undefined, window: { offset: number; limit: number }): Promise<object> {
    const only = this.requested(path);
    const listed = await this.git(["diff", ...DIFF_FLAGS, "--name-status", "-z", ...revisions, "--", ...only]);
    const parts = tokens(listed.stdout);
    const changed = parts.flatMap((part, index) => index % 2 === 0 ? [{ status: part, path: parts[index + 1] ?? "" }] : []);
    const files = changed.filter(file => this.permits(file.path));
    const shown = files.slice(0, PATCH_PATHS);
    if (files.length > PATCH_PATHS) this.reasons.add("path-limit");
    const patch = shown.length ? await this.git(["diff", ...DIFF_FLAGS, "--unified=3", ...revisions, "--", ...shown.map(file => literal(file.path))]) : { stdout: "", truncated: false };
    if (patch.truncated || listed.truncated) this.reasons.add("output-limit");
    const text = patch.stdout.slice(window.offset, window.offset + window.limit);
    const end = window.offset + text.length;
    if (end < patch.stdout.length) this.reasons.add("patch-window");
    return { files: shown.slice(0, ENTRY_LIMIT), withheldPaths: changed.length - files.length, patch: text, nextOffset: end < patch.stdout.length ? end : null };
  }
}

function parseStatus(output: string, repository: Repository): object {
  const header: Record<string, string> = {};
  const tracked: { path: string; staged: string; unstaged: string; conflicted: boolean }[] = [];
  const untracked: string[] = [];
  let withheld = 0;
  for (const token of tokens(output)) {
    if (token.startsWith("# ")) {
      const [, key, ...rest] = token.split(" ");
      if (key) header[key] = rest.join(" ");
    } else if (token.startsWith("? ")) {
      const path = token.slice(2);
      if (repository.permits(path.replace(/\/$/, ""))) untracked.push(path);
      else withheld++;
    } else {
      const fields = STATUS_FIELDS[token.charAt(0)];
      if (fields === undefined) continue;
      const parts = token.split(" ");
      const path = parts.slice(fields).join(" ");
      if (repository.permits(path)) tracked.push({ path, staged: parts[1]?.charAt(0) ?? ".", unstaged: parts[1]?.charAt(1) ?? ".", conflicted: token.startsWith("u") });
      else withheld++;
    }
  }
  if (tracked.length + untracked.length > ENTRY_LIMIT) repository.reasons.add("entry-limit");
  const [ahead, behind] = (header["branch.ab"] ?? "").split(" ");
  return { upstream: header["branch.upstream"] ?? null, ahead: ahead ? Number(ahead) : null, behind: behind ? -Number(behind) : null, tracked: tracked.slice(0, ENTRY_LIMIT), untracked: untracked.slice(0, Math.max(0, ENTRY_LIMIT - tracked.length)), withheldPaths: withheld };
}

async function status(repository: Repository): Promise<object> {
  const result = await repository.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignore-submodules=all", "--no-renames"]);
  if (result.truncated) repository.reasons.add("output-limit");
  const configured = await repository.git(["config", "--includes", "--null", "--get-regexp", "^remote\\..*\\.url$"]).catch((error: unknown) => {
    if (error instanceof GitFailure && error.status === "unreadable") return { stdout: "", truncated: false };
    throw error;
  });
  const remotes = tokens(configured.stdout).slice(0, REMOTE_LIMIT).map(entry => {
    const split = entry.indexOf("\n");
    return { name: entry.slice("remote.".length, split).replace(/\.url$/, ""), url: remoteUrl(entry.slice(split + 1)) };
  });
  return { ...parseStatus(result.stdout, repository), remotes };
}

async function worktrees(repository: Repository): Promise<object> {
  const result = await repository.git(["worktree", "list", "--porcelain", "-z"]);
  const entries: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  for (const line of result.stdout.split("\0")) {
    if (!line) {
      if (Object.keys(current).length) entries.push(current);
      current = {};
      continue;
    }
    const space = line.indexOf(" ");
    current[space < 0 ? line : line.slice(0, space)] = space < 0 ? "" : line.slice(space + 1);
  }
  const shown = entries.flatMap(entry => {
    const source = repository.paths.sourceOf(entry.worktree ?? "");
    return source ? [{ ...source, head: entry.HEAD ?? null, branch: entry.branch?.replace(/^refs\/heads\//, "") ?? null, detached: "detached" in entry, locked: "locked" in entry }] : [];
  });
  return { worktrees: shown.slice(0, ENTRY_LIMIT), withheldWorktrees: entries.length - shown.length };
}

async function log(repository: Repository, args: z.infer<typeof LogInput>): Promise<object> {
  const only = repository.requested(args.path);
  const sha = await repository.revision(args.ref);
  const result = await repository.git(["log", "--no-show-signature", "--no-color", `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s`, "-z", `--max-count=${args.limit + 1}`, `--skip=${args.skip}`, "--end-of-options", sha, "--", ...only]);
  const commits = tokens(result.stdout).map(entry => {
    const [hash, author, date, subject] = entry.split(FIELD);
    return { sha: hash, author, date, subject };
  });
  if (commits.length > args.limit) repository.reasons.add("result-limit");
  return { source: "committed", ref: sha, commits: commits.slice(0, args.limit), nextSkip: commits.length > args.limit ? args.skip + args.limit : null };
}

async function show(repository: Repository, args: z.infer<typeof ShowInput>): Promise<object> {
  const sha = await repository.revision(args.ref);
  const meta = await repository.git(["show", "--no-show-signature", "--no-patch", "--no-color", `--format=%H${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%B`, "--end-of-options", sha]);
  const [hash, parents, author, date, message = ""] = meta.stdout.split(FIELD);
  const firstParent = parents?.split(" ").find(Boolean);
  const base = firstParent ?? (await repository.git(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();
  if (message.length > MESSAGE_LIMIT) repository.reasons.add("message-limit");
  return { source: "committed", commit: { sha: hash, parents: parents?.split(" ").filter(Boolean) ?? [], author, date, message: message.slice(0, MESSAGE_LIMIT).trimEnd() }, ...await repository.patch([base, sha], args.path, args) };
}

async function diff(repository: Repository, args: z.infer<typeof DiffInput>): Promise<object> {
  if (args.scope === "unstaged") return { source: "working-tree", ...await repository.patch([], args.path, args) };
  if (args.scope === "staged") return { source: "index", ...await repository.patch(["--cached"], args.path, args) };
  const [base, head] = await Promise.all([repository.revision(args.base ?? "HEAD"), repository.revision(args.head ?? "HEAD")]);
  return { source: "committed", base, head, ...await repository.patch([base, head], args.path, args) };
}

/** Builds the bounded Git read tools: fixed argv, no shell, and repository configuration unable to run helpers. */
export function createRepositoryGitTools(options: RepositoryGitOptions = {}): readonly ToolDefinition[] {
  const resolved = { git: options.git ?? "git", timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS };
  const execute = async (args: { project: string }, context: ToolContext, run: (repository: Repository) => Promise<object>): Promise<ToolOutcome> => {
    let sourcePolicy = context.project?.policy;
    try {
      if (!context.project) throw new GitFailure("denied", "source-required");
      const paths = new RepositoryPaths(context, context.project);
      const repository = new Repository(paths, context, resolved);
      await repository.open();
      const body = await run(repository);
      await paths.validate();
      sourcePolicy = paths.policy;
      const truncated = repository.reasons.size > 0;
      return { sourcePolicy, outcome: "done", text: JSON.stringify({ status: truncated ? "truncated" : "ok", project: args.project, provenance: { source: "git", head: repository.head, branch: repository.branch }, truncated, reasons: [...repository.reasons], ...body }) };
    } catch (error) {
      context.signal.throwIfAborted();
      const failure = error instanceof GitFailure ? error : fileFailure(error);
      return { sourcePolicy, outcome: failure.status === "denied" ? "refused" : "error", text: JSON.stringify({ status: failure.status, project: args.project, reason: failure.reason, disclosedBytes: 0 }) };
    }
  };
  const tools: ToolDefinition[] = [
    { name: "git_status", description: "Read a configured project's branch, head, upstream, remotes, and its tracked and untracked changes. Excluded paths are counted, never named.", operation: "repo.read", input: ProjectInput, run: (input, context) => execute(input as z.infer<typeof ProjectInput>, context, status) },
    { name: "git_worktrees", description: "List a configured project's Git worktrees that lie inside permitted sources. Others are counted, never named.", operation: "repo.read", input: ProjectInput, run: (input, context) => execute(input as z.infer<typeof ProjectInput>, context, worktrees) },
    { name: "git_log", description: "Read bounded commit history for a revision, optionally for one project-relative path. Returns sha, author, date and subject.", operation: "repo.read", input: LogInput, run: (input, context) => execute(input as z.infer<typeof LogInput>, context, repository => log(repository, input as z.infer<typeof LogInput>)) },
    { name: "git_show", description: "Read one commit's message, changed files and bounded patch. Excluded paths are withheld and counted.", operation: "repo.read", input: ShowInput, run: (input, context) => execute(input as z.infer<typeof ShowInput>, context, repository => show(repository, input as z.infer<typeof ShowInput>)) },
    { name: "git_diff", description: "Read a bounded diff: scope unstaged compares the working tree with the index, staged compares the index with HEAD, commits compares base with head. Untracked files appear in git_status only.", operation: "repo.read", input: DiffInput, run: (input, context) => execute(input as z.infer<typeof DiffInput>, context, repository => diff(repository, input as z.infer<typeof DiffInput>)) },
  ];
  return tools.map(tool => ({ ...tool, bindRegistry: true }));
}
export const repositoryGitTools: readonly ToolDefinition[] = createRepositoryGitTools();
