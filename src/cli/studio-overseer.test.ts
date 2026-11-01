import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStudioAct } from "../surface/mc/desk/studio/writer";
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

test("a newly committed constructor thread survives old and same-HEAD checkpoints", async () => {
  const r = await rig();
  await runOverseer(r.config);
  await writeFile(join(r.dir, "threads/constructor.md"), thread());
  r.git("add", "."); r.git("commit", "-qm", "Constructor thread");
  expect(await runOverseer(r.config)).toEqual({ queued: ["constructor"], proposals: [] });
  expect(await runOverseer(r.config)).toEqual({ queued: [], proposals: [] });
  const state = JSON.parse(await readFile(join(r.dir, ".git/studio-overseer.json"), "utf8"));
  expect(Object.hasOwn(state.material, "constructor")).toBe(true);
  expect(typeof state.changedAt.constructor).toBe("number");
  expect(state.queued.constructor).toBe(new Date().toISOString().slice(0, 10));
});

test("ignored Markdown never becomes an automatic thread or recurring proposal", async () => {
  const r = await rig();
  await writeFile(join(r.dir, ".gitignore"), "threads/draft.md\ninbox/*.md\nlocal-cache/\n");
  r.git("add", "."); r.git("commit", "-qm", "Ignore private drafts");
  await mkdir(join(r.dir, "inbox"));
  await mkdir(join(r.dir, "local-cache"));
  await writeFile(join(r.dir, "local-cache/state.json"), "private cache");
  await writeFile(join(r.dir, "threads/draft.md"), thread(true));
  for (const id of ["one", "two", "three"]) await writeFile(join(r.dir, `inbox/${id}.md`), `---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);
  expect(r.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(await runOverseer(r.config)).toEqual({ queued: [], proposals: [] });
  expect(await Bun.file(r.calls).exists()).toBe(false);
  expect(r.git("rev-list", "--count", "HEAD")).toBe("2");
});

test("assume-unchanged thread and capture edits defer despite clean git status", async () => {
  for (const path of ["threads/alpha.md", "inbox/one.md"]) {
    const r = await rig();
    await mkdir(join(r.dir, "inbox"));
    await writeFile(join(r.dir, "inbox/one.md"), "---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nSaved capture\n");
    r.git("add", "."); r.git("commit", "-qm", "Capture baseline");
    r.git("update-index", "--assume-unchanged", path);
    const edited = (await readFile(join(r.dir, path), "utf8")) + "Uncommitted private material\n";
    await writeFile(join(r.dir, path), edited);
    expect(r.git("status", "--porcelain")).toBe("");
    await expect(runOverseer(r.config)).rejects.toThrow("committed");
    expect(await Bun.file(r.calls).exists()).toBe(false);
    expect(await readFile(join(r.dir, path), "utf8")).toBe(edited);
  }
});

test("committed symbolic links cannot supply automatic thread content", async () => {
  const r = await rig();
  await writeFile(join(r.dir, "private.md"), thread(true));
  await symlink("../private.md", join(r.dir, "threads/linked.md"));
  r.git("add", "."); r.git("commit", "-qm", "Symbolic thread fixture");
  await expect(runOverseer(r.config)).rejects.toThrow("regular file");
  expect(await Bun.file(r.calls).exists()).toBe(false);
});

test("ignored proposals cannot claim handled capture provenance", async () => {
  const r = await rig();
  await mkdir(join(r.dir, "inbox"));
  await mkdir(join(r.dir, "proposals"));
  const ignored = "theme-00000000000000000000";
  await writeFile(join(r.dir, ".gitignore"), `proposals/${ignored}.md\n`);
  for (const id of ["one", "two", "three"]) await writeFile(join(r.dir, `inbox/${id}.md`), `---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);
  r.git("add", "."); r.git("commit", "-qm", "Committed captures and ignore rule");
  await writeFile(join(r.dir, `proposals/${ignored}.md`), `---\ntype: question\nareas: [lab]\nproposed: 2026-10-31T12:00:00Z\ntarget:\n  place: new\n  area: lab\n  reason: Draft only\n---\n## Question\nDraft question\n## Why\nNot committed\n\n- Inbox capture: one\n- Inbox capture: two\n- Inbox capture: three\n`);
  const result = await runOverseer(r.config);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals).not.toContain(ignored);
  expect(r.git("show", "HEAD:.studio-overseer-themes.json")).not.toContain(ignored);
});

