import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskStudioAct } from "../api/desk-studio-act";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { waitsOnYou } from "../desk/studio/board";
import { appendLog, setFront, setNoteStatus } from "../desk/studio/edit";
import { parseThreadFile } from "../desk/studio/format";
import { buildThreadPage } from "../desk/studio/page";
import { buildStudioView, type StudioArea } from "../desk/studio/view";
import { runStudioAct, StudioWriteLock } from "../desk/studio/writer";
import type { StudioAct } from "../desk/studio/acts";

const AREAS: StudioArea[] = [
  { id: "work", label: "Work", color: "#2563eb", policy: "local" },
  { id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" },
];
const NOW = new Date("2026-10-31T14:05:00+01:00");

const threadFile = (state: string, opened: string, extra = ""): string => `---
type: question
areas: [lab]
state: ${state}
opened: ${opened}
---

## Question

What about ${opened}?

## Where I stand

Not settled.

## Ivy's notes

### 2026-10-31T03:12:00+01:00
trigger: Stale thread
model: cloud

Three angles.

### 2026-10-31T03:14:00+01:00
trigger: Stale thread
model: cloud
kind: stand
because: Two personas.

The Studio is the product.

### 2026-10-31T03:20:00+01:00
trigger: Stale thread
model: cloud
kind: idea

A demo stack.

### 2026-10-31T03:30:00+01:00
trigger: Shared source
model: cloud
kind: relation
relates: thread: beta

Both draw on the brief.
${extra}
## Log

- ${opened}: Opened
`;

const PROPOSAL = `---
type: question
areas: [lab, work]
proposed: 2026-10-31T04:30:00+01:00
target:
  place: new
  area: lab
  reason: It came up three times.
---

## Question

What runs locally?

## Why

Three mails.
`;

const CAPTURE = `---
at: 2026-10-31T08:02:00+01:00
via: mail
---
A guest lecture in March?
`;

let dir: string;
let ids = 0;
const rid = (): string => `request-${++ids}-xyz`;

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

function seed(active = 2): void {
  mkdirSync(join(dir, "threads"), { recursive: true });
  mkdirSync(join(dir, "proposals"));
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "threads/alpha.md"), threadFile("active", "2026-10-01"));
  writeFileSync(join(dir, "threads/beta.md"), threadFile(active >= 2 ? "active" : "parked", "2026-10-02"));
  writeFileSync(join(dir, "threads/gamma.md"), threadFile("parked", "2026-10-03"));
  writeFileSync(join(dir, "proposals/runs-locally.md"), PROPOSAL);
  writeFileSync(join(dir, "inbox/lecture.md"), CAPTURE);
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.org");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
}

const run = (act: StudioAct, requestId = rid(), maxActive = 5) =>
  runStudioAct({ options: { dir, maxActive }, areas: AREAS, requestId, act, now: NOW, lock: new StudioWriteLock() });

