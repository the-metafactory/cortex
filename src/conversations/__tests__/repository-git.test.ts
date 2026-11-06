import { describe, expect, test } from "bun:test";
import { access, appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolHost, type ToolSession } from "../tools/capabilities";
import { createRepositoryGitTools } from "../tools/repository-git";
import { directGit, gitFixture, hostileGit, snapshot } from "./fixtures/repository-git";
import { scratchHosts } from "./fixtures/scratch";
import { toolBody } from "./fixtures/tool-body";
import type { GitReadOptions } from "../tools/repository-git-runner";

const { dirs } = scratchHosts("repository-git-");
async function fixture(options: GitReadOptions = {}) {
  const dir = await dirs.make();
  const r = await gitFixture(dir);
  const session: ToolSession = { principal: "synthetic-principal", conversationId: "c", transport: "web", route: "cloud", policy: "cloud", scope: ["sample", "restricted"] };
  const host = new ToolHost({ config: () => r.config, session: () => Promise.resolve(session), tools: createRepositoryGitTools(options) });
  const call = (name: string, input: object = {}, signal = new AbortController().signal) => host.call({ conversationId: "c", route: session.route, callId: name, name: `repo_git_${name}`, input: { project: "sample", ...input }, signal });
  return { ...r, dir, session, call, host };
}

const expectNoPrivate = (value: unknown): void => {
  const text = JSON.stringify(value);
  for (const secret of ["SYNTHETIC_LOCAL_ONLY", "SYNTHETIC_EXCLUDED", "SYNTHETIC_ENV_SECRET", "synthetic-password", "synthetic-token"]) expect(text).not.toContain(secret);
};

