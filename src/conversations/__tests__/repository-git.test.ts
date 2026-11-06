import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import type { ToolOutcome } from "../model";
import { ToolHost, type ToolDefinition, type ToolSession } from "../tools/capabilities";
import { createRepositoryGitTools, repositoryGitTools } from "../tools/repository-git";
import { scratchHosts } from "./fixtures/scratch";

const { dirs } = scratchHosts("repository-git-");
const WITHHELD = "SYNTHETIC_WITHHELD_GIT_CONTENT";
const IDENTITY = ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

async function git(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...IDENTITY, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out.trim();
}

const body = (outcome: ToolOutcome) => JSON.parse(outcome.text.slice(outcome.text.indexOf("\n") + 1, outcome.text.lastIndexOf("\n</tool-result>")));

function treeFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else hash.update(path).update(String(stat.mtimeMs)).update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest("hex");
}

async function fixture(definitions: readonly ToolDefinition[] = repositoryGitTools) {
  const dir = await realpath(await dirs.make());
  const root = join(dir, "checkout");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "excluded"));
  await mkdir(join(root, "restricted"));
  await git(dir, "init", "--quiet", "-b", "main", root);
  await writeFile(join(root, "src", "beacon.ts"), "export const beacon = 1;\n");
  await writeFile(join(root, "excluded", "note.txt"), `${WITHHELD} one\n`);
  await writeFile(join(root, ".env"), `${WITHHELD} env\n`);
  await writeFile(join(root, "restricted", "note.txt"), `${WITHHELD} restricted\n`);
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "first commit");
  await writeFile(join(root, "src", "beacon.ts"), "export const beacon = 2;\n");
  await writeFile(join(root, "excluded", "note.txt"), `${WITHHELD} two\n`);
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "second commit");
  const config: ToolsConfig = { projects: [
    { id: "sample", root, policy: "cloud", operations: ["repo.read"], exclude: ["excluded", "restricted"] },
    { id: "restricted", root: join(root, "restricted"), policy: "local", operations: ["repo.read"] },
  ] };
  const session: ToolSession = { conversationId: "c", principal: "p", route: "cloud", policy: "cloud", transport: "web", scope: ["sample", "restricted"] };
  const host = new ToolHost({ config: () => config, session: () => Promise.resolve(session), tools: definitions });
  const call = (name: string, input: object = {}, signal = new AbortController().signal) => host.surface("c", session.route, () => Promise.resolve()).call("call", name, { project: "sample", ...input }, signal);
  return { dir, root, config, session, call };
}

