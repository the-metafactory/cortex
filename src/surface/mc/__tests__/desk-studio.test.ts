import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGetDeskStudio } from "../api/desk-studio";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions } from "../desk/compose";
import { parseCaptureFile, parseProposalFile, parseThreadFile } from "../desk/studio/format";
import { buildStudioView, effectivePolicy, type StudioArea, type StudioFile } from "../desk/studio/view";
import { McSchema } from "../../../common/types/config";

const AREAS: StudioArea[] = [
  { id: "work", label: "Work", color: "#2563eb", policy: "local" },
  { id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" },
  { id: "home", label: "Home", color: "#059669" },
];

const FULL = `---
type: question
areas: [lab]
state: active
opened: 2026-10-24
thinkTonight: true
---

## Question

How does the tool become useful to someone else?

## Where I stand

Only the built-in sources count.

## Ivy's notes

### 2026-10-31T03:12:00+01:00
trigger: Stale thread: unchanged for 6 days
model: cloud
sample: true

Three angles. Note: the first one matters most.

### 2026-10-31T03:14:00+01:00
trigger: Stale thread: unchanged for 6 days
model: cloud
kind: stand
because: Two of three personas have no mail adapter.

The threads are the product; the sources are the bonus.

### 2026-10-31T03:15:00+01:00
trigger: You asked: think now
model: spark/longctx-think
kind: idea
status: dismissed

Ship a demo stack.

## Material

- file: [BRIEF.md: open-source constraint](https://example.org/brief)
- voice: Voice note, 29 Oct
- An untyped line

## Log

- 2026-10-24: Opened
- Sparred: red team

## Outcome
`;

const thread = (slug: string, front: string, question = "Why?"): StudioFile => ({ path: `threads/${slug}.md`, text: `---\n${front}\n---\n\n## Question\n\n${question}\n` });

describe("parseThreadFile", () => {
  it("reads a full thread: front matter, every section, marked notes", () => {
    const parsed = parseThreadFile("threads/open-source.md", FULL);
    if (!parsed.ok) throw new Error(parsed.reason);
    const t = parsed.value;
    expect(t).toMatchObject({ slug: "open-source", type: "question", areas: ["lab"], state: "active", opened: "2026-10-24", thinkTonight: true });
    expect(t.question).toBe("How does the tool become useful to someone else?");
    expect(t.stand).toBe("Only the built-in sources count.");
    expect(t.notes.map((n) => [n.kind, n.status, n.model, n.sample])).toEqual([
      ["note", "open", "cloud", true],
      ["stand", "open", "cloud", false],
      ["idea", "dismissed", "spark/longctx-think", false],
    ]);
    expect(t.notes[0]?.text).toBe("Three angles. Note: the first one matters most.");
    expect(t.notes[1]?.because).toBe("Two of three personas have no mail adapter.");
    expect(t.material).toEqual([
      { kind: "file", label: "BRIEF.md: open-source constraint", href: "https://example.org/brief" },
      { kind: "voice", label: "Voice note, 29 Oct" },
      { kind: "link", label: "An untyped line" },
    ]);
    expect(t.log).toEqual([{ at: "2026-10-24", text: "Opened" }, { text: "Sparred: red team" }]);
    expect(t.outcomeText).toBe("");
  });

  it("reads a thread with only the Question section", () => {
    const parsed = parseThreadFile("threads/bare.md", thread("bare", "type: topic\nareas: [home]\nstate: parked\nopened: 2026-09-02").text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toMatchObject({ stand: "", notes: [], material: [], log: [], outcomeText: "", thinkTonight: false });
  });

  it("reads a closed decision with its expectation and review date", () => {
    const text = `---\ntype: question\nareas: [home, lab]\nstate: closed\nopened: 2026-10-01\nclosed: 2026-10-31\noutcome: decided\nexpect: I confirm on 4 of 5 days.\nreviewOn: 2026-12-15\n---\n## Question\nOwn product?\n## Outcome\nIt merges.\n`;
    const parsed = parseThreadFile("threads/balance.md", text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toMatchObject({ outcome: "decided", expect: "I confirm on 4 of 5 days.", reviewOn: "2026-12-15", closed: "2026-10-31", outcomeText: "It merges." });
  });

  it.each([
    ["no front matter", "## Question\nWhy?\n", "has no YAML front matter"],
    ["broken YAML", "---\nareas: [lab\n---\n## Question\nWhy?\n", "not YAML"],
    ["an unknown type", "---\ntype: essay\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n## Question\nWhy?\n", "front matter type"],
    ["no areas", "---\ntype: topic\nareas: []\nstate: active\nopened: 2026-10-01\n---\n## Question\nWhy?\n", "needs at least one area"],
    ["a bad date", "---\ntype: topic\nareas: [lab]\nstate: active\nopened: 31.10.2026\n---\n## Question\nWhy?\n", "front matter opened"],
    ["a closed thread without outcome", "---\ntype: topic\nareas: [lab]\nstate: closed\nopened: 2026-10-01\n---\n## Question\nWhy?\n", "needs an outcome"],
    ["no question", "---\ntype: topic\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n## Where I stand\nUnsure.\n", "Question"],
    ["a note headed by a non-time", "---\ntype: topic\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n## Question\nWhy?\n## Ivy's notes\n### Yesterday\ntrigger: x\nmodel: cloud\n\nText\n", "not an ISO time"],
    ["a note without a model", "---\ntype: topic\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n## Question\nWhy?\n## Ivy's notes\n### 2026-10-31T03:12:00Z\ntrigger: x\n\nText\n", "without a model"],
    ["a note of an unknown kind", "---\ntype: topic\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n## Question\nWhy?\n## Ivy's notes\n### 2026-10-31T03:12:00Z\ntrigger: x\nmodel: cloud\nkind: rant\n\nText\n", 'kind "rant"'],
    ["a section twice", "---\ntype: topic\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n## Question\nWhy?\n## Question\nAgain?\n", "twice"],
  ])("rejects a file with %s", (_name, text, reason) => {
    const parsed = parseThreadFile("threads/bad.md", text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  it("rejects a file name that is not a slug", () => {
    const parsed = parseThreadFile("threads/My Thread.md", FULL);
    expect(parsed.ok).toBe(false);
  });
});

describe("inbox and proposal files", () => {
  it("reads a capture with a thread target and a proposal with a new-place target", () => {
    const capture = parseCaptureFile("inbox/c1.md", "---\nat: 2026-10-30T18:20:00+01:00\nvia: voice\ntarget:\n  thread: open-source\n  reason: It is about newcomers.\n---\nWhat if the demo had fake adapters?\n");
    if (!capture.ok) throw new Error(capture.reason);
    expect(capture.value).toEqual({ id: "c1", path: "inbox/c1.md", at: "2026-10-30T18:20:00+01:00", via: "voice", text: "What if the demo had fake adapters?", target: { thread: "open-source", reason: "It is about newcomers." } });

    const proposal = parseProposalFile("proposals/p1.md", "---\ntype: question\nareas: [work, lab]\nproposed: 2026-10-31T04:00:00Z\ntarget:\n  place: new\n  area: work\n  reason: A free place.\n---\n## Question\nWhat runs locally?\n## Why\nIt came up three times.\n");
    if (!proposal.ok) throw new Error(proposal.reason);
    expect(proposal.value).toMatchObject({ id: "p1", question: "What runs locally?", why: "It came up three times.", target: { place: "new", area: "work" } });
  });

  it("rejects a target that names both a thread and a place, or no reason", () => {
    expect(parseCaptureFile("inbox/c.md", "---\nat: 2026-10-30T18:20:00Z\nvia: mail\ntarget: { thread: a, place: new, reason: x }\n---\nText\n").ok).toBe(false);
    expect(parseProposalFile("proposals/p.md", "---\ntype: topic\nareas: [lab]\nproposed: 2026-10-30T18:20:00Z\ntarget: { place: new }\n---\n## Question\nQ\n").ok).toBe(false);
  });
});

describe("effectivePolicy", () => {
  it("is cloud only when every area is cloud; an unset policy is cloud", () => {
    expect(effectivePolicy(["lab", "home"], AREAS)).toEqual({ policy: "cloud", unknown: [] });
  });

  it("takes the strictest area: any local area wins", () => {
    expect(effectivePolicy(["lab", "work"], AREAS).policy).toBe("local");
  });

  it("keeps an area the config does not list on the local model", () => {
    expect(effectivePolicy(["lab", "wrok"], AREAS)).toEqual({ policy: "local", unknown: ["wrok"] });
  });
});

describe("buildStudioView", () => {
  const opts = { dir: "/studio", maxActive: 2 };

  it("orders active threads oldest-opened first, places the first maxActive and flags the rest", () => {
    const view = buildStudioView(
      {
        threads: [
          thread("c", "type: topic\nareas: [lab]\nstate: active\nopened: 2026-10-20"),
          thread("a", "type: topic\nareas: [lab, work]\nstate: active\nopened: 2026-10-01"),
          thread("b", "type: making\nareas: [home]\nstate: active\nopened: 2026-10-10"),
          thread("p", "type: topic\nareas: [home]\nstate: parked\nopened: 2026-09-01"),
          thread("z", "type: question\nareas: [home]\nstate: closed\nopened: 2026-09-01\nclosed: 2026-09-30\noutcome: dropped"),
        ],
        inbox: [],
        proposals: [],
      },
      opts,
      AREAS,
    );
    expect(view.active.map((t) => [t.slug, t.place, t.overCap, t.policy])).toEqual([
      ["a", 1, false, "local"],
      ["b", 2, false, "cloud"],
      ["c", undefined, true, "cloud"],
    ]);
    expect(view.parked.map((t) => t.slug)).toEqual(["p"]);
    expect(view.closed.map((t) => t.slug)).toEqual(["z"]);
    expect(view.areas.map((a) => a.policy)).toEqual(["local", "cloud", "cloud"]);
    expect(view.problems).toEqual([]);
  });

  it("reports a malformed file and a dangling target without dropping the rest", () => {
    const view = buildStudioView(
      {
        threads: [thread("ok", "type: topic\nareas: [lab]\nstate: active\nopened: 2026-10-01"), { path: "threads/broken.md", text: "no front matter" }],
        inbox: [{ path: "inbox/c1.md", text: "---\nat: 2026-10-30T18:20:00Z\nvia: voice\ntarget: { thread: gone, reason: x }\n---\nHello\n" }],
        proposals: [{ path: "proposals/p1.md", text: "---\ntype: topic\nareas: [nowhere]\nproposed: 2026-10-30T18:20:00Z\ntarget: { place: new, reason: x }\n---\n## Question\nQ\n" }],
      },
      opts,
      AREAS,
    );
    expect(view.active.map((t) => t.slug)).toEqual(["ok"]);
    expect(view.inbox).toHaveLength(1);
    expect(view.proposals[0]?.policy).toBe("local");
    expect(view.problems.map((p) => p.path)).toEqual(["threads/broken.md", "inbox/c1.md", "proposals/p1.md"]);
    expect(view.problems[0]?.reason).toContain("front matter");
  });
});

describe("GET /api/desk/studio", () => {
  let dir = "";
  const desk = (studio?: { dir: string; maxActive: number }): DeskOptions => ({ enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: AREAS.map((a) => ({ ...a, repos: [], goals: [] })), sources: [], ...(studio ? { studio } : {}) });
  const get = async (options: DeskOptions) => (await (await handleGetDeskStudio({ options, ledger: new HandledLedger() })).json()) as { studio: { active: { slug: string; policy: string }[]; problems: { path: string; reason: string }[] } | null };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-studio-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("answers studio null without desk.studio", async () => {
    expect(await get(desk())).toEqual({ studio: null });
  });

  it("serves the threads of a configured directory", async () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "threads"));
    writeFileSync(join(dir, "threads", "one.md"), thread("one", "type: topic\nareas: [work]\nstate: active\nopened: 2026-10-01").text);
    writeFileSync(join(dir, "threads", "two.md"), thread("two", "type: topic\nareas: [lab]\nstate: active\nopened: 2026-10-02").text);
    writeFileSync(join(dir, "threads", "README.txt"), "ignored");
    const body = await get(desk({ dir, maxActive: 5 }));
    expect(body.studio?.active.map((t) => [t.slug, t.policy])).toEqual([["one", "local"], ["two", "cloud"]]);
    expect(body.studio?.problems).toEqual([]);
  });

  it("reports a missing directory and a non-git directory as problems", async () => {
    expect((await get(desk({ dir: join(dir, "absent"), maxActive: 5 }))).studio?.problems[0]?.reason).toContain("could not be opened");
    expect((await get(desk({ dir, maxActive: 5 }))).studio?.problems[0]?.reason).toContain("not a git working tree");
  });
});

describe("desk.studio and area policy config", () => {
  const parseDesk = (desk: unknown) => McSchema.parse({ desk }).desk;

  it("defaults maxActive to 5 and an area policy to cloud", () => {
    const parsed = parseDesk({ studio: { dir: "~/threads" }, areas: [{ id: "a", label: "A" }] });
    expect(parsed?.studio).toEqual({ dir: "~/threads", maxActive: 5 });
    expect(parsed?.areas[0]?.policy).toBe("cloud");
  });

  it("rejects an unknown policy", () => {
    expect(() => parseDesk({ areas: [{ id: "a", label: "A", policy: "remote" }] })).toThrow();
  });
});
