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
const ENTRY_LIMIT = 2_000;
const TOTAL_BYTES = 2 * 1024 * 1024;
type Operation = "list" | "read" | "find" | "search";
interface Item { path: string; status?: FileStatus; reason?: string; kind?: string; line?: number; text?: string; truncated?: boolean; provenance?: object }
interface Result { status: "ok" | FileStatus; project: string; provenance: { source: "working-tree"; revision: null }; disclosedBytes: number; truncated: boolean; reasons: string[]; results: Item[] }

function contentLines(text: string): string[] {
  if (!text.length) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}

async function execute(operation: Operation, input: object, context: ToolContext): Promise<ToolOutcome> {
  const args = input as z.infer<typeof ReadInput> & z.infer<typeof QueryInput>;
  const result: Result = { status: "ok", project: args.project, provenance: { source: "working-tree", revision: null }, disclosedBytes: 0, truncated: false, reasons: [], results: [] };
  let chars = 0;
  let entries = 0;
  let limited = false;
  const isLimited = (): boolean => limited;
  const truncate = (reason: string): void => {
    result.truncated = true;
    if (!result.reasons.includes(reason)) result.reasons.push(reason);
  };
  const append = (item: Item): void => {
    const cost = JSON.stringify(item).length;
    if (chars + cost > OUTPUT_CHARS || result.results.length >= (operation === "read" ? args.lines : args.limit)) {
      limited = true;
      truncate("result-limit");
      return;
    }
    chars += cost;
    result.disclosedBytes += Buffer.byteLength(item.text ?? "");
    result.results.push(item);
    if (item.truncated) truncate("line-length-limit");
  };
  try {
    if (!context.project) throw new RepositoryFailure("denied", "source-required");
    const paths = new RepositoryPaths(context, context.project);
    const start = paths.check(args.path);
    const matches = (text: string): boolean => args.caseSensitive ? text.includes(args.query) : text.toLowerCase().includes(args.query.toLowerCase());
    const read = (path: string): void => {
      if (paths.readBytes >= TOTAL_BYTES) { limited = true; truncate("read-byte-limit"); return; }
      try {
        const file = paths.read(path, TOTAL_BYTES - paths.readBytes);
        const lines = contentLines(file.text);
        const provenance = { source: "working-tree", sha256: createHash("sha256").update(file.sha256Input).digest("hex"), bytes: file.bytes, modifiedAt: file.modifiedAt };
        if (operation === "read" && (args.startLine > 1 || args.startLine + args.lines - 1 < lines.length)) truncate("line-range");
        for (let index = operation === "read" ? args.startLine - 1 : 0; index < lines.length && !limited; index++) {
          if (operation === "read" && index >= args.startLine - 1 + args.lines) break;
          const text = lines[index] ?? "";
          if (operation === "read" || matches(text)) append({ path: file.path, line: index + 1, text: text.slice(0, 1_000), truncated: text.length > 1_000, provenance });
        }
      } catch (error) {
        context.signal.throwIfAborted();
        const failure = fileFailure(error);
        if (operation === "read") throw failure;
        append({ path, status: failure.status, reason: failure.reason });
        if (failure.status === "truncated") truncate(failure.reason);
        if (failure.reason === "read-byte-limit") limited = true;
      }
    };
    const visit = async (path: string, depth: number): Promise<void> => {
      await setImmediate();
      context.signal.throwIfAborted();
      if (isLimited()) return;
      entries++;
      if (entries > ENTRY_LIMIT) { limited = true; truncate("entry-limit"); return; }
      try {
        const checked = paths.check(path);
        if (checked.stat.isDirectory()) {
          if (operation === "list" && depth > 0) { append({ path: checked.path, kind: "directory" }); return; }
          if (depth > args.depth) { truncate("depth-limit"); return; }
          const dir = await opendir(checked.absolute);
          for await (const entry of dir) {
            if (isLimited()) break;
            await visit(join(path, entry.name), depth + 1);
          }
        } else if (!checked.stat.isFile()) append({ path: checked.path, status: "unreadable", reason: "not-regular-file" });
        else if (operation === "search") read(path);
        else if (operation === "list" || matches(checked.path)) append({ path: checked.path, kind: "file" });
      } catch (error) {
        context.signal.throwIfAborted();
        const failure = fileFailure(error);
        append({ path, status: failure.status, reason: failure.reason });
      }
    };
    if (operation === "read") { await setImmediate(); read(args.path); }
    else {
      if (!start.stat.isDirectory()) throw new RepositoryFailure("unreadable", "directory-required");
      await visit(args.path, 0);
    }
    paths.validate();
    if (result.truncated) result.status = "truncated";
  } catch (error) {
    context.signal.throwIfAborted();
    const failure = fileFailure(error);
    result.status = failure.status;
    result.reasons = [failure.reason];
    result.results = [];
    result.disclosedBytes = 0;
    result.truncated = failure.status === "truncated";
  }
  return { outcome: result.status === "denied" ? "refused" : result.status === "missing" || result.status === "unreadable" || result.status === "binary" ? "error" : "done", text: JSON.stringify(result) };
}

export const repositoryFileTools: readonly ToolDefinition[] = ([
  { name: "repo_list", description: "List a configured project's directory. Paths are project-relative. Exclusions and limits are reported.", operation: "repo.read", input: ListInput, run: (input, context) => execute("list", input, context) },
  { name: "repo_read", description: "Read current UTF-8 working files by project-relative path and line range. Returns line citations, content hashes and truncation.", operation: "repo.read", input: ReadInput, run: (input, context) => execute("read", input, context) },
  { name: "repo_find", description: "Find file paths containing a literal query in a configured project. Bounded depth and results; no glob, regex or shell.", operation: "repo.read", input: QueryInput, run: (input, context) => execute("find", input, context) },
  { name: "repo_search", description: "Search UTF-8 working files for literal text in a configured project. Returns project-relative paths, lines, content hashes and limits. No regex or shell.", operation: "repo.read", input: QueryInput, run: (input, context) => execute("search", input, context) },
] satisfies ToolDefinition[]).map(tool => ({ ...tool, bindRegistry: true }));
