import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod/v4";
import type { ToolOutcome } from "../model";
import type { ToolContext, ToolDefinition } from "./capabilities";
import { fileFailure, RepositoryFailure, RepositoryPaths, type FileStatus } from "./repository-paths";

const PathInput = z.string().max(512);
const Common = { project: z.string(), path: PathInput.default(".") };
const Bounded = { depth: z.number().int().min(0).max(8).default(4), limit: z.number().int().min(1).max(100).default(40) };
const ReadInput = z.object({ ...Common, startLine: z.number().int().min(1).max(1_000_000).default(1), lines: z.number().int().min(1).max(200).default(100) }).strict();
const ListInput = z.object({ ...Common, limit: Bounded.limit }).strict();
const QueryInput = z.object({ ...Common, ...Bounded, query: z.string().min(1).max(200), caseSensitive: z.boolean().default(true) }).strict();
const OUTPUT_CHARS = 12_000;
const SKIPPED_CHARS = 2_000;
const SKIPPED_LIMIT = 40;
const ENTRY_LIMIT = 2_000;
const TOTAL_BYTES = 2 * 1024 * 1024;
type ReadArgs = z.infer<typeof ReadInput>;
type Walk = { operation: "list"; args: z.infer<typeof ListInput> } | { operation: "find" | "search"; args: z.infer<typeof QueryInput> };
interface Line { line: number; text: string; truncated: boolean }
interface FileItem { path: string; provenance: { source: "working-tree"; sha256: string; bytes: number; modifiedAt: string }; lines: Line[] }
interface Entry { path: string; kind: "directory" | "file" }
interface Skipped { path: string; status: FileStatus; reason: string }
type Checked = ReturnType<RepositoryPaths["check"]>;
interface WalkPolicy { enters(checked: Checked, depth: number): boolean; onFile(path: string, checked: Checked): void }
interface Result { status: "ok" | FileStatus; project: string; provenance: { source: "working-tree"; revision: null }; disclosedBytes: number; truncated: boolean; reasons: string[]; results: (FileItem | Entry)[]; skipped: Skipped[]; skippedCount: number }

class ResultCollector {
  readonly result: Result;
  private limited = false;
  private chars = 0;
  private skippedChars = 0;
  private matches = 0;
  private readonly files = new Map<string, FileItem>();

  constructor(project: string, private readonly limit: number) {
    this.result = { status: "ok", project, provenance: { source: "working-tree", revision: null }, disclosedBytes: 0, truncated: false, reasons: [], results: [], skipped: [], skippedCount: 0 };
  }

  truncate(reason: string): void {
    this.result.truncated = true;
    if (!this.result.reasons.includes(reason)) this.result.reasons.push(reason);
  }

  stop(reason: string): void {
    this.limited = true;
    this.truncate(reason);
  }

  isLimited(): boolean { return this.limited; }

  private reserve(cost: number): boolean {
    if (this.matches >= this.limit) { this.stop("result-limit"); return false; }
    if (this.chars + cost > OUTPUT_CHARS) { this.stop("output-limit"); return false; }
    this.chars += cost;
    this.matches++;
    return true;
  }

  entry(item: Entry): void {
    if (this.reserve(JSON.stringify(item).length + 1)) this.result.results.push(item);
  }

  line(file: Omit<FileItem, "lines">, index: number, text: string): void {
    const existing = this.files.get(file.path);
    const line = { line: index + 1, text: text.slice(0, 1_000), truncated: text.length > 1_000 };
    if (!this.reserve(JSON.stringify(line).length + 1 + (existing ? 0 : JSON.stringify({ ...file, lines: [] }).length + 1))) return;
    if (existing) existing.lines.push(line);
    else {
      const item = { ...file, lines: [line] };
      this.files.set(file.path, item);
      this.result.results.push(item);
    }
    this.result.disclosedBytes += Buffer.byteLength(line.text);
    if (line.truncated) this.truncate("line-length-limit");
  }

  skip(path: string, failure: RepositoryFailure): void {
    this.result.skippedCount++;
    const item = { path, status: failure.status, reason: failure.reason };
    const cost = JSON.stringify(item).length + 1;
    if (this.result.skipped.length < SKIPPED_LIMIT && this.skippedChars + cost <= SKIPPED_CHARS) {
      this.result.skipped.push(item);
      this.skippedChars += cost;
    } else this.truncate("skipped-limit");
    if (failure.status === "truncated") this.truncate(failure.reason);
    if (failure.reason === "read-byte-limit") this.stop(failure.reason);
  }
}