describe("repository Git reads through conversation dispatch", () => {
  test("status separates tracked from untracked and names no excluded path, and every read leaves the repository unchanged", async () => {
    const r = await fixture();
    await writeFile(join(r.root, "src", "beacon.ts"), "export const beacon = 3;\n");
    await writeFile(join(r.root, "src", "staged.ts"), "export const staged = true;\n");
    await git(r.root, "add", "src/staged.ts");
    await writeFile(join(r.root, "src", "fresh.ts"), "export const fresh = true;\n");
    await writeFile(join(r.root, "excluded", "note.txt"), `${WITHHELD} three\n`);
    await writeFile(join(r.root, "excluded", "fresh.txt"), `${WITHHELD} four\n`);
    const before = treeFingerprint(r.root);

    const status = await r.call("git_status");
    expect(status.outcome).toBe("done");
    const read = body(status);
    expect(read.provenance).toMatchObject({ source: "git", branch: "main", head: await git(r.root, "rev-parse", "HEAD") });
    expect(read.tracked).toContainEqual({ path: "src/beacon.ts", staged: ".", unstaged: "M", conflicted: false });
    expect(read.tracked).toContainEqual({ path: "src/staged.ts", staged: "A", unstaged: ".", conflicted: false });
    expect(read.untracked).toEqual(["src/fresh.ts"]);
    expect(read.withheldPaths).toBe(2);
    expect(status.text).not.toContain("note.txt");

    const unstaged = body(await r.call("git_diff"));
    expect(unstaged).toMatchObject({ source: "working-tree", withheldPaths: 1 });
    expect(unstaged.patch).toContain("+export const beacon = 3;");
    expect(unstaged.patch).not.toContain("staged");
    const staged = body(await r.call("git_diff", { scope: "staged" }));
    expect(staged.source).toBe("index");
    expect(staged.patch).toContain("+export const staged = true;");

    for (const name of ["git_log", "git_show", "git_worktrees"]) expect((await r.call(name)).outcome).toBe("done");
    expect(treeFingerprint(r.root)).toBe(before);
  });

  test("log finds a path's last change, show and commit diffs cite committed evidence and withhold excluded files", async () => {
    const r = await fixture();
    const head = await git(r.root, "rev-parse", "HEAD");
    const first = await git(r.root, "rev-parse", "HEAD~1");

    const log = body(await r.call("git_log", { path: "src/beacon.ts", limit: 1 }));
    expect(log).toMatchObject({ status: "truncated", source: "committed", reasons: ["result-limit"], nextSkip: 1, commits: [{ sha: head, subject: "second commit" }] });

    const shown = await r.call("git_show", { ref: "HEAD" });
    const commit = body(shown);
    expect(commit).toMatchObject({ source: "committed", commit: { sha: head, parents: [first], message: "second commit" }, withheldPaths: 1, files: [{ status: "M", path: "src/beacon.ts" }] });
    expect(commit.patch).toContain("+export const beacon = 2;");
    expect(shown.text).not.toContain(WITHHELD);

    const root = body(await r.call("git_show", { ref: first }));
    expect(root.commit.parents).toEqual([]);
    expect(root.files).toEqual([{ status: "A", path: "src/beacon.ts" }]);
    expect(root.withheldPaths).toBe(3);

    const range = await r.call("git_diff", { scope: "commits", base: first, head: "HEAD" });
    expect(body(range)).toMatchObject({ source: "committed", base: first, head, withheldPaths: 1 });
    expect(range.text).not.toContain(WITHHELD);
  });

  test("a requested excluded or escaping path is refused before Git reads it", async () => {
    const r = await fixture();
    for (const path of ["excluded/note.txt", "EXCLUDED/note.txt", ".env", "../outside", "/etc/hosts"]) {
      const log = await r.call("git_log", { path });
      expect(log.outcome).toBe("refused");
      expect(body(log)).toMatchObject({ status: "denied", disclosedBytes: 0 });
      const diff = await r.call("git_diff", { path });
      expect(diff.outcome).toBe("refused");
      expect(diff.text).not.toContain(WITHHELD);
    }
  });

  test("repository configuration and attributes cannot turn a read into code execution", async () => {
    const r = await fixture();
    const marker = join(r.dir, "executed");
    const helper = join(r.dir, "helper.sh");
    await writeFile(helper, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    await chmod(helper, 0o755);
    const settings: [string, string][] = [
      ["core.fsmonitor", helper],
      ["core.pager", helper],
      ["core.hooksPath", r.dir],
      ["diff.external", helper],
      ["diff.evil.command", helper],
      ["diff.evil.textconv", helper],
      ["filter.evil.clean", helper],
      ["filter.evil.smudge", helper],
      ["filter.evil.required", "true"],
      ["log.showSignature", "true"],
      ["gpg.program", helper],
      ["alias.status", `!${helper}`],
    ];
    for (const [key, value] of settings) await git(r.root, "config", key, value);
    await writeFile(join(r.root, ".gitattributes"), "*.ts filter=evil diff=evil\n");
    await writeFile(join(r.root, "src", "beacon.ts"), "export const beacon = 4;\n");
    for (const [name, input] of [["git_status", {}], ["git_diff", {}], ["git_log", {}], ["git_show", {}], ["git_worktrees", {}]] as const) {
      const outcome = await r.call(name, input);
      expect(outcome.outcome).toBe("done");
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("option-shaped, range and unknown revisions never reach Git as options", async () => {
    const r = await fixture();
    const marker = join(r.dir, "written");
    for (const ref of [`--output=${marker}`, "-n1", "HEAD..main", "HEAD:src", "$(touch x)"]) {
      expect((await r.call("git_log", { ref })).outcome).toBe("refused");
    }
    expect(existsSync(marker)).toBe(false);
    const unknown = await r.call("git_show", { ref: "does-not-exist" });
    expect(unknown.outcome).toBe("error");
    expect(body(unknown)).toMatchObject({ status: "invalid-ref" });
  });

  test("local-only sources stay closed to cloud lanes and Discord, and a local conversation can read them", async () => {
    const r = await fixture();
    const cloud = await r.call("git_status", { project: "restricted" });
    expect(cloud.outcome).toBe("refused");
    expect(cloud.text).not.toContain(WITHHELD);

    const privateRoot = join(r.dir, "localsource");
    await mkdir(privateRoot);
    await git(r.dir, "init", "--quiet", "-b", "main", privateRoot);
    r.config.projects.push({ id: "private", root: privateRoot, policy: "local", operations: ["repo.read"] });
    const local: ToolSession = { ...r.session, route: "local", policy: "local", scope: ["private"] };
    const host = new ToolHost({ config: () => r.config, session: () => Promise.resolve(local), tools: repositoryGitTools });
    const allowed = await host.surface("c", "local", () => Promise.resolve()).call("call", "git_status", { project: "private" }, new AbortController().signal);
    expect(allowed.outcome).toBe("done");
    expect(allowed.source?.policy).toBe("local");

    const discord: ToolSession = { ...local, transport: "discord" };
    const refused = await new ToolHost({ config: () => r.config, session: () => Promise.resolve(discord), tools: repositoryGitTools }).surface("c", "local", () => Promise.resolve()).call("call", "git_status", { project: "private" }, new AbortController().signal);
    expect(refused.outcome).toBe("refused");
  });

  test("worktrees outside permitted sources are counted, not named, and remote URLs lose their secrets", async () => {
    const r = await fixture();
    const outside = join(r.dir, "outside-worktree");
    await git(r.root, "worktree", "add", "--quiet", "-b", "outside", outside);
    const inner = join(r.dir, "second");
    await git(r.root, "worktree", "add", "--quiet", "-b", "second", inner);
    r.config.projects.push({ id: "second", root: inner, policy: "cloud", operations: ["repo.read"] });
    r.session.scope = [...r.session.scope, "second"];
    await git(r.root, "remote", "add", "origin", "https://synthetic-user:synthetic-secret@git.example.invalid/group/repo.git?token=synthetic-secret");
    await git(r.root, "remote", "add", "scp", "git@git.example.invalid:group/repo.git");

    const listed = await r.call("git_worktrees");
    expect(listed.text).not.toContain("outside");
    const read = body(listed);
    expect(read.withheldWorktrees).toBe(1);
    expect(read.worktrees).toEqual([
      expect.objectContaining({ project: "sample", path: ".", branch: "main", detached: false }),
      expect.objectContaining({ project: "second", path: ".", branch: "second" }),
    ]);

    const status = await r.call("git_status");
    expect(status.text).not.toContain("synthetic-secret");
    expect(body(status).remotes).toEqual(expect.arrayContaining([
      { name: "origin", url: "https://git.example.invalid/group/repo.git" },
      { name: "scp", url: "git@git.example.invalid:group/repo.git" },
    ]));
  });

  test("a source that is not the top of its checkout, missing Git and a slow Git are reported distinctly", async () => {
    const r = await fixture();
    const subdir = join(r.root, "src");
    r.config.projects.push({ id: "nested", root: subdir, policy: "cloud", operations: ["repo.read"] });
    r.session.scope = [...r.session.scope, "nested"];
    const nested = await r.call("git_status", { project: "nested" });
    expect(body(nested)).toMatchObject({ status: "not-a-repository", disclosedBytes: 0 });

    const plain = join(r.dir, "plain");
    await mkdir(plain);
    r.config.projects.push({ id: "plain", root: plain, policy: "cloud", operations: ["repo.read"] });
    r.session.scope = [...r.session.scope, "plain"];
    expect(body(await r.call("git_status", { project: "plain" }))).toMatchObject({ status: "not-a-repository" });

    const missing = await fixture(createRepositoryGitTools({ git: join(r.dir, "no-such-git") }));
    expect(body(await missing.call("git_status"))).toMatchObject({ status: "git-missing" });

    const slowGit = join(r.dir, "slow-git");
    await writeFile(slowGit, "#!/bin/sh\nexec sleep 30\n");
    await chmod(slowGit, 0o755);
    const slow = await fixture(createRepositoryGitTools({ git: slowGit, timeoutMs: 50 }));
    expect(body(await slow.call("git_status"))).toMatchObject({ status: "timeout" });

    const cancelled = await fixture(createRepositoryGitTools({ git: slowGit }));
    const controller = new AbortController();
    const pending = cancelled.call("git_status", {}, controller.signal);
    controller.abort();
    expect((await pending).outcome).toBe("stopped");
  });

  test("a large patch pages through nextOffset and a nested checkout stays out of the patch", async () => {
    const r = await fixture();
    await writeFile(join(r.root, "src", "beacon.ts"), Array.from({ length: 2_000 }, (_unused, line) => `export const value${line} = ${line};`).join("\n"));
    const first = body(await r.call("git_diff", { limit: 1_000 }));
    expect(first).toMatchObject({ status: "truncated", reasons: ["patch-window"], nextOffset: 1_000 });
    expect(first.patch.length).toBe(1_000);
    const second = body(await r.call("git_diff", { offset: 1_000, limit: 1_000 }));
    expect(second.patch.length).toBe(1_000);
    expect(second.patch).not.toBe(first.patch);

    const nested = join(r.root, "vendor");
    await mkdir(nested);
    await git(r.dir, "init", "--quiet", "-b", "main", nested);
    await writeFile(join(nested, "secret.txt"), `${WITHHELD} nested\n`);
    const status = await r.call("git_status");
    expect(status.text).not.toContain("vendor");
    expect(body(status).withheldPaths).toBe(1);
    await rm(nested, { recursive: true });
  });
});
