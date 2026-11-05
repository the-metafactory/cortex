import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolProject } from "../../common/types/desk-conversations";
import { routePolicy } from "../types";
import { localSourcePolicy, type ToolContext } from "./capabilities";

export type FileStatus = "denied" | "missing" | "unreadable" | "binary" | "truncated";
export class RepositoryFailure extends Error {
  constructor(readonly status: FileStatus, readonly reason: string) { super(reason); }
}
export const FILE_BYTES = 256 * 1024;
export const within = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
export const relativeInput = (path: string): boolean => !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && !path.split("/").includes("..");
const protectedPath = (path: string): boolean => path.split("/").some(part => /^(?:\.git|\.worktrees|node_modules|\.ssh|\.aws|\.gnupg|\.config|\.claude|\.kube|\.docker)$/i.test(part) || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|(?:secrets?|private|credentials)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
const excluded = (project: ToolProject, path: string): boolean => protectedPath(path) || (project.exclude ?? []).some(prefix => path === prefix || path.startsWith(`${prefix}/`));
const permitted = (context: ToolContext, project: ToolProject): boolean => context.session.scope.includes(project.id) && project.operations.includes("repo.read") && (project.policy === "cloud" || localSourcePolicy(project.policy) && context.session.policy === "local" && routePolicy(context.session.route) === "local" && context.session.transport === "web");
const configuredRoot = (project: ToolProject): string => project.root.startsWith("~/") ? join(homedir(), project.root.slice(2)) : project.root;

export function fileFailure(error: unknown): RepositoryFailure {
  if (error instanceof RepositoryFailure) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? new RepositoryFailure("missing", "path-not-found") : new RepositoryFailure("unreadable", "filesystem-unavailable");
}

export interface CheckedPath { absolute: string; path: string; stat: Stats }
export class RepositoryPaths {
  readonly root: string;
  readBytes = 0;
  private readonly rootStat: Stats;
  private readonly boundaries: { project: ToolProject; root: string }[];
  private readonly checked = new Map<string, CheckedPath>();

  constructor(private readonly context: ToolContext, private readonly project: ToolProject) {
    if (!permitted(context, project)) throw new RepositoryFailure("denied", "source-policy");
    this.root = realpathSync(configuredRoot(project));
    if (protectedPath(basename(configuredRoot(project))) || protectedPath(basename(this.root))) throw new RepositoryFailure("denied", "excluded-root");
    this.rootStat = statSync(this.root);
    if (!this.rootStat.isDirectory()) throw new RepositoryFailure("unreadable", "root-not-directory");
    this.boundaries = context.projects.flatMap(other => {
      try { return [{ project: other, root: realpathSync(configuredRoot(other)) }]; }
      catch (error) {
        if (fileFailure(error).status === "missing") return [{ project: other, root: resolve(configuredRoot(other)) }];
        throw new RepositoryFailure("denied", "source-boundary-unavailable");
      }
    });
  }

  validateRoot(): void {
    this.context.signal.throwIfAborted();
    if (realpathSync(configuredRoot(this.project)) !== this.root || !sameFile(statSync(this.root), this.rootStat)) throw new RepositoryFailure("denied", "root-changed");
    for (const boundary of this.boundaries) {
      try {
        if (realpathSync(configuredRoot(boundary.project)) !== boundary.root) throw new RepositoryFailure("denied", "source-root-changed");
      } catch (error) {
        if (fileFailure(error).status !== "missing") throw error;
      }
    }
  }

  validate(): void {
    this.validateRoot();
    for (const path of this.checked.keys()) this.check(path);
  }

  private checkScope(absolute: string): void {
    if (!within(this.root, absolute)) throw new RepositoryFailure("denied", "outside-project");
    if (excluded(this.project, relative(this.root, absolute))) throw new RepositoryFailure("denied", "excluded-path");
    for (const boundary of this.boundaries) {
      if (within(boundary.root, absolute) && (!permitted(this.context, boundary.project) || excluded(boundary.project, relative(boundary.root, absolute)))) throw new RepositoryFailure("denied", "source-policy");
    }
    const parts = relative(this.root, absolute).split("/");
    let parent = this.root;
    for (const part of parts) {
      parent = join(parent, part);
      if (parent === this.root) continue;
      try {
        lstatSync(join(parent, ".git"));
      } catch (error) {
        if (fileFailure(error).status === "missing") continue;
        throw new RepositoryFailure("denied", "checkout-boundary-unavailable");
      }
      throw new RepositoryFailure("denied", "nested-checkout");
    }
  }

  check(path: string): CheckedPath {
    this.validateRoot();
    if (!relativeInput(path)) throw new RepositoryFailure("denied", "relative-path-required");
    const requested = resolve(this.root, path);
    this.checkScope(requested);
    const absolute = realpathSync(requested);
    this.checkScope(absolute);
    const checked = { absolute, path: relative(this.root, absolute) || ".", stat: statSync(absolute) };
    const previous = this.checked.get(path);
    if (previous && (previous.absolute !== checked.absolute || !sameFile(previous.stat, checked.stat))) throw new RepositoryFailure("denied", "path-changed");
    this.checked.set(path, checked);
    return checked;
  }

  read(path: string, remainingBytes: number): { text: string; path: string; sha256Input: Buffer; bytes: number; modifiedAt: string } {
    const checked = this.check(path);
    if (!checked.stat.isFile()) throw new RepositoryFailure("unreadable", "not-regular-file");
    if (checked.stat.size > FILE_BYTES) throw new RepositoryFailure("truncated", "file-size-limit");
    const fd = openSync(checked.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!sameFile(before, checked.stat) || !before.isFile()) throw new RepositoryFailure("denied", "file-changed");
      if (before.size > FILE_BYTES) throw new RepositoryFailure("truncated", "file-size-limit");
      if (before.size > remainingBytes) throw new RepositoryFailure("truncated", "read-byte-limit");
      if (!sameFile(this.check(path).stat, before)) throw new RepositoryFailure("denied", "file-changed");
      const buffer = Buffer.alloc(Math.min(FILE_BYTES, remainingBytes) + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        this.context.signal.throwIfAborted();
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!count) break;
        bytes += count;
        this.readBytes += count;
      }
      if (bytes > FILE_BYTES) throw new RepositoryFailure("truncated", "file-size-limit");
      if (bytes > remainingBytes) throw new RepositoryFailure("truncated", "read-byte-limit");
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !sameFile(this.check(path).stat, after)) throw new RepositoryFailure("unreadable", "file-changed");
      const data = buffer.subarray(0, bytes);
      if (data.some(byte => byte === 0 || byte < 9 || byte > 13 && byte < 32)) throw new RepositoryFailure("binary", "non-text-file");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { throw new RepositoryFailure("binary", "non-utf8-file"); }
      return { text, path: checked.path, sha256Input: data, bytes, modifiedAt: after.mtime.toISOString() };
    } finally { closeSync(fd); }
  }
}