test("a HEAD change during policy lookup cannot enqueue a stale selection", async () => {
  const r = await rig(true);
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith("studio")) {
      r.git("commit", "--allow-empty", "-qm", "Concurrent commit");
      return Response.json({ directory: r.dir, studio: { maxActive: 5, areas: [{ id: "lab", label: "Lab", color: "blue", policy: "local" }] } });
    }
    return Response.json({ today: [], ahead: [] });
  } });
  cleanup.push(async () => { await server.stop(true); });
  await expect(runOverseer({ ...r.config, deskUrl: `http://127.0.0.1:${server.port}` })).rejects.toThrow("HEAD changed");
  expect(await Bun.file(r.calls).exists()).toBe(false);
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


test("a later enqueue failure preserves earlier successful daily checkpoints", async () => {
 const r = await rig(true);
 await writeFile(join(r.dir, "threads/beta.md"), thread(true));
 r.git("add", "."); r.git("commit", "-qm", "second tonight thread");
 const gate=join(r.dir,".git/fail-beta");
 await writeFile(gate,"fail");
 await writeFile(join(r.dir,".git/ranger.ts"), `import { appendFileSync, existsSync } from "node:fs"; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(r.calls)},JSON.stringify(args)+"\\n"); if(args.includes("thread=beta")&&existsSync(${JSON.stringify(gate)}))process.exit(1);`);
 await expect(runOverseer(r.config)).rejects.toThrow("command failed");
 await rm(gate);
 expect((await runOverseer(r.config)).queued).toEqual(["beta"]);
 const calls=(await readFile(r.calls,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
 expect(calls.filter(args=>args.includes("thread=alpha")).length).toBe(1);
});


test("the committed-file watcher notices a commit made after a dirty-file interval", async () => {
 const r=await rig();
 const config=join(r.dir,".git/overseer-config.json");
 await writeFile(config,JSON.stringify(r.config));
 const child=Bun.spawn([process.execPath,join(import.meta.dir,"studio-overseer.ts"),config,"--watch-studio"],{stdout:"pipe",stderr:"pipe"});
 const stdout=new Response(child.stdout).text();const stderr=new Response(child.stderr).text();
 const waitFor=async(path:string):Promise<void>=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await Bun.file(path).exists())return;await Bun.sleep(50);}throw new Error(`Watcher did not create ${path}`);};
 try{
  await waitFor(join(r.dir,".git/studio-overseer.json"));
  await writeFile(join(r.dir,"threads/alpha.md"),thread().replace("baseline","baseline\n- capture: delayed commit evidence"));
  await Bun.sleep(2000);
  expect(await Bun.file(r.calls).exists()).toBe(false);
  r.git("add",".");r.git("commit","-qm","Material committed after dirty interval");
  await waitFor(r.calls);
  expect(await readFile(r.calls,"utf8")).toContain("New Material committed");
 }catch(error){child.kill();await child.exited;throw new Error(`${String(error)}; stdout=${await stdout}; stderr=${await stderr}`, { cause: error });}
 finally{child.kill();await child.exited;await Promise.all([stdout,stderr]);}
}, 20000);


