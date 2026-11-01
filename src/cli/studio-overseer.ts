import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { parseProposalFile } from "../surface/mc/desk/studio/format";
import { STUDIO_MAX_FILE_BYTES } from "../surface/mc/desk/studio/read";
import { readCommittedStudioFiles } from "../surface/mc/desk/studio/committed";
import { buildStudioView } from "../surface/mc/desk/studio/view";
import { acquireStudioLock } from "../surface/mc/desk/studio/write-lock";
import { THEME_LEDGER_PATH, proposalProvenance, readThemeLedger, type ThemeLedger, type ThemeLedgerSnapshot } from "../surface/mc/desk/studio/overseer-ledger";
import { recurringThemes, selectThinking, type ThemeProposal } from "../surface/mc/desk/studio/overseer";

export const OverseerConfig = z.object({
  dir: z.string().min(1),
  deskUrl: z.url(),
  ranger: z.array(z.string().min(1)).min(1),
  staleDays: z.number().int().positive().default(6),
}).strict();
const State = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/), material: z.record(z.string(), z.string()), queued: z.record(z.string(), z.string()), pendingMaterial: z.array(z.string()).default([]), changedAt: z.record(z.string(), z.number()).default({}) });
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

async function persistProposals(input: { dir: string; pending: ThemeProposal[]; now: Date; git: (args: string[]) => Promise<string>; ledger: ThemeLedgerSnapshot; provenance: ThemeLedger; head: string; unchanged: () => Promise<void> }): Promise<string[]> {
  const writes = new Map<string, string>();
  for (const theme of input.pending) {
    const text = `---\n${stringify({ type: "question", areas: [theme.area], proposed: input.now.toISOString(), target: { place: "new", area: theme.area, reason: theme.reason } })}---\n\n## Question\n${theme.question}\n\n## Why\n${theme.reason}\n\n${theme.captures.map(id => `- Inbox capture: ${id}`).join("\n")}\n`;
    if (!parseProposalFile(`proposals/${theme.id}.md`, text).ok) throw new Error("Invalid overseer proposal");
    writes.set(`proposals/${theme.id}.md`, text);
  }
  const next: ThemeLedger = { version: 1, themes: [...input.provenance.themes, ...input.pending.map(theme => ({ proposal: theme.id, captures: theme.captures }))] };
  const ledgerText = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(ledgerText, "utf8") > STUDIO_MAX_FILE_BYTES) throw new Error("Studio theme provenance exceeds the file limit; nothing was written");
  if (JSON.stringify(next) !== JSON.stringify(input.ledger.value)) writes.set(THEME_LEDGER_PATH, ledgerText);
  if (!writes.size) return [];
  if (input.pending.length) {
    await mkdir(join(input.dir, "proposals"), { recursive: true });
    if (await realpath(join(input.dir, "proposals")) !== join(input.dir, "proposals")) throw new Error("Proposals directory must stay inside Studio");
  }
  await input.unchanged();
  const ledgerPath = join(input.dir, THEME_LEDGER_PATH);
  const present = existsSync(ledgerPath);
  if (present !== (input.ledger.text !== null) || (present && (!lstatSync(ledgerPath).isFile() || realpathSync(ledgerPath) !== ledgerPath || readFileSync(ledgerPath, "utf8") !== input.ledger.text))) throw new Error("Studio theme provenance changed before writing; deferred");
  if (input.pending.length && realpathSync(join(input.dir, "proposals")) !== join(input.dir, "proposals")) throw new Error("Proposals directory changed before writing; deferred");
  const paths = [...writes.keys()];
  const written = new Map<string, string>();
  try {
    for (const [path, text] of writes) {
      written.set(path, text);
      writeFileSync(join(input.dir, path), text, { flag: path === THEME_LEDGER_PATH && input.ledger.text !== null ? "w" : "wx" });
    }
    await input.git(["add", "--", ...paths]);
    const currentHead = await input.git(["rev-parse", "HEAD"]);
    const status = await input.git(["status", "--porcelain", "--untracked-files=all"]);
    const ownStagedFiles = status.split("\n").filter(Boolean).every(line => writes.has(line.slice(3)) && line[1] === " ");
    if (currentHead !== input.head || !ownStagedFiles || [...writes].some(([path, text]) => !lstatSync(join(input.dir, path)).isFile() || readFileSync(join(input.dir, path), "utf8") !== text)) throw new Error("Studio changed before the proposal commit; deferred");
    await input.git(["commit", "-m", "Studio: record recurring-theme provenance and proposals", "--", ...paths]);
  } catch (error) {
    const head = await input.git(["rev-parse", "HEAD"]);
    if (head !== input.head || [...written].some(([path, text]) => !existsSync(join(input.dir, path)) || !lstatSync(join(input.dir, path)).isFile() || realpathSync(join(input.dir, path)) !== join(input.dir, path) || readFileSync(join(input.dir, path), "utf8") !== text)) throw new Error("Studio proposal commit failed with a concurrent edit; files were preserved for inspection", { cause: error });
    for (const path of written.keys()) {
      if (path === THEME_LEDGER_PATH && input.ledger.text !== null) writeFileSync(join(input.dir, path), input.ledger.text);
      else unlinkSync(join(input.dir, path));
    }
    await input.git(["reset", "-q", "HEAD", "--", ...written.keys()]);
    throw new Error("Studio proposal commit failed; original provenance and files restored", { cause: error });
  }
  return input.pending.map(theme => theme.id);
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
    const ledger = await readThemeLedger(dir);
    if (ledger.text === null && await git(["log", "-1", "--format=%H", "--", THEME_LEDGER_PATH])) throw new Error("Studio theme provenance was removed; restore it before scanning");
    let previous: z.infer<typeof State> | null = null;
    try { previous = State.parse(JSON.parse(await readFile(statePath, "utf8"))); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    const [policy, desk] = await Promise.all([json(`${config.deskUrl}/api/desk/studio`).then(value => Policy.parse(value)), json(`${config.deskUrl}/api/desk`).then(value => Desk.parse(value))]);
    if (await realpath(policy.directory) !== dir) throw new Error("Desk policy belongs to another Studio directory");
    const files = await readCommittedStudioFiles(dir, head);
    const studio = buildStudioView(files, { dir, maxActive: policy.studio.maxActive }, policy.studio.areas);
    if (studio.problems.length) throw new Error("Studio has unreadable files or unknown areas; overseer deferred");
    const changedAt = new Map<string, number>();
    const material = new Map<string, string>();
    const previousMaterial = new Map(Object.entries(previous?.material ?? {}));
    const previousChangedAt = new Map(Object.entries(previous?.changedAt ?? {}));
    const newMaterial = new Set(previous?.pendingMaterial ?? []);
    for (const thread of [...studio.active, ...studio.parked, ...studio.closed]) {
      if (thread.state === "active") {
        const cached = previous?.head === head ? previousChangedAt.get(thread.slug) : undefined;
        const stamp = cached === undefined ? await git(["log", "-1", "--format=%ct", "--", thread.path]) : null;
        if (cached !== undefined) changedAt.set(thread.slug, cached);
        else if (stamp) changedAt.set(thread.slug, Number(stamp) * 1000);
      }
      material.set(thread.slug, JSON.stringify(thread.material));
      const before = previousMaterial.get(thread.slug);
      const oldMaterial = z.array(z.unknown()).parse(JSON.parse(before ?? "[]"));
      if (previous && (thread.material.length > oldMaterial.length || thread.material.some(item => !oldMaterial.some(old => JSON.stringify(old) === JSON.stringify(item))))) newMaterial.add(thread.slug);
    }
    const provenance = proposalProvenance(files.proposals, ledger.value);
    const handledCaptures = new Set(provenance.themes.flatMap(theme => theme.captures));
    const themes = recurringThemes(studio.inbox.filter(capture => !handledCaptures.has(capture.id)), studio.areas);
    const pending = themes.filter(theme => !studio.proposals.some(proposal => proposal.id === theme.id));
    const today = now.toISOString().slice(0, 10);
    const queued = new Map(Object.entries(previous?.queued ?? {}));
    const selections = selectThinking({ studio, now: now.getTime(), staleDays: config.staleDays, changedAt, newMaterial, events: [...desk.today, ...desk.ahead] }).filter(selection => queued.get(selection.thread) !== today);
    const unchanged = async (): Promise<void> => {
      if (await git(["rev-parse", "HEAD"]) !== head || await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Studio changed during overseer scan; deferred");
      if ((await readThemeLedger(dir)).text !== ledger.text) throw new Error("Studio theme provenance changed during scan; deferred");
      const fresh = await readCommittedStudioFiles(dir, head);
      if (JSON.stringify(fresh) !== JSON.stringify(files)) throw new Error("Studio files changed during overseer scan; deferred");
    };
    await unchanged();
    const proposals = await persistProposals({ dir, pending, now, git, ledger, provenance, head, unchanged });
    const save = async (): Promise<void> => {
      const state = { head: await git(["rev-parse", "HEAD"]), material: Object.fromEntries(material), queued: Object.fromEntries(queued), pendingMaterial: [...newMaterial], changedAt: Object.fromEntries(changedAt) };
      await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    };
    const enqueued: string[] = [];
    if (!pending.length) for (const selection of selections) {
      await command([...config.ranger, "job", "enqueue", "ivy-think", "--param", `thread=${selection.thread}`, "--param", `trigger=${selection.trigger}`], dir);
      queued.set(selection.thread, today);
      newMaterial.delete(selection.thread);
      enqueued.push(selection.thread);
      await save();
    }
    await save();
    return { queued: enqueued, proposals };
  } finally { await release(); }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun studio-overseer.ts <config.yaml> [--watch-studio]");
  const config = OverseerConfig.parse(parse(await readFile(path, "utf8")));
  const scan = async (): Promise<boolean> => { try { process.stdout.write(`${JSON.stringify(await runOverseer(config))}\n`); return true; } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); if (!process.argv.includes("--watch-studio")) process.exitCode = 1; return false; } };
  await scan();
  if (process.argv.includes("--watch-studio")) {
    let running = false;
    let polling = false;
    let seenHead = "";
    const check = async (): Promise<boolean> => { if (running) return false; running = true; try { return await scan(); } finally { running = false; } };
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const head = await command(["git", "rev-parse", "HEAD"], config.dir);
        if (head !== seenHead && await check()) seenHead = head;
      } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); }
      finally { polling = false; }
    };
    setInterval(() => void poll(), 5000);
    setInterval(() => void check(), 15 * 60_000);
  }
}