describe("conversation Git reads", () => {
  test("status, head, history, show and all diff kinds match real Git without changing any repository bytes", async () => {
    const r = await fixture();
    const before = await snapshot(r.root);
    expect(toolBody(await r.call("head")).provenance).toMatchObject({ branch: "probe", revision: r.head });
    const status = toolBody(await r.call("status"));
    expect(status.changes).toContainEqual({ path: "beacon.txt", tracked: true, index: "M", workingTree: "M" });
    expect(status.changes).toContainEqual({ path: "untracked.txt", tracked: false, index: "?", workingTree: "?" });
    expect(status.changes).toContainEqual({ path: "deleted.txt", tracked: true, index: "D", workingTree: " " });
    const history = toolBody(await r.call("log", { path: "beacon.txt", limit: 1 }));
    expect(history.commits[0]).toMatchObject({ revision: r.head, subject: "Synthetic beacon change", paths: ["beacon.txt"] });
    expect(history.hasMore).toBe(true);
    expect(toolBody(await r.call("show", { ref: "HEAD~1" })).commit.revision).toBe(r.first);
    for (const [kind, refs, argv] of [
      ["working", {}, ["HEAD"]], ["unstaged", {}, []], ["staged", {}, ["--cached"]], ["committed", { from: "HEAD~1", to: "HEAD" }, [r.first, r.head]],
    ] as const) {
      const result = toolBody(await r.call("diff", { kind, ...refs, path: "beacon.txt" }));
      expect(result.diff).toBe(await directGit(r.root, ["diff", ...argv, "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--no-color", "--", "beacon.txt"]));
      expect(result.provenance.source).toBe(kind === "committed" ? "committed" : kind === "staged" ? "index" : "working-tree");
      expect(result.untrackedIncluded).toBe(false);
    }
    expectNoPrivate(toolBody(await r.call("show", { ref: r.first })));
    expect(await snapshot(r.root)).toEqual(before);
  });

  test("hostile configuration cannot execute clean/process filters, diff/textconv, fsmonitor, pager or hooks", async () => {
    const r = await fixture();
    const marker = await hostileGit(r.root, r.dir);
    const before = await snapshot(r.root);
    for (const name of ["status", "head", "log", "show", "diff", "worktrees"]) {
      const result = await r.call(name);
      expect(result.outcome).toBe("done");
      expectNoPrivate(result);
    }
    await expect(access(marker)).rejects.toThrow();
    expect(await snapshot(r.root)).toEqual(before);
  });

  test("credential-bearing URLs are redacted from commit subjects and patch content", async () => {
    const r = await fixture();
    const url = "https://synthetic-user:synthetic-password@git.example.invalid/project?token=synthetic-token";
    await writeFile(join(r.root, "remote.txt"), `${url}\n`);
    await directGit(r.root, ["add", "remote.txt"]);
    await directGit(r.root, ["commit", "--quiet", "-m", `Synthetic remote ${url}`]);
    const result = toolBody(await r.call("show", { path: "remote.txt" }));
    expect(result.diff).toContain("[redacted-remote]");
    expect(result.commit.subject).toContain("[redacted-remote]");
    expectNoPrivate(result);
  });

  test("ambient Git environment cannot redirect a project or enable executable helpers", async () => {
    const r = await fixture();
    const marker = await hostileGit(r.root, r.dir);
    const injected = { GIT_DIR: join(r.dir, "absent"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: join(r.dir, "helper"), GIT_EXTERNAL_DIFF: join(r.dir, "helper") };
    const previous = new Map(Object.keys(injected).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, injected);
      expect(toolBody(await r.call("head")).provenance.revision).toBe(r.head);
      expect((await r.call("diff")).outcome).toBe("done");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  test("historical case aliases cannot bypass a missing local-only source root", async () => {
    const r = await fixture();
    await rm(join(r.root, "restricted"), { recursive: true });
    await mkdir(join(r.root, "RESTRICTED"));
    await writeFile(join(r.root, "RESTRICTED", "note.txt"), "SYNTHETIC_LOCAL_ONLY uppercase\n");
    await directGit(r.root, ["-c", "core.ignorecase=false", "add", "RESTRICTED/note.txt"]);
    await directGit(r.root, ["commit", "--quiet", "-m", "Synthetic case alias"]);
    await rm(join(r.root, "RESTRICTED"), { recursive: true });
    expect((await r.call("show", { path: "RESTRICTED/note.txt" })).outcome).toBe("refused");
    expectNoPrivate(await r.call("show"));
  });

  test("deleted history obeys exclusions and nested policy; local-only reads require local policy, lane and web transport", async () => {
    const r = await fixture();
    await rm(join(r.root, "restricted"), { recursive: true });
    await rm(join(r.root, "excluded"), { recursive: true });
    const shown = toolBody(await r.call("show", { ref: r.first }));
    expect(shown.commit.paths).toEqual(["beacon.txt", "deleted.txt"]);
    expectNoPrivate(shown);
    expect((await r.call("show", { ref: r.first, path: "restricted/note.txt" })).outcome).toBe("refused");
    r.session.route = "local";
    expect((await r.call("show", { ref: r.first, path: "restricted/note.txt" })).outcome).toBe("refused");
    r.session.policy = "local";
    const local = await r.call("show", { ref: r.first, path: "restricted/note.txt" });
    expect(local.text).toContain("SYNTHETIC_LOCAL_ONLY");
    expect(local.source?.policy).toBe("local");
    r.session.transport = "discord";
    expect((await r.call("show", { ref: r.first, path: "restricted/note.txt" })).outcome).toBe("refused");
  });

  test("only permitted configured worktrees are returned without absolute paths", async () => {
    const r = await fixture();
    const allowed = join(r.dir, "allowed-tree");
    const hidden = join(r.dir, "hidden-tree");
    await directGit(r.root, ["worktree", "add", "--quiet", "--detach", allowed]);
    await directGit(r.root, ["worktree", "add", "--quiet", "--detach", hidden]);
    r.config.projects.push({ id: "allowed", root: allowed, policy: "cloud", operations: ["repo.read"] });
    r.session.scope = [...r.session.scope, "allowed"];
    const result = toolBody(await r.call("worktrees"));
    expect(result.worktrees.map((item: { project: string }) => item.project).sort()).toEqual(["allowed", "sample"]);
    expect(result.omitted).toBe(1);
    expect(JSON.stringify(result)).not.toContain(r.dir);
    const linkedConfig = { projects: [{ id: "allowed", root: allowed, policy: "cloud" as const, operations: ["repo.read" as const] }] };
    const linkedHost = new ToolHost({ config: () => linkedConfig, session: () => Promise.resolve(r.session), tools: createRepositoryGitTools() });
    const linked = await linkedHost.call({ conversationId: "c", route: "cloud", callId: "linked", name: "repo_git_show", input: { project: "allowed", path: "beacon.txt" }, signal: new AbortController().signal });
    expect(toolBody(linked).commit.revision).toBe(r.head);
  });

  test("refs, paths and unknown fields cannot supply options, traversal, ranges, reflogs, environment or commands", async () => {
    const r = await fixture();
    for (const ref of ["--help", "HEAD:beacon.txt", "HEAD..HEAD", "HEAD@{0}", "HEAD^{tree}", "HEAD\n", "HEAD~9999"]) expect((await r.call("show", { ref })).outcome).toBe("refused");
    for (const path of ["../outside", "/etc/passwd", "bad\\path", "bad\0path"]) expect((await r.call("diff", { path })).outcome).toBe("refused");
    for (const input of [{ env: { GIT_DIR: "/tmp" } }, { command: "commit" }, { limit: 100 }]) expect((await r.call("head", input)).outcome).toBe("refused");
    expect((await r.call("diff", { kind: "committed" })).outcome).toBe("refused");
    await writeFile(join(r.root, ":(glob)*"), "literal name\n");
    expect(toolBody(await r.call("diff", { path: ":(glob)*" })).diff).toBe("");
  });

  test("excluded-only commits, symlinks, nested checkouts and revoked source cannot disclose file content", async () => {
    const r = await fixture();
    await directGit(r.root, ["commit", "--quiet", "-am", "Synthetic staged state"]);
    await writeFile(join(r.root, ".env"), "SYNTHETIC_ENV_SECRET changed\n");
    await directGit(r.root, ["add", ".env"]);
    await directGit(r.root, ["commit", "--quiet", "-m", "Synthetic excluded-only change"]);
    expect(toolBody(await r.call("log", { limit: 1 })).commits).toEqual([]);
    expect((await r.call("show")).outcome).toBe("refused");
    await symlink(join(r.dir, "outside"), join(r.root, "escape"));
    expect((await r.call("diff", { path: "escape" })).outcome).toBe("refused");
    await mkdir(join(r.root, "nested"));
    await directGit(join(r.root, "nested"), ["init", "--quiet"]);
    expect((await r.call("diff", { path: "nested/file" })).outcome).toBe("refused");
    const tools = createRepositoryGitTools().map(tool => ({ ...tool, run: async (input: object, context: Parameters<typeof tool.run>[1]) => {
      const result = await tool.run(input, context);
      r.config.projects[0]!.exclude = ["beacon.txt"];
      return result;
    } }));
    const host = new ToolHost({ config: () => r.config, session: () => Promise.resolve(r.session), tools });
    const withheld = await host.call({ conversationId: "c", route: "cloud", callId: "revoke", name: "repo_git_diff", input: { project: "sample" }, signal: new AbortController().signal });
    expect(withheld.outcome).toBe("refused");
    expect(withheld.text).not.toContain("unstaged change");
  });

  test("missing Git, invalid refs, unreadable repository and budgets return explicit errors with zero content", async () => {
    const missing = await fixture({ binary: "/nonexistent/synthetic-git" });
    expect((await missing.call("status")).text).toContain('"status":"git-missing"');
    const r = await fixture();
    expect((await r.call("show", { ref: "missing-ref" })).text).toContain('"status":"invalid-ref"');
    await appendFile(join(r.root, "beacon.txt"), "b".repeat(300_000));
    expect((await r.call("diff")).text).toContain('"status":"output-limit"');
    await rm(join(r.root, ".git"), { recursive: true });
    expect((await r.call("status")).text).toContain('"status":"unreadable-repository"');
  });

  test("timeout reports an error and cancellation terminates the child without releasing partial results", async () => {
    const dir = await dirs.make();
    const sleeper = join(dir, "sleep-git");
    const pidFile = join(dir, "pid");
    await writeFile(sleeper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 30\n`, { mode: 0o755 });
    const r = await fixture({ binary: sleeper, timeoutMs: 200 });
    expect((await r.call("status")).text).toContain('"status":"timeout"');
    await rm(pidFile, { force: true });
    const active = await fixture({ binary: sleeper });
    const controller = new AbortController();
    const pending = active.call("status", {}, controller.signal);
    let cancelledPid = 0;
    const deadline = Date.now() + 10_000;
    while (!cancelledPid && Date.now() < deadline) {
      try { cancelledPid = Number(await readFile(pidFile, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!cancelledPid) await Bun.sleep(20);
    }
    expect(cancelledPid).toBeGreaterThan(0);
    controller.abort();
    expect((await pending).outcome).toBe("stopped");
    await Bun.sleep(50);
    expect(() => process.kill(cancelledPid, 0)).toThrow();
  });

  test("unborn and detached heads are explicit; empty diffs and bounded patches remain valid results", async () => {
    const r = await fixture();
    await appendFile(join(r.root, "beacon.txt"), "synthetic large patch\n".repeat(1_000));
    const result = toolBody(await r.call("diff", { path: "beacon.txt" }));
    expect(result.status).toBe("truncated");
    expect(result.diff.length).toBeLessThan(8_100);
    const unborn = join(r.dir, "unborn");
    await mkdir(unborn);
    await directGit(unborn, ["init", "--quiet", "--initial-branch=unborn"]);
    r.config.projects[0]!.root = unborn;
    expect(toolBody(await r.call("head")).provenance).toEqual({ source: "repository", branch: "unborn", revision: null });
    expect((await r.call("diff")).text).toContain('"status":"unborn-head"');
    r.config.projects[0]!.root = r.root;
    await directGit(r.root, ["checkout", "--quiet", "--detach"]);
    expect(toolBody(await r.call("head")).provenance).toMatchObject({ branch: null, revision: r.head });
  });
});
