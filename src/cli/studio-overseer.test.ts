import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOverseer } from "./studio-overseer";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const thread = (tonight = false) => `---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-10-31\nthinkTonight: ${tonight}\n---\n## Question\nWhat can we test?\n## Where I stand\nOne real repository.\n## Material\n- capture: baseline\n## Ivy's notes\n## Log\n`;

async function rig(tonight = false) {
  const dir = await mkdtemp(join(tmpdir(), "overseer-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "threads"));
  await writeFile(join(dir, "threads/alpha.md"), thread(tonight));
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", ...args], { cwd: dir }); if (result.exitCode !== 0) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-qm", "fixture");
  const calls = join(dir, ".git/calls.jsonl");
  const stub = join(dir, ".git/ranger.ts");
  await writeFile(stub, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n");`);
  const server = Bun.serve({ port: 0, fetch(request) { return Response.json(new URL(request.url).pathname.endsWith("studio") ? { directory: dir, studio: { maxActive: 5, areas: [{ id: "lab", label: "Lab", color: "blue", policy: "local" }] } } : { today: [], ahead: [] }); } });
  cleanup.push(async () => { await server.stop(true); });
  return { dir, git, calls, config: { dir, deskUrl: `http://127.0.0.1:${server.port}`, ranger: [process.execPath, stub], staleDays: 600000 } };
}

test("real committed think-tonight enqueues native arguments once, without mode", async () => {
  const r = await rig(true);
  expect(await runOverseer(r.config)).toEqual({ queued: ["alpha"], proposals: [] });
  expect(await runOverseer(r.config)).toEqual({ queued: [], proposals: [] });
  const args = JSON.parse((await readFile(r.calls, "utf8")).trim());
  expect(args).toEqual(["job", "enqueue", "ivy-think", "--param", "thread=alpha", "--param", "trigger=Asked to think tonight"]);
  expect(r.git("status", "--porcelain")).toBe("");
});

test("Material baseline and committed addition select; dirty edits defer without enqueue", async () => {
  const r = await rig();
  expect(await runOverseer(r.config)).toEqual({ queued: [], proposals: [] });
  await writeFile(join(r.dir, "threads/alpha.md"), thread().replace("baseline", "baseline\n- capture: fresh evidence"));
  await expect(runOverseer(r.config)).rejects.toThrow("uncommitted");
  r.git("add", "."); r.git("commit", "-qm", "new Material");
  expect((await runOverseer(r.config)).queued).toEqual(["alpha"]);
  expect(await readFile(r.calls, "utf8")).toContain("New Material committed");
});

test("recurring captures commit a proposal instead of enqueuing and are not proposed twice", async () => {
  const r = await rig(true);
  await mkdir(join(r.dir, "inbox"));
  for (const id of ["one", "two", "three"]) await writeFile(join(r.dir, `inbox/${id}.md`), `---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);
  r.git("add", "."); r.git("commit", "-qm", "captures");
  const first = await runOverseer(r.config);
  expect(first.queued).toEqual([]); expect(first.proposals.length).toBe(1);
  const text = await readFile(join(r.dir, `proposals/${first.proposals[0]}.md`), "utf8");
  expect(text).toContain("3 inbox captures"); expect(text).toContain("area: lab");
  expect(r.git("status", "--porcelain")).toBe("");
  expect((await runOverseer(r.config)).proposals).toEqual([]);
});


test("proposal creation preserves a simultaneous committed Material signal for the next pass", async () => {
  const r = await rig();
  await runOverseer(r.config);
  await mkdir(join(r.dir, "inbox"));
  for (const id of ["one", "two", "three"]) await writeFile(join(r.dir, `inbox/${id}.md`), `---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);
  await writeFile(join(r.dir, "threads/alpha.md"), thread().replace("baseline", "baseline\n- capture: new evidence"));
  r.git("add", "."); r.git("commit", "-qm", "new Material plus recurring captures");
  expect((await runOverseer(r.config)).proposals.length).toBe(1);
  expect((await runOverseer(r.config)).queued).toEqual(["alpha"]);
  expect(await readFile(r.calls, "utf8")).toContain("New Material committed");
});