for (const disposition of ["accept", "dismiss"] as const) test(`handled captures survive ${disposition}, restart, edits and additions without repeated proposals`, async () => {
 const r=await rig();
 const add=async(ids:string[])=>{await mkdir(join(r.dir,"inbox"),{recursive:true});for(const id of ids)await writeFile(join(r.dir,`inbox/${id}.md`),`---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);r.git("add",".");r.git("commit","-qm","Capture fixtures");};
 await add(["one","two","three"]);
 const first=await runOverseer(r.config);const id=first.proposals[0];if(!id)throw new Error("Missing proposal");
 if(disposition==="accept"){
  const result=await runStudioAct({options:{dir:r.dir,maxActive:5},areas:[{id:"lab",label:"Lab",color:"blue",policy:"local"}],requestId:crypto.randomUUID(),act:{act:"open",from:"proposal",id,area:"lab"}});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);
  expect(result.studio.problems).toEqual([]);
  expect(result.studio.active.some(thread=>thread.log.some(entry=>entry.text.includes(id)))).toBe(true);
 }else{await rm(join(r.dir,`proposals/${id}.md`));r.git("add",".");r.git("commit","-qm","Dismiss proposal fixture");}
 await rm(join(r.dir,".git/studio-overseer.json"));
 expect((await runOverseer(r.config)).proposals).toEqual([]);
 await writeFile(join(r.dir,"inbox/one.md"),(await readFile(join(r.dir,"inbox/one.md"),"utf8"))+"Edited by the person.\n");r.git("add",".");r.git("commit","-qm","Manual capture edit");
 await add(["four"]);expect((await runOverseer(r.config)).proposals).toEqual([]);
 await add(["five"]);expect((await runOverseer(r.config)).proposals).toEqual([]);
 await add(["six"]);const fresh=await runOverseer(r.config);expect(fresh.proposals).toHaveLength(1);
 const text=await readFile(join(r.dir,`proposals/${fresh.proposals[0]}.md`),"utf8");
 expect(text).toContain("- Inbox capture: four");expect(text).not.toContain("- Inbox capture: one\n");
 expect((await readFile(join(r.dir,"inbox/one.md"),"utf8"))).toContain("Edited by the person.");
 expect(r.git("show",`HEAD:.studio-overseer-themes.json`)).toContain(id);
},20000);


test("malformed, unknown or removed theme provenance fails closed", async () => {
 for(const text of ["not JSON",JSON.stringify({version:2,themes:[]})]){
  const r=await rig();await writeFile(join(r.dir,".studio-overseer-themes.json"),text);r.git("add",".");r.git("commit","-qm","Invalid provenance fixture");
  await expect(runOverseer(r.config)).rejects.toThrow();expect(await Bun.file(r.calls).exists()).toBe(false);
 }
 const r=await rig();await writeFile(join(r.dir,".studio-overseer-themes.json"),JSON.stringify({version:1,themes:[]}));r.git("add",".");r.git("commit","-qm","Provenance fixture");
 await rm(join(r.dir,".studio-overseer-themes.json"));r.git("add",".");r.git("commit","-qm","Removed provenance fixture");
 await expect(runOverseer(r.config)).rejects.toThrow("provenance was removed");
});

test("a failed proposal commit restores existing provenance and preserves unrelated manual edits", async () => {
 const r=await rig();await mkdir(join(r.dir,"inbox"));
 const add=async(ids:string[])=>{for(const id of ids)await writeFile(join(r.dir,`inbox/${id}.md`),`---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);r.git("add",".");r.git("commit","-qm","Capture batch");};
 await add(["one","two","three"]);await runOverseer(r.config);
 const original=await readFile(join(r.dir,".studio-overseer-themes.json"),"utf8");
 await add(["four","five","six"]);
 const hook=join(r.dir,".git/hooks/pre-commit");
 await writeFile(hook,"#!/bin/sh\nprintf '\\nPerson edited this.\\n' >> inbox/one.md\nexit 1\n",{mode:0o755});
 await expect(runOverseer(r.config)).rejects.toThrow("original provenance and files restored");
 expect(await readFile(join(r.dir,".studio-overseer-themes.json"),"utf8")).toBe(original);
 expect(await readFile(join(r.dir,"inbox/one.md"),"utf8")).toContain("Person edited this.");
 expect(r.git("status","--porcelain")).toBe("M inbox/one.md");
});


test("existing proposal capture provenance is committed before its file can disappear", async () => {
 const r=await rig();await mkdir(join(r.dir,"proposals"));
 const id="theme-0123456789abcdef0123";
 await writeFile(join(r.dir,`proposals/${id}.md`),`---\ntype: question\nareas: [lab]\nproposed: 2026-10-31T12:00:00Z\ntarget:\n  place: new\n  area: lab\n  reason: Recurring captures\n---\n## Question\nWhat about orchard planting?\n## Why\nThree related captures.\n\n- Inbox capture: one\n- Inbox capture: two\n- Inbox capture: three\n`);
 r.git("add",".");r.git("commit","-qm","Existing proposal fixture");
 expect((await runOverseer(r.config)).proposals).toEqual([]);
 expect(r.git("show","HEAD:.studio-overseer-themes.json")).toContain(id);
 expect(r.git("status","--porcelain")).toBe("");
});


test("rollback preserves a provenance file replaced by a manual symlink", async () => {
 const r=await rig();await mkdir(join(r.dir,"inbox"));
 for(const id of ["one","two","three"])await writeFile(join(r.dir,`inbox/${id}.md`),`---\nat: 2026-10-31T12:00:00Z\nvia: fixture\n---\nOrchard planting ${id}\n`);
 r.git("add",".");r.git("commit","-qm","Captures");
 await writeFile(join(r.dir,".git/hooks/pre-commit"),"#!/bin/sh\ncp .studio-overseer-themes.json .git/manual-ledger.json\nrm .studio-overseer-themes.json\nln -s .git/manual-ledger.json .studio-overseer-themes.json\nexit 1\n",{mode:0o755});
 await expect(runOverseer(r.config)).rejects.toThrow("concurrent edit");
 expect(await readFile(join(r.dir,".git/manual-ledger.json"),"utf8")).toContain("one");
 expect(r.git("status","--porcelain")).not.toBe("");
});
