import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class GitFailure extends Error {
  constructor(readonly status: string) { super(status); }
}
export interface GitReadOptions { binary?: string; timeoutMs?: number; maxBytes?: number }
interface GitResult { code: number; text: string }
const COMMAND_BYTES = 256 * 1024;
const TOTAL_BYTES = 2 * 1024 * 1024;

export class GitReader {
  private bytes = 0;
  private commands = 0;
  private readonly binary: string;
  private readonly signal: AbortSignal;
  private readonly timeout: AbortSignal;
  private constructor(private readonly scratch: string, private readonly root: string, signal: AbortSignal, private readonly options: GitReadOptions) {
    const binary = options.binary ?? Bun.which("git");
    if (!binary) throw new GitFailure("git-missing");
    this.binary = binary;
    this.timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    this.signal = AbortSignal.any([signal, this.timeout]);
  }

  static async open(root: string, signal: AbortSignal, options: GitReadOptions = {}): Promise<GitReader> {
    const scratch = await mkdtemp(join(tmpdir(), "conversation-git-"));
    try {
      const reader = new GitReader(scratch, root, signal, options);
      await reader.prepare();
      return reader;
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> { await rm(this.scratch, { recursive: true, force: true }); }

  private checkSignal(): void {
    if (this.timeout.aborted) throw new GitFailure("timeout");
    this.signal.throwIfAborted();
  }

  private async command(args: string[], original = false): Promise<GitResult> {
    this.checkSignal();
    if (++this.commands > 160) throw new GitFailure("command-limit");
    const env = {
      PATH: "/usr/bin:/bin", HOME: this.scratch, XDG_CONFIG_HOME: this.scratch, LC_ALL: "C", LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_LITERAL_PATHSPECS: "1",
    };
    const location = original ? ["-C", this.root] : [`--git-dir=${this.scratch}`, `--work-tree=${this.root}`];
    let proc;
    try {
      proc = Bun.spawn([this.binary, "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...location, ...args], { cwd: this.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch { throw new GitFailure("git-missing"); }
    const budget = { bytes: 0 };
    const cap = this.options.maxBytes ?? COMMAND_BYTES;
    const read = async (stream: ReadableStream<Uint8Array>, retain: boolean): Promise<string> => {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          budget.bytes += next.value.length;
          this.bytes += next.value.length;
          if (budget.bytes > cap || this.bytes > TOTAL_BYTES) proc.kill("SIGKILL");
          else if (retain) chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      if (budget.bytes > cap || this.bytes > TOTAL_BYTES) return "";
      try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw new GitFailure("non-utf8-git-output"); }
    };
    const stop = (): void => { proc.kill("SIGKILL"); };
    this.signal.addEventListener("abort", stop, { once: true });
    if (this.signal.aborted) stop();
    try {
      const [text, , code] = await Promise.all([read(proc.stdout, true), read(proc.stderr, false), proc.exited]);
      this.checkSignal();
      if (budget.bytes > cap || this.bytes > TOTAL_BYTES) throw new GitFailure("output-limit");
      return { code, text };
    } catch (error) {
      proc.kill("SIGKILL");
      await proc.exited;
      throw error;
    } finally { this.signal.removeEventListener("abort", stop); }
  }

  private async prepare(): Promise<void> {
    const discovered = await this.command(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel", "--show-object-format"], true);
    const [gitDir, common, top, format, ...extra] = discovered.text.trimEnd().split("\n");
    if (discovered.code !== 0 || !gitDir || !common || top !== this.root || !["sha1", "sha256"].includes(format ?? "") || extra.length) throw new GitFailure("unreadable-repository");
    try {
      await lstat(join(common, "reftable"));
      throw new GitFailure("unsupported-reference-format");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(join(this.scratch, "config"), format === "sha256" ? "[core]\nrepositoryformatversion=1\n[extensions]\nobjectFormat=sha256\n" : "[core]\nrepositoryformatversion=0\n");
    await copyFile(join(gitDir, "HEAD"), join(this.scratch, "HEAD"));
    for (const name of ["objects", "refs", "packed-refs", "shallow"]) await this.linkIfPresent(join(common, name), join(this.scratch, name));
    await mkdir(join(this.scratch, "info"));
    await this.linkIfPresent(join(common, "info", "exclude"), join(this.scratch, "info", "exclude"));
    const index = join(gitDir, "index");
    try {
      if ((await lstat(index)).size > 16 * 1024 * 1024) throw new GitFailure("index-size-limit");
      await copyFile(index, join(this.scratch, "index"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of await readdir(gitDir)) if (/^sharedindex\.[0-9a-f]+$/.test(name)) await this.linkIfPresent(join(gitDir, name), join(this.scratch, name));
  }

  private async linkIfPresent(from: string, to: string): Promise<void> {
    try { await lstat(from); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await symlink(from, to);
  }

  async read(args: string[], failure = "git-read-failed"): Promise<string> {
    const result = await this.command(args);
    if (result.code !== 0) throw new GitFailure(failure);
    return result.text;
  }

  async head(): Promise<{ branch: string | null; revision: string | null }> {
    const branch = await this.command(["symbolic-ref", "--quiet", "HEAD"]);
    if (branch.code !== 0 && branch.code !== 1) throw new GitFailure("unreadable-repository");
    const revision = await this.command(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (revision.code !== 0) {
      if (branch.code !== 0) throw new GitFailure("unreadable-repository");
      const exists = await this.command(["show-ref", "--verify", "--quiet", branch.text.trim()]);
      if (exists.code !== 1) throw new GitFailure("unreadable-repository");
    }
    return { branch: branch.code === 0 ? branch.text.trim().replace(/^refs\/heads\//, "") : null, revision: revision.code === 0 ? revision.text.trim() : null };
  }

  async worktrees(): Promise<string> {
    const result = await this.command(["worktree", "list", "--porcelain", "-z"], true);
    if (result.code !== 0) throw new GitFailure("unreadable-repository");
    return result.text;
  }
}