function contentLines(text: string): string[] {
  if (!text.length) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function readFile(path: string, paths: RepositoryPaths, collector: ResultCollector, options: { range?: Pick<ReadArgs, "startLine" | "lines">; matches?: (text: string) => boolean }): void {
  if (paths.readBytes >= TOTAL_BYTES) { collector.stop("read-byte-limit"); return; }
  const file = paths.read(path, TOTAL_BYTES - paths.readBytes);
  const lines = contentLines(file.text);
  const item = { path: file.path, provenance: { source: "working-tree" as const, sha256: createHash("sha256").update(file.sha256Input).digest("hex"), bytes: file.bytes, modifiedAt: file.modifiedAt } };
  const start = options.range ? options.range.startLine - 1 : 0;
  const end = options.range ? Math.min(lines.length, start + options.range.lines) : lines.length;
  if (start > 0 || end < lines.length) collector.truncate("line-range");
  for (let index = start; index < end && !collector.isLimited(); index++) {
    const text = lines[index] ?? "";
    if (!options.matches || options.matches(text)) collector.line(item, index, text);
  }
}

function matchesQuery(args: z.infer<typeof QueryInput>, text: string): boolean {
  return args.caseSensitive ? text.includes(args.query) : text.toLowerCase().includes(args.query.toLowerCase());
}

function belowDepth(args: z.infer<typeof QueryInput>, collector: ResultCollector): WalkPolicy["enters"] {
  return (_checked, depth) => {
    if (depth <= args.depth) return true;
    collector.truncate("depth-limit");
    return false;
  };
}

function walkPolicy(request: Walk, paths: RepositoryPaths, collector: ResultCollector): WalkPolicy {
  if (request.operation === "list") return {
    enters(checked, depth) {
      if (depth === 0) return true;
      collector.entry({ path: checked.path, kind: "directory" });
      return false;
    },
    onFile(_path, checked) { collector.entry({ path: checked.path, kind: "file" }); },
  };
  const args = request.args;
  const enters = belowDepth(args, collector);
  const matches = (text: string): boolean => matchesQuery(args, text);
  if (request.operation === "find") return {
    enters,
    onFile(_path, checked) { if (matches(checked.path)) collector.entry({ path: checked.path, kind: "file" }); },
  };
  const searched = new Set<string>();
  return {
    enters,
    onFile(path, checked) {
      if (searched.has(checked.path)) return;
      searched.add(checked.path);
      readFile(path, paths, collector, { matches });
    },
  };
}

async function walk(root: string, policy: WalkPolicy, paths: RepositoryPaths, collector: ResultCollector, context: ToolContext): Promise<void> {
  if (!paths.check(root).stat.isDirectory()) throw new RepositoryFailure("unreadable", "directory-required");
  let entries = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    await setImmediate();
    context.signal.throwIfAborted();
    if (collector.isLimited()) return;
    if (++entries > ENTRY_LIMIT) { collector.stop("entry-limit"); return; }
    try {
      const checked = paths.check(path);
      if (checked.stat.isDirectory()) {
        if (!policy.enters(checked, depth)) return;
        const dir = await opendir(checked.absolute);
        for await (const entry of dir) {
          if (collector.isLimited()) break;
          await visit(join(path, entry.name), depth + 1);
        }
      } else if (!checked.stat.isFile()) throw new RepositoryFailure("unreadable", "not-regular-file");
      else policy.onFile(path, checked);
    } catch (error) {
      context.signal.throwIfAborted();
      collector.skip(path, fileFailure(error));
    }
  };
  await visit(root, 0);
}

async function execute(args: { project: string }, limit: number, context: ToolContext, run: (paths: RepositoryPaths, collector: ResultCollector) => Promise<void>): Promise<ToolOutcome> {
  const collector = new ResultCollector(args.project, limit);
  const result = collector.result;
  let sourcePolicy = context.project?.policy;
  try {
    if (!context.project) throw new RepositoryFailure("denied", "source-required");
    const paths = new RepositoryPaths(context, context.project);
    await run(paths, collector);
    await paths.validate();
    sourcePolicy = paths.policy;
    if (result.truncated) result.status = "truncated";
  } catch (error) {
    context.signal.throwIfAborted();
    const failure = fileFailure(error);
    result.status = failure.status;
    result.reasons = [failure.reason];
    result.results = [];
    result.skipped = [];
    result.skippedCount = 0;
    result.disclosedBytes = 0;
    result.truncated = failure.status === "truncated";
  }
  return { sourcePolicy, outcome: result.status === "denied" ? "refused" : result.status === "missing" || result.status === "unreadable" || result.status === "binary" ? "error" : "done", text: JSON.stringify(result) };
}

function read(input: object, context: ToolContext): Promise<ToolOutcome> {
  const args = input as ReadArgs;
  return execute(args, args.lines, context, async (paths, collector) => {
    await setImmediate();
    readFile(args.path, paths, collector, { range: args });
  });
}

function query(request: Walk, context: ToolContext): Promise<ToolOutcome> {
  return execute(request.args, request.args.limit, context, (paths, collector) => walk(request.args.path, walkPolicy(request, paths, collector), paths, collector, context));
}

export const repositoryFileTools: readonly ToolDefinition[] = ([
  { name: "repo_list", description: "List a configured project's directory. Paths are project-relative. Exclusions and limits are reported.", operation: "repo.read", input: ListInput, run: (input, context) => query({ operation: "list", args: input as z.infer<typeof ListInput> }, context) },
  { name: "repo_read", description: "Read current UTF-8 working files by project-relative path and line range. Returns files with numbered lines, content hashes and truncation.", operation: "repo.read", input: ReadInput, run: read },
  { name: "repo_find", description: "Find permitted project-relative file names containing a bounded literal query. No glob, regex or executable expressions.", operation: "repo.read", input: QueryInput, run: (input, context) => query({ operation: "find", args: input as z.infer<typeof QueryInput> }, context) },
  { name: "repo_search", description: "Search permitted UTF-8 working files for bounded literal text. Returns files with matching numbered lines and content provenance.", operation: "repo.read", input: QueryInput, run: (input, context) => query({ operation: "search", args: input as z.infer<typeof QueryInput> }, context) },
] satisfies ToolDefinition[]).map(tool => ({ ...tool, bindRegistry: true }));
