import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import type { ToolActivity, ToolOutcome } from "../model";
import { ToolHost, type ToolSession } from "../tools/capabilities";
import { repositoryFileTools } from "../tools/repository-files";
import { FILE_BYTES } from "../tools/repository-paths";
import { scratchHosts, openHost, answering } from "./fixtures/scratch";

const { dirs, hosts } = scratchHosts("repository-files-");
const PUBLIC = "export const syntheticBeacon = 42;";
const PRIVATE = "SYNTHETIC_WITHHELD_FILE_CONTENT";
const body = (outcome: ToolOutcome) => JSON.parse(outcome.text.slice(outcome.text.indexOf("\n") + 1, outcome.text.lastIndexOf("\n</tool-result>")));
async function fixture() {
  const dir = await dirs.make();
  const root = join(dir, "checkout");
  const privateRoot = join(root, "restricted");
  await mkdir(join(root, ".git"), { recursive: true });
  expect(await Bun.spawn(["git", "init", "--quiet", root], { stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "excluded"));
  await mkdir(privateRoot);
  await writeFile(join(root, "src", "beacon.ts"), `first line\n${PUBLIC}\nlast line\n`);
  for (const path of [join(dir, "outside.txt"), join(root, ".env"), join(root, "excluded", "note.txt"), join(privateRoot, "note.txt")]) await writeFile(path, PRIVATE);
  await symlink(join(dir, "outside.txt"), join(root, "escape.txt"));
  await symlink(dir, join(root, "escape-dir"));
  await symlink(join(root, ".env"), join(root, "alias.txt"));
  await symlink(join(root, "excluded"), join(root, "alias-dir"));
  await symlink(join(root, "src", "beacon.ts"), join(root, "safe-alias.ts"));
  const config: ToolsConfig = { projects: [
    { id: "sample", root, policy: "cloud", operations: ["repo.read"], exclude: ["excluded"] },
    { id: "restricted", root: privateRoot, policy: "local", operations: ["repo.read"] },
  ] };
  const session: ToolSession = { conversationId: "c", principal: "p", route: "cloud", policy: "cloud", transport: "web", scope: ["sample", "restricted"] };
  const seen: ToolActivity[] = [];
  const toolHost = new ToolHost({ config: () => config, session: () => Promise.resolve(session), tools: repositoryFileTools });
  const surface = () => toolHost.surface("c", session.route, activity => { seen.push(activity); return Promise.resolve(); });
  const call = (name: string, input: object, signal = new AbortController().signal) => surface().call("call", name, { project: "sample", ...input }, signal);
  return { dir, root, privateRoot, config, session, seen, surface, call };
}

describe("repository file dispatch on real checkouts", () => {
  test("reads working files with canonical citations and content provenance without git execution", async () => {
    const r = await fixture();
    const read = body(await r.call("repo_read", { path: "src/beacon.ts", startLine: 2, lines: 1 }));
    expect(read).toMatchObject({ status: "truncated", provenance: { source: "working-tree", revision: null }, results: [{ path: "src/beacon.ts", lines: [{ line: 2, text: PUBLIC }], provenance: { bytes: Buffer.byteLength(`first line\n${PUBLIC}\nlast line\n`) } }] });
    expect(read.results[0].provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body(await r.call("repo_read", { path: "safe-alias.ts" })).results[0]).toMatchObject({ path: "src/beacon.ts", lines: [{ line: 1 }, { line: 2 }, { line: 3 }] });
    await writeFile(join(r.root, "src/beacon.ts"), "changed working content\n");
    const changed = body(await r.call("repo_read", { path: "src/beacon.ts" }));
    expect(changed.results[0].lines[0].text).toBe("changed working content");
    expect(changed.results[0].provenance.sha256).not.toBe(read.results[0].provenance.sha256);
    expect(await readFile(join(r.root, "src/beacon.ts"), "utf8")).toBe("changed working content\n");
  });

  test("lists finds and literal-searches while reporting denied entries and matching line numbers", async () => {
    const r = await fixture();
    expect(body(await r.call("repo_list", { path: "src" })).results).toEqual([{ path: "src/beacon.ts", kind: "file" }]);
    expect(body(await r.call("repo_find", { query: "beacon.ts" })).results).toContainEqual({ path: "src/beacon.ts", kind: "file" });
    const search = await r.call("repo_search", { query: "SYNTHETICBEACON", caseSensitive: false });
    expect(body(search).results).toContainEqual(expect.objectContaining({ path: "src/beacon.ts", lines: [{ line: 2, text: PUBLIC, truncated: false }] }));
    expect(body(search).skipped).toContainEqual({ path: ".env", status: "denied", reason: "excluded-path" });
    expect(search.text).not.toContain(PRIVATE);
    expect(body(await r.call("repo_search", { path: "src", query: ".*" })).results).toEqual([]);
    expect((await r.call("repo_search", { query: "x", command: "cat /etc/passwd" })).outcome).toBe("refused");
  });

  test("refuses traversal absolute paths symlink escapes exclusions and nested checkout boundaries with zero bytes", async () => {
    const r = await fixture();
    await mkdir(join(r.root, "nested"));
    await writeFile(join(r.root, "nested", ".git"), "gitdir: /outside\n");
    await writeFile(join(r.root, "nested", "note.txt"), PRIVATE);
    for (const path of ["../outside.txt", join(r.dir, "outside.txt"), "escape.txt", "escape-dir/outside.txt", ".env", "alias.txt", "excluded/note.txt", "alias-dir/note.txt", "restricted/note.txt", "nested/note.txt", ".git/HEAD", "src/../../outside.txt"]) {
      const result = await r.call("repo_read", { path });
      expect(result.outcome).toBe("refused");
      expect(body(result).disclosedBytes).toBe(0);
      expect(result.text).not.toContain(PRIVATE);
    }
    expect(JSON.stringify(r.seen)).not.toContain(PRIVATE);
  });

  test("local-only projects require local policy local model and web, including parent-project aliases", async () => {
    const r = await fixture();
    for (const [route, policy, transport] of [["cloud", "cloud", "web"], ["cloud:other", "local", "web"], ["local", "cloud", "web"], ["local", "local", "discord"]] as const) {
      Object.assign(r.session, { route, policy, transport });
      for (const project of ["sample", "restricted"]) {
        const result = await r.call("repo_read", { project, path: project === "sample" ? "restricted/note.txt" : "note.txt" });
        expect(result.outcome).toBe("refused");
        expect(result.text).not.toContain(PRIVATE);
      }
    }
    Object.assign(r.session, { route: "local", policy: "local", transport: "web" });
    expect((await r.call("repo_read", { project: "restricted", path: "note.txt" })).text).toContain(PRIVATE);
    expect((await r.call("repo_read", { path: "restricted/note.txt" })).source).toMatchObject({ id: "sample", policy: "local" });
    r.config.projects[0]!.policy = "unknown" as "cloud";
    expect((await r.call("repo_read", { path: "src/beacon.ts" })).outcome).toBe("refused");
  });

  test("skipped files cannot exhaust search match slots or stop traversal", async () => {
    const r = await fixture();
    await mkdir(join(r.root, "mixed"));
    for (let i = 0; i < 45; i++) await writeFile(join(r.root, "mixed", `binary-${i}.png`), Buffer.from([0, 1, 255]));
    await writeFile(join(r.root, "mixed", "symbol.ts"), PUBLIC);
    const result = body(await r.call("repo_search", { path: "mixed", query: "syntheticBeacon", limit: 1 }));
    expect(result.results).toContainEqual(expect.objectContaining({ path: "mixed/symbol.ts", lines: [{ line: 1, text: PUBLIC, truncated: false }] }));
    expect(result.results).toHaveLength(1);
    expect(result.skippedCount).toBe(45);
    expect(result.skipped.length).toBeLessThanOrEqual(40);
    expect(result.reasons).toContain("skipped-limit");
    expect(result.reasons).not.toContain("result-limit");
  });

  test("file provenance is shared across the documented default and maximum read ranges", async () => {
    const r = await fixture();
    await writeFile(join(r.root, "short-lines.txt"), "short\n".repeat(220));
    for (const lines of [undefined, 200]) {
      const result = body(await r.call("repo_read", { path: "short-lines.txt", ...(lines ? { lines } : {}) }));
      expect(result.results).toHaveLength(1);
      expect(result.results[0].lines).toHaveLength(lines ?? 100);
      expect(result.results[0].provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.reasons).toEqual(["line-range"]);
      expect(result.disclosedBytes).toBe((lines ?? 100) * 5);
    }
    await writeFile(join(r.root, "long-lines.txt"), `${"x".repeat(1000)}\n`.repeat(20));
    const output = body(await r.call("repo_read", { path: "long-lines.txt" }));
    expect(output.reasons).toEqual(["output-limit"]);
    expect(output.results[0].lines.length).toBeLessThan(20);
  });

  test("case variants retain exclusions and nested source policy", async () => {
    const r = await fixture();
    for (const [path, status] of [
      ["EXCLUDED/note.txt", "denied"],
      ["EXCLUDED/missing.txt", "denied"],
      ["RESTRICTED/note.txt", existsSync(join(r.root, "RESTRICTED/note.txt")) ? "denied" : "missing"],
    ] as const) {
      const result = await r.call("repo_read", { path });
      expect(result.text).not.toContain(PRIVATE);
      expect(body(result).disclosedBytes).toBe(0);
      expect(body(result).status).toBe(status);
    }
    r.config.projects[0]!.exclude = ["ExClUdEd"];
    const excluded = await r.call("repo_read", { path: "excluded/note.txt" });
    expect(excluded.outcome).toBe("refused");
    expect(body(excluded).disclosedBytes).toBe(0);
    const nestedAlias = join(r.root, "RESTRICTED");
    if (existsSync(join(nestedAlias, "note.txt"))) {
      r.config.projects[1]!.root = nestedAlias;
      expect((await r.call("repo_read", { path: "restricted/note.txt" })).outcome).toBe("refused");
    }
  });

  test("environment variants and roots below protected directories cannot expose file bytes", async () => {
    const r = await fixture();
    for (const name of ["prod.env", ".envrc", ".env.production"]) {
      await writeFile(join(r.root, name), PRIVATE);
      const result = await r.call("repo_read", { path: name });
      expect(result.outcome).toBe("refused");
      expect(body(result).disclosedBytes).toBe(0);
    }
    for (const path of [".config/provider", ".git/hooks", "private/nested"]) {
      const root = join(r.root, path);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "note.txt"), PRIVATE);
      r.config.projects[0]!.root = root;
      const result = await r.call("repo_read", { path: "note.txt" });
      expect(result.outcome).toBe("refused");
      expect(body(result).disclosedBytes).toBe(0);
    }
  });

  test("canonical configured roots work through aliases but protected roots cannot be registered around exclusions", async () => {
    const r = await fixture();
    const alias = join(r.dir, "root-alias");
    await symlink(r.root, alias);
    r.config.projects[0]!.root = alias;
    expect((await r.call("repo_read", { path: "src/beacon.ts" })).text).toContain(PUBLIC);
    r.config.projects[0]!.root = join(r.root, ".git");
    expect((await r.call("repo_list", {})).outcome).toBe("refused");
  });

  test("revocation and exclusion changes during dispatch withhold content and invalidate pinned surfaces", async () => {
    for (const revoke of [(r: Awaited<ReturnType<typeof fixture>>) => { r.session.scope = []; }, (r: Awaited<ReturnType<typeof fixture>>) => { r.config.projects[0]!.exclude = ["src"]; }]) {
      const r = await fixture();
      const surface = r.surface();
      await surface.validate!();
      const pending = surface.call("revoke", "repo_read", { project: "sample", path: "src/beacon.ts" }, new AbortController().signal);
      revoke(r);
      const result = await pending;
      expect(result.outcome).toBe("refused");
      expect(result.text).not.toContain(PUBLIC);
      expect(JSON.stringify(r.seen)).not.toContain(PUBLIC);
      await expect(surface.validate!()).rejects.toThrow("changed");
    }
  });

  test("distinguishes missing unreadable binary size and result truncation and cancellation", async () => {
    const r = await fixture();
    await writeFile(join(r.root, "binary.dat"), Buffer.from([0, 1, 255]));
    await writeFile(join(r.root, "large.txt"), "x".repeat(FILE_BYTES + 1));
    await writeFile(join(r.root, "lines.txt"), `${"long".repeat(1000)}\n${Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n")}\n`);
    await writeFile(join(r.root, "unreadable.txt"), PRIVATE);
    await chmod(join(r.root, "unreadable.txt"), 0);
    try {
      for (const [path, status, outcome] of [["missing.txt", "missing", "error"], ["src", "unreadable", "error"], ["binary.dat", "binary", "error"], ["large.txt", "truncated", "done"], ["unreadable.txt", "unreadable", "error"]] as const) {
        const result = await r.call("repo_read", { path });
        expect(result.outcome).toBe(outcome);
        expect(body(result)).toMatchObject({ status, disclosedBytes: 0 });
      }
    } finally { await chmod(join(r.root, "unreadable.txt"), 0o600); }
    const lines = body(await r.call("repo_read", { path: "lines.txt", lines: 200 }));
    expect(lines.truncated).toBe(true);
    expect(lines.results[0].lines[0].text.length).toBe(1000);
    expect((await r.call("repo_read", { path: "lines.txt", lines: 201 })).outcome).toBe("refused");
    expect(body(await r.call("repo_search", { query: "line", limit: 1 })).truncated).toBe(true);
    const controller = new AbortController();
    const pending = r.call("repo_search", { query: "line" }, controller.signal);
    controller.abort();
    expect((await pending).outcome).toBe("stopped");
  });

  test("revocation after actual file IO and cancellation of active traversal release no content", async () => {
    const r = await fixture();
    let readText = "";
    const wrapped = repositoryFileTools.map(tool => ({ ...tool, run: async (input: object, context: Parameters<typeof tool.run>[1]) => {
      const result = await tool.run(input, context);
      readText = typeof result === "string" ? result : result.text;
      r.session.scope = [];
      return result;
    } }));
    const revoked = new ToolHost({ config: () => r.config, session: () => Promise.resolve(r.session), tools: wrapped }).surface("c", "cloud", activity => { r.seen.push(activity); return Promise.resolve(); });
    const result = await revoked.call("after-read", "repo_read", { project: "sample", path: "src/beacon.ts" }, new AbortController().signal);
    expect(readText).toContain(PUBLIC);
    expect(result.outcome).toBe("refused");
    expect(JSON.stringify(r.seen)).not.toContain(PUBLIC);
    r.session.scope = ["sample", "restricted"];
    const entered = Promise.withResolvers<undefined>();
    const running = repositoryFileTools.map(tool => ({ ...tool, run: (input: object, context: Parameters<typeof tool.run>[1]) => {
      const work = tool.run(input, context);
      entered.resolve(undefined);
      return work;
    } }));
    const active = new ToolHost({ config: () => r.config, session: () => Promise.resolve(r.session), tools: running }).surface("c", "cloud", activity => { r.seen.push(activity); return Promise.resolve(); });
    const controller = new AbortController();
    const pending = active.call("active-search", "repo_search", { project: "sample", query: "syntheticBeacon" }, controller.signal);
    await entered.promise;
    await setImmediate();
    controller.abort();
    const stopped = await pending;
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.text).not.toContain(PUBLIC);
    expect(JSON.stringify(r.seen)).not.toContain(PUBLIC);
  });

  test("traversal and byte budgets stop broad searches; depth and output limits are explicit", async () => {
    const r = await fixture();
    await mkdir(join(r.root, "src", "deep"));
    await writeFile(join(r.root, "src", "deep", "deep.txt"), PUBLIC);
    const shallow = body(await r.call("repo_search", { path: "src", depth: 0, query: "syntheticBeacon" }));
    expect(shallow.reasons).toContain("depth-limit");
    expect(shallow.results.every((item: { path: string }) => item.path !== "src/deep/deep.txt")).toBe(true);
    for (let i = 0; i < 12; i++) await writeFile(join(r.root, "src", `budget-${i}.txt`), "n".repeat(FILE_BYTES));
    expect(body(await r.call("repo_search", { path: "src", query: "absent" })).reasons).toContain("read-byte-limit");
  });

  test("default conversation integration searches and cites a symbol, records refusals with no disclosed private bytes", async () => {
    const r = await fixture();
    const outcomes: ToolOutcome[] = [];
    const host = await openHost(hosts, { dir: join(r.dir, "conversation"), stack: "test", label: "test", expectedLabel: "test", lanes: { cloud: { provider: "synthetic", model: "cloud" } }, tools: { config: () => r.config }, turns: answering(async request => {
      const found = await request.tools!.call("find", "repo_search", { project: "sample", path: "src", query: "syntheticBeacon" }, request.signal);
      outcomes.push(found);
      outcomes.push(await request.tools!.call("escape", "repo_read", { project: "sample", path: "../outside.txt" }, request.signal));
      outcomes.push(await request.tools!.call("local", "repo_read", { project: "restricted", path: "note.txt" }, request.signal));
      const hit = body(found).results[0];
      return `${hit.path}:${hit.lines[0].line}: ${hit.lines[0].text}`;
    }) });
    const conversation = await host.create({ title: "Find the synthetic symbol", links: [], origin: { kind: "web" }, policy: "cloud" }, "synthetic-principal");
    await host.submit(conversation.id, { inputId: "probe", transport: "web", text: "Find syntheticBeacon and cite its lines.", mode: "queue" });
    await host.waitForIdle(conversation.id);
    expect(await host.input(conversation.id, "probe")).toMatchObject({ status: "done", answer: `src/beacon.ts:2: ${PUBLIC}` });
    expect(outcomes.map(outcome => outcome.outcome)).toEqual(["done", "refused", "refused"]);
    expect(body(outcomes[1]!).disclosedBytes).toBe(0);
    const records = JSON.stringify(await host.entries(conversation.id, 100, undefined));
    expect(records).not.toContain(PRIVATE);
    expect(records).toContain('working-tree');
  });

  test("tightening a nested source after a parent read blocks history forwarding across restart", async () => {
    const r = await fixture();
    r.config.projects[1]!.policy = "cloud";
    let requests = 0;
    const options = { dir: join(r.dir, "history"), stack: "test", label: "test", expectedLabel: "test", lanes: { cloud: { provider: "synthetic", model: "cloud" } }, tools: { config: () => r.config }, turns: answering(async request => {
      requests++;
      return (await request.tools!.call("read", "repo_read", { project: "sample", path: "restricted/note.txt" }, request.signal)).text;
    }) };
    const host = await openHost(hosts, options);
    const conversation = await host.create({ title: "Registry-bound history", links: [], origin: { kind: "web" }, policy: "cloud" }, "synthetic-principal");
    await host.submit(conversation.id, { inputId: "first", transport: "web", text: "Read the nested source", mode: "queue" });
    await host.waitForIdle(conversation.id);
    expect((await host.input(conversation.id, "first")).answer).toContain(PRIVATE);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    r.config.projects[1]!.policy = "local";
    const restarted = await openHost(hosts, options);
    await expect(restarted.submit(conversation.id, { inputId: "again", transport: "web", text: "Repeat the previous answer", mode: "queue" })).rejects.toThrow("revoked or changed");
    expect(requests).toBe(1);
  });
});
