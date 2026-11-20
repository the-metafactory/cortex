import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DeskStudioDraftWrite } from "../../../desk-api";
import { startServer } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";

export const DraftSchema = z.object({ text: z.string(), revision: z.string().min(1), editable: z.boolean() });

const draftThreadFile = (type = "question", state = "active"): string => `---\ntype: ${type}\nareas: [lab]\nstate: ${state}\nopened: 2026-11-01\n${state === "closed" ? "outcome: dropped\n" : ""}---\n\n## Question\n\nA fixture ${type}?\n\n## Where I stand\n\nA separate stand.\n\n## Assistant's notes\n\n### 2026-11-02T10:00:00Z\ntrigger: fixture\nmodel: local\nkind: note\nstatus: kept\n\nA separate note.\n`;

function rawDraftGit(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync([join(dir, "..", "bin", "git"), "-C", dir, ...args], {
    env: process.env,
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

const draftGit = (dir: string, ...args: string[]): string => rawDraftGit(dir, ...args).trim();

async function serveDraftFixture(root: string, studioDir: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = Bun.spawn([process.execPath, import.meta.path, "--serve", root, studioDir], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "inherit" });
  const readinessTimeout = setTimeout(() => { child.kill(); }, 10000);
  const reader = child.stdout.getReader();
  let output = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw new Error(`Studio draft fixture exited before readiness: ${output}`);
      output += new TextDecoder().decode(next.value);
      const match = /studio-draft-url:(http:\/\/localhost:\d+)/.exec(output);
      if (match?.[1]) {
        const draft = await fetch(`${match[1]}/api/desk/studio/question/draft`);
        if (!draft.ok) throw new Error(`Studio draft fixture readiness failed: ${draft.status} ${await draft.text()}`);
        DraftSchema.parse(await draft.json());
        return { url: match[1], stop: async () => { child.kill(); await child.exited; } };
      }
    }
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally { clearTimeout(readinessTimeout); reader.releaseLock(); }
}

export async function openStudioDraftRig() {
  const git = Bun.which("git");
  if (!git) throw new Error("The Studio draft fixture requires Git on PATH.");
  const dir = await mkdtemp(join(tmpdir(), "studio-draft-"));
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "git"), `#!/bin/sh\nexec '${git.replaceAll("'", "'\\''")}' -c user.useConfigOnly=true -c user.name=Test -c user.email=test@example.org "$@"\n`, { mode: 0o755 });
  const studioDir = join(dir, "studio");
  await mkdir(join(studioDir, "threads"), { recursive: true });
  for (const type of ["question", "making", "topic"]) await writeFile(join(studioDir, `threads/${type}.md`), draftThreadFile(type));
  for (const state of ["parked", "closed"]) await writeFile(join(studioDir, `threads/${state}.md`), draftThreadFile("question", state));
  draftGit(studioDir, "init", "-q");
  draftGit(studioDir, "add", "-A");
  draftGit(studioDir, "commit", "-qm", "seed");
  let server = await serveDraftFixture(dir, studioDir);
  const clients: { stop: () => Promise<void> }[] = [];
  const rig = {
    dir,
    studioDir,
    baseUrl: () => server.url,
    gitRaw: (...args: string[]) => rawDraftGit(studioDir, ...args),
    git: (...args: string[]) => draftGit(studioDir, ...args),
    setStand: async (stand: string | null, thread = "question") => {
      const path = join(studioDir, `threads/${thread}.md`);
      const original = await readFile(path, "utf8");
      const start = original.indexOf("## Where I stand");
      const end = original.indexOf("## Assistant's notes");
      const prefix = original.slice(0, start < 0 ? end : start);
      const file = `${prefix}${stand === null ? "" : `## Where I stand\n\n${stand}\n\n`}${original.slice(end)}`;
      await writeFile(path, file);
      draftGit(studioDir, "add", `threads/${thread}.md`);
      draftGit(studioDir, "commit", "-qm", "Set disposable stand fixture");
      return file;
    },
    get: (thread = "question") => fetch(`${server.url}/api/desk/studio/${thread}/draft`),
    put: (body: DeskStudioDraftWrite, thread = "question", baseUrl = server.url) => fetch(`${baseUrl}/api/desk/studio/${thread}/draft`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify(body) }),
    read: async (thread = "question") => {
      const result = await rig.get(thread);
      if (result.status !== 200) throw new Error(`Draft GET answered ${result.status}: ${await result.text()}`);
      return DraftSchema.parse(await result.json());
    },
    anotherClient: async () => {
      const client = await serveDraftFixture(dir, studioDir);
      clients.push(client);
      return client.url;
    },
    reopen: async () => { await server.stop(); server = await serveDraftFixture(dir, studioDir); },
    close: async () => { await server.stop(); for (const client of clients) await client.stop(); await rm(dir, { recursive: true, force: true }); },
  };
  return rig;
}

if (import.meta.main && process.argv[2] === "--serve") {
  const root = process.argv[3];
  const studioDir = process.argv[4];
  if (!root || !studioDir) throw new Error("The draft fixture requires disposable root and Studio paths.");
  const db = initDatabase(join(root, `${randomUUID()}.db`));
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["owner@example.org"], localPrincipal: "owner@example.org" } }, db, { desk: {
    enabled: true, displayName: "", assistantName: "Assistant", topN: 5, rangerUrl: "",
    sources: [], areas: [{ id: "lab", label: "Lab", policy: "local", repos: [], goals: [], color: "" }], studio: { dir: studioDir, maxActive: 5 },
  } });
  process.stdout.write(`studio-draft-url:http://localhost:${ctx.port}\n`);
}