const read = (path: string): string => readFileSync(join(dir, path), "utf8");
const parsed = (slug: string) => {
  const p = parseThreadFile(`threads/${slug}.md`, read(`threads/${slug}.md`));
  if (!p.ok) throw new Error(p.reason);
  return p.value;
};
const commits = (): string[] => git("log", "--format=%s").trim().split("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-writer-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Studio writer acts", () => {
  it("records a response, clears Ivy waits on you and commits once", async () => {
    seed();
    expect(waitsOnYou(parsed("alpha"))).toBe(true);
    const r = await run({ act: "respond", thread: "alpha", text: "Lead with the Studio.\n## not a heading" });
    expect(r.ok).toBe(true);
    const t = parsed("alpha");
    expect(t.responses).toHaveLength(1);
    expect(Date.parse(t.responses[0]?.at ?? "")).toBe(NOW.getTime());
    expect(t.responses[0]).toMatchObject({ re: "2026-10-31T03:30:00+01:00", text: "Lead with the Studio.\n\\## not a heading" });
    expect(waitsOnYou(t)).toBe(false);
    expect(t.log.at(-1)).toEqual({ at: "2026-10-31", text: "Answered Ivy" });
    expect(commits()[0]).toBe("Studio: Answer Ivy on alpha");
    expect(git("log", "-1", "--format=%b")).toContain(`Desk-Request: request-${ids}-xyz`);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("keeps a proposed stand as the stand and dismisses an idea", async () => {
    seed();
    expect((await run({ act: "keep", thread: "alpha", note: "2026-10-31T03:14:00+01:00" })).ok).toBe(true);
    expect((await run({ act: "dismiss", thread: "alpha", note: "2026-10-31T03:20:00+01:00" })).ok).toBe(true);
    const t = parsed("alpha");
    expect(t.stand).toBe("The Studio is the product.");
    expect(t.notes.map((n) => n.status)).toEqual(["open", "kept", "dismissed", "open"]);
    expect(t.log.map((l) => l.text)).toEqual(["Opened", "Kept Ivy's stand", "Dismissed Ivy's idea"]);
    expect(commits().slice(0, 2)).toEqual(["Studio: Dismiss Ivy's idea on alpha", "Studio: Keep Ivy's stand on alpha"]);
  });

  it("keeps a proposed relation and shows it in Relates to", async () => {
    seed();
    const r = await run({ act: "keep", thread: "alpha", note: "2026-10-31T03:30:00+01:00" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const page = buildThreadPage(r.studio, "alpha");
    expect(page?.proposedRelations).toEqual([]);
    expect(page?.relations.threads.map((x) => x.open)).toContain("beta");
    expect(parsed("alpha").log.at(-1)?.text).toBe("Kept Ivy's relation to thread: beta");
  });

  it("lists a kept thread relation once when the threads also share a source", async () => {
    seed();
    const shared = "\n## Material\n\n- file: Shared brief\n";
    writeFileSync(join(dir, "threads/alpha.md"), threadFile("active", "2026-10-01", shared));
    writeFileSync(join(dir, "threads/beta.md"), threadFile("active", "2026-10-02", shared));
    git("commit", "-q", "-am", "share");
    const r = await run({ act: "keep", thread: "alpha", note: "2026-10-31T03:30:00+01:00" });
    if (!r.ok) throw new Error(r.error);
    const threads = buildThreadPage(r.studio, "alpha")?.relations.threads ?? [];
    expect(threads.map((x) => x.open)).toEqual(["beta"]);
    expect(threads[0]?.why).toBe("Shares a source: Shared brief. Ivy proposed it and you kept it.");
  });

  it("refuses to keep a plain note or a note twice", async () => {
    seed();
    const plain = await run({ act: "keep", thread: "alpha", note: "2026-10-31T03:12:00+01:00" });
    expect(plain).toMatchObject({ ok: false, status: 409 });
    await run({ act: "dismiss", thread: "alpha", note: "2026-10-31T03:20:00+01:00" });
    expect(await run({ act: "keep", thread: "alpha", note: "2026-10-31T03:20:00+01:00" })).toMatchObject({ ok: false, error: "This idea is already dismissed." });
  });

  it("parks, brings back and toggles think tonight", async () => {
    seed();
    expect((await run({ act: "park", thread: "alpha" })).ok).toBe(true);
    expect(parsed("alpha").state).toBe("parked");
    expect((await run({ act: "unpark", thread: "gamma" })).ok).toBe(true);
    expect(parsed("gamma").state).toBe("active");
    expect((await run({ act: "think", thread: "gamma", on: true })).ok).toBe(true);
    expect(parsed("gamma").thinkTonight).toBe(true);
    expect((await run({ act: "think", thread: "gamma", on: false })).ok).toBe(true);
    expect(parsed("gamma").thinkTonight).toBe(false);
    expect(parsed("gamma").log.map((l) => l.text)).toEqual(["Opened", "Brought back", "Asked Ivy to think tonight", "Took it off Ivy's list for tonight"]);
    expect(commits()).toHaveLength(5);
  });

  it("needs a park choice to bring a thread back at the cap", async () => {
    seed();
    const refused = await run({ act: "unpark", thread: "gamma" }, rid(), 2);
    expect(refused).toMatchObject({ ok: false, status: 409, needsPark: true });
    expect(commits()).toEqual(["seed"]);
    const ok = await run({ act: "unpark", thread: "gamma", park: "beta" }, rid(), 2);
    expect(ok.ok).toBe(true);
    expect(parsed("gamma").state).toBe("active");
    expect(parsed("beta").state).toBe("parked");
    expect(parsed("beta").log.at(-1)?.text).toBe("Parked to make room for “What about 2026-10-03”");
    expect(commits()[0]).toBe("Studio: Bring back gamma, park beta");
  });

  it("closes as decided only with what you expect and a review date", async () => {
    seed();
    expect(await run({ act: "close", thread: "alpha", outcome: "decided", text: "Ship it." })).toMatchObject({ ok: false, status: 400 });
    expect(await run({ act: "close", thread: "alpha", outcome: "decided", text: "Ship it.", expect: "Two users." })).toMatchObject({ ok: false, status: 400 });
    const r = await run({ act: "close", thread: "alpha", outcome: "decided", text: "Ship it.", expect: "Two users: by spring.", reviewOn: "2026-12-15" });
    expect(r.ok).toBe(true);
    const t = parsed("alpha");
    expect(t).toMatchObject({ state: "closed", closed: "2026-10-31", outcome: "decided", expect: "Two users: by spring.", reviewOn: "2026-12-15", outcomeText: "Ship it." });
    expect(commits()[0]).toBe("Studio: Close alpha as decided");
    expect((await run({ act: "close", thread: "beta", outcome: "dropped", text: "Not mine." })).ok).toBe(true);
    expect(parsed("beta")).toMatchObject({ outcome: "dropped", outcomeText: "Not mine." });
    expect(parsed("beta").expect).toBeUndefined();
  });

  it("opens a thread from a proposal in a chosen area and removes the proposal", async () => {
    seed();
    const r = await run({ act: "open", from: "proposal", id: "runs-locally", area: "work", answers: { "Is this mine to do?": "yes", "What will I stop doing for it?": "The Friday review", "Not a filter question": "no" } });
    expect(r.ok).toBe(true);
    const t = parsed("what-runs-locally");
    expect(t).toMatchObject({ state: "active", areas: ["work", "lab"], question: "What runs locally?", opened: "2026-10-31" });
    expect(t.log[0]?.text).toBe("Opened from Ivy's proposal. Yes-filter: 1 yes");
    expect(read("threads/what-runs-locally.md")).toContain("## Yes-filter\n\n- Is this mine to do? yes\n- What will I stop doing for it? The Friday review\n");
    expect(read("threads/what-runs-locally.md")).not.toContain("Not a filter question");
    expect(existsSync(join(dir, "proposals/runs-locally.md"))).toBe(false);
    expect(commits()[0]).toBe("Studio: Open what-runs-locally from proposal runs-locally");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("opens a capture at the cap only with a park choice", async () => {
    seed();
    const refused = await run({ act: "open", from: "capture", id: "lecture", area: "lab" }, rid(), 2);
    expect(refused).toMatchObject({ ok: false, needsPark: true });
    expect(existsSync(join(dir, "inbox/lecture.md"))).toBe(true);
    const r = await run({ act: "open", from: "capture", id: "lecture", area: "lab", park: "alpha" }, rid(), 2);
    expect(r.ok).toBe(true);
    const t = parsed("a-guest-lecture-in-march");
    expect(t.areas).toEqual(["lab"]);
    expect(t.material[0]).toEqual({ kind: "mail", label: "Capture, 2026-10-31: “A guest lecture in March?”" });
    expect(parsed("alpha").state).toBe("parked");
    expect(existsSync(join(dir, "inbox/lecture.md"))).toBe(false);
  });

  it("refuses an area the config does not list", async () => {
    seed();
    expect(await run({ act: "open", from: "capture", id: "lecture", area: "nowhere" })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("Studio writer safety", () => {
  it("refuses another process holding the shared repository lock", async () => {
    seed();
    mkdirSync(join(dir, ".git", "studio-write.lock"));
    writeFileSync(join(dir, ".git", "studio-write.lock", "owner.json"), JSON.stringify({ pid: 4242, at: NOW.toISOString() }));
    const before = readFileSync(join(dir, "threads/alpha.md"), "utf8");
    const result = await run({ act: "park", thread: "alpha" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(join(dir, "threads/alpha.md"), "utf8")).toBe(before);
    expect(existsSync(join(dir, ".git", "studio-write.lock", "owner.json"))).toBe(true);
  });

  it("reads Ranger note mode without putting it in the note body", () => {
    const text = threadFile("active", "2026-10-01").replace("model: cloud", "model: local / pi\nmode: red-team");
    const parsed = parseThreadFile("threads/alpha.md", text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.notes[0]).toMatchObject({ model: "local / pi", mode: "red-team", text: "Three angles." });
  });

  it("refuses a dirty tree and writes nothing", async () => {
    seed();
    writeFileSync(join(dir, "scratch.txt"), "half a thought");
    const before = read("threads/alpha.md");
    const r = await run({ act: "park", thread: "alpha" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.error).toContain("scratch.txt");
    expect(read("threads/alpha.md")).toBe(before);
    expect(commits()).toEqual(["seed"]);
  });

  it("refuses a directory that is not a git working tree", async () => {
    mkdirSync(join(dir, "threads"));
    writeFileSync(join(dir, "threads/alpha.md"), threadFile("active", "2026-10-01"));
    const r = await run({ act: "park", thread: "alpha" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.error).toContain("not a git working tree");
    expect(read("threads/alpha.md")).toContain("state: active");
  });

  it("replays a request id without a second commit", async () => {
    seed();
    const first = await run({ act: "respond", thread: "alpha", text: "Yes." }, "same-request-1");
    const again = await run({ act: "respond", thread: "alpha", text: "Yes." }, "same-request-1");
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.replayed).toBe(true);
    expect(again.commit).toBe(first.commit);
    expect(parsed("alpha").responses).toHaveLength(1);
    expect(commits()).toHaveLength(2);
  });

  it("refuses a second act while one is being written", async () => {
    seed();
    const lock = new StudioWriteLock();
    lock.claim(dir);
    const r = await runStudioAct({ options: { dir, maxActive: 5 }, areas: AREAS, requestId: rid(), act: { act: "park", thread: "alpha" }, now: NOW, lock });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("puts the files back when the commit fails", async () => {
    seed();
    const before = read("threads/alpha.md");
    const failing = async (args: string[], cwd: string) => {
      if (args[0] === "commit") return { code: 1, stdout: "", stderr: "hook refused" };
      const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    const r = await runStudioAct({ options: { dir, maxActive: 5 }, areas: AREAS, requestId: rid(), act: { act: "open", from: "capture", id: "lecture", area: "lab" }, now: NOW, git: failing, lock: new StudioWriteLock() });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(read("threads/alpha.md")).toBe(before);
    expect(existsSync(join(dir, "inbox/lecture.md"))).toBe(true);
    expect(existsSync(join(dir, "threads/a-guest-lecture-in-march.md"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe("Studio text edits", () => {
  it("replaces a block value in front matter and inserts a missing key", () => {
    const text = "---\ntype: question\nexpect: |\n  two lines\n  here\n---\n\n## Question\n\nQ\n";
    expect(setFront(text, "expect", "one: line")).toBe("---\ntype: question\nexpect: \"one: line\"\n---\n\n## Question\n\nQ\n");
    expect(setFront(text, "closed", "2026-10-31")).toContain("closed: 2026-10-31\n---");
  });

  it("adds a status line to a note without one and a Log section when missing", () => {
    const text = "---\na: 1\n---\n\n## Ivy's notes\n\n### 2026-10-31T03:12:00+01:00\ntrigger: t\nmodel: m\n\nText.\n";
    const kept = setNoteStatus(text, "2026-10-31T03:12:00+01:00", "kept");
    expect(kept).toContain("model: m\nstatus: kept\n\nText.");
    expect(setNoteStatus(text, "2026-10-31T09:00:00+01:00", "kept")).toBeNull();
    expect(appendLog(text, "2026-10-31", "Parked")).toEndWith("Text.\n\n## Log\n\n- 2026-10-31: Parked\n");
  });
});

describe("POST /api/desk/studio/act", () => {
  const runtime = (studio: boolean): DeskRuntime =>
    ({
      options: { enabled: true, areas: AREAS, ...(studio ? { studio: { dir, maxActive: 5 } } : {}) },
      ledger: new HandledLedger(),
    }) as unknown as DeskRuntime;
  const post = (body: unknown) => new Request("http://127.0.0.1/api/desk/studio/act", { method: "POST", body: JSON.stringify(body) });

  it("needs a request id and a valid act", async () => {
    seed();
    expect((await handleDeskStudioAct(post({ act: "park", thread: "alpha" }), runtime(true))).status).toBe(400);
    expect((await handleDeskStudioAct(post({ act: "fly", thread: "alpha", requestId: rid() }), runtime(true))).status).toBe(400);
    expect((await handleDeskStudioAct(post({ act: "park", thread: "alpha", requestId: rid() }), runtime(false))).status).toBe(409);
    expect((await handleDeskStudioAct(new Request("http://127.0.0.1/x"), runtime(true))).status).toBe(405);
  });

  it("answers with the commit and the fresh Studio", async () => {
    seed();
    const res = await handleDeskStudioAct(post({ act: "park", thread: "alpha", requestId: rid() }), runtime(true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; commit: string; studio: ReturnType<typeof buildStudioView> };
    expect(body.ok).toBe(true);
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.studio.parked.map((t) => t.slug)).toContain("alpha");
  });
});
