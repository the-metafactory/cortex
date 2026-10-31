import { watch } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { parseProposalFile } from "../surface/mc/desk/studio/format";
import { readStudioFiles } from "../surface/mc/desk/studio/read";
import { buildStudioView } from "../surface/mc/desk/studio/view";
import { acquireStudioLock } from "../surface/mc/desk/studio/write-lock";
import { recurringThemes, selectThinking } from "../surface/mc/desk/studio/overseer";

export const OverseerConfig = z.object({
  dir: z.string().min(1),
  deskUrl: z.url(),
  ranger: z.array(z.string().min(1)).min(1),
  staleDays: z.number().int().positive().default(6),
}).strict();
const State = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/), material: z.record(z.string(), z.string()), queued: z.record(z.string(), z.string()), pendingMaterial: z.array(z.string()).default([]) });
const Event = z.object({ key: z.string(), at: z.number(), title: z.string(), area: z.string().nullable(), kind: z.enum(["meeting", "all-day", "reminder", "agent", "agent-stop"]) });
const Desk = z.object({ today: z.array(Event), ahead: z.array(Event) });
const Policy = z.object({ directory: z.string(), studio: z.object({ maxActive: z.number(), areas: z.array(z.object({ id: z.string(), label: z.string(), color: z.string(), policy: z.enum(["local", "cloud"]) })) }) });

async function command(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { child.kill(); }, 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Overseer command failed (${argv[0]}): ${stderr.trim()}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`Desk returned ${response.status}`);
  return response.json();
}

export async function runOverseer(config: z.infer<typeof OverseerConfig>, now = new Date()): Promise<{ queued: string[]; proposals: string[] }> {
  const dir = await realpath(config.dir);
  const release = await acquireStudioLock(dir);
  if (!release) throw new Error("Another Studio writer holds the lock");
  try {
    const git = (args: string[]) => command(["git", ...args], dir);
    if (await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Studio has uncommitted changes; overseer deferred");
    const head = await git(["rev-parse", "HEAD"]);
    const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
    const statePath = join(gitDir, "studio-overseer.json");
    let previous: z.infer<typeof State> | null = null;
    try { previous = State.parse(JSON.parse(await readFile(statePath, "utf8"))); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    const [policy, desk] = await Promise.all([json(`${config.deskUrl}/api/desk/studio`).then(value => Policy.parse(value)), json(`${config.deskUrl}/api/desk`).then(value => Desk.parse(value))]);
    if (await realpath(policy.directory) !== dir) throw new Error("Desk policy belongs to another Studio directory");
    const read = await readStudioFiles(dir);
    if (read.problems.length) throw new Error(`Studio read failed: ${read.problems.map(problem => problem.reason).join("; ")}`);
    const studio = buildStudioView(read.files, { dir, maxActive: policy.studio.maxActive }, policy.studio.areas);
    if (studio.problems.length) throw new Error("Studio has unreadable files or unknown areas; overseer deferred");
    const changedAt = new Map<string, number>();
    const material: Record<string, string> = {};
    const newMaterial = new Set(previous?.pendingMaterial ?? []);
    for (const thread of [...studio.active, ...studio.parked, ...studio.closed]) {
      const stamp = await git(["log", "-1", "--format=%ct", "--", thread.path]);
      if (stamp) changedAt.set(thread.slug, Number(stamp) * 1000);
      material[thread.slug] = JSON.stringify(thread.material);
      const before = previous?.material[thread.slug];
      const oldMaterial = z.array(z.unknown()).parse(JSON.parse(before ?? "[]"));
      if (previous && (thread.material.length > oldMaterial.length || thread.material.some(item => !oldMaterial.some(old => JSON.stringify(old) === JSON.stringify(item))))) newMaterial.add(thread.slug);
    }
    const proposedCaptures = read.files.proposals.map(file => file.text).join("\n");
    const themes = recurringThemes(studio.inbox.filter(capture => !proposedCaptures.includes(`- Inbox capture: ${capture.id}\n`)), studio.areas);
    const proposals: string[] = [];
    const pending = themes.filter(theme => !studio.proposals.some(proposal => proposal.id === theme.id));
    const today = now.toISOString().slice(0, 10);
    const queued = previous?.queued ?? {};
    const selections = selectThinking({ studio, now: now.getTime(), staleDays: config.staleDays, changedAt, newMaterial, events: [...desk.today, ...desk.ahead] }).filter(selection => queued[selection.thread] !== today);
    const unchanged = async (): Promise<void> => {
      if (await git(["rev-parse", "HEAD"]) !== head || await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Studio changed during overseer scan; deferred");
      const fresh = await readStudioFiles(dir);
      if (JSON.stringify(fresh.files) !== JSON.stringify(read.files)) throw new Error("Studio files changed during overseer scan; deferred");
    };
    await unchanged();
    for (const theme of pending) {
      const text = `---\n${stringify({ type: "question", areas: [theme.area], proposed: now.toISOString(), target: { place: "new", area: theme.area, reason: theme.reason } })}---\n\n## Question\n${theme.question}\n\n## Why\n${theme.reason}\n\n${theme.captures.map(id => `- Inbox capture: ${id}`).join("\n")}\n`;
      if (!parseProposalFile(`proposals/${theme.id}.md`, text).ok) throw new Error("Invalid overseer proposal");
      await mkdir(join(dir, "proposals"), { recursive: true });
      if (await realpath(join(dir, "proposals")) !== join(dir, "proposals")) throw new Error("Proposals directory must stay inside Studio");
      await writeFile(join(dir, `proposals/${theme.id}.md`), text, { flag: "wx" });
      proposals.push(theme.id);
    }
    if (proposals.length) {
      await git(["add", "--", ...proposals.map(id => `proposals/${id}.md`)]);
      await git(["commit", "-m", "Studio: propose threads from recurring inbox themes", "--", ...proposals.map(id => `proposals/${id}.md`)]);
    }
    const enqueued: string[] = [];
    if (!pending.length) for (const selection of selections) {
      await command([...config.ranger, "job", "enqueue", "ivy-think", "--param", `thread=${selection.thread}`, "--param", `trigger=${selection.trigger}`], dir);
      queued[selection.thread] = today;
      newMaterial.delete(selection.thread);
      enqueued.push(selection.thread);
    }
    const state = { head: await git(["rev-parse", "HEAD"]), material, queued, pendingMaterial: [...newMaterial] };
    await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
    return { queued: enqueued, proposals };
  } finally { await release(); }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun studio-overseer.ts <config.yaml> [--watch]");
  const config = OverseerConfig.parse(parse(await readFile(path, "utf8")));
  const scan = async (): Promise<void> => { try { process.stdout.write(`${JSON.stringify(await runOverseer(config))}\n`); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); if (!process.argv.includes("--watch")) process.exitCode = 1; } };
  await scan();
  if (process.argv.includes("--watch")) {
    let running = false;
    const check = async (): Promise<void> => { if (running) return; running = true; try { await scan(); } finally { running = false; } };
    let timer: ReturnType<typeof setTimeout>;
    watch(config.dir, { recursive: true }, (_event, filename) => {
      if (!filename?.startsWith("threads/")) return;
      clearTimeout(timer);
      timer = setTimeout(() => void check(), 1500);
    });
    setInterval(() => void check(), 15 * 60_000);
  }
}
