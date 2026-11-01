import { expect, test } from "bun:test";
import { parseThreadFile, parseProposalFile } from "./format";
import { buildStudioView } from "./view";
import { recurringThemes, selectThinking, studioBriefing } from "./overseer";
import { stringify } from "yaml";

const now = Date.parse("2026-11-01T01:00:00Z");
const areas = [{ id: "lab", label: "Lab", color: "blue", policy: "local" as const }];
const file = (slug: string, front: Record<string, unknown> = {}, material = "") => ({ path: `threads/${slug}.md`, text: `---\n${stringify({ type: "question", areas: ["lab"], state: "active", opened: "2026-10-01", ...front })}---\n## Question\nHow shall we plan the design meeting?\n## Where I stand\nTesting first.\n## Material\n${material}\n## Ivy's notes\n## Log\n` });
const view = (threads = [file("alpha")]) => buildStudioView({ threads, inbox: [], proposals: [] }, { dir: "/fixture", maxActive: 5 }, areas);
const select = (studio = view(), extra = {}) => selectThinking({ studio, now, changedAt: new Map(), newMaterial: new Set<string>(), events: [], ...extra });

test("clock selectors cover stale default/config, think tonight and committed Material", () => {
  expect(select(view(), { changedAt: new Map([["alpha", now - 6 * 86_400_000]]) })[0]?.trigger).toContain("6 days");
  expect(select(view(), { staleDays: 7, changedAt: new Map([["alpha", now - 6 * 86_400_000]]) })).toEqual([]);
  expect(select(view([file("alpha", { thinkTonight: true })]))[0]?.trigger).toBe("Asked to think tonight");
  expect(select(view(), { newMaterial: new Set(["alpha"]) })[0]?.trigger).toBe("New Material committed");
});

test("due decided outcome qualifies; future, shipped, dropped and parked do not", () => {
  expect(select(view([file("alpha", { state: "closed", outcome: "decided", reviewOn: "2026-11-01" })]))[0]?.trigger).toContain("Decision review due");
  for (const front of [{ state: "closed", outcome: "decided", reviewOn: "2026-11-02" }, { state: "closed", outcome: "shipped", reviewOn: "2026-10-01" }, { state: "parked", thinkTonight: true }]) expect(select(view([file("alpha", front)]))).toEqual([]);
});

test("only related events starting in next 24 hours select a thread", () => {
  const event = { key: "cal:one", at: now + 86_400_000, title: "Design meeting", area: "lab", kind: "meeting" as const };
  expect(select(view(), { events: [event] })[0]?.trigger).toContain("Design meeting");
  expect(select(view(), { events: [{ ...event, at: event.at + 1 }] })).toEqual([]);
  expect(select(view(), { events: [{ ...event, title: "Unrelated" }] })).toEqual([]);
});

test("today's real note suppresses automatic selection and contributes one briefing line", () => {
  const studio = view([file("alpha", { thinkTonight: true })]);
  const thread = studio.active[0];
  if (!thread) throw new Error("missing fixture");
  thread.notes.push({ at: "2026-11-01T00:30:00Z", trigger: "Asked to think tonight", model: "local / pi", kind: "note", status: "open", sample: false, text: "Try this." });
  expect(select(studio)).toEqual([]);
  expect(studioBriefing(studio.active, now)).toBe("Studio: Ivy thought about How shall we plan the design meeting.");
  expect(studioBriefing(studio.active, now + 86_400_000)).toBeNull();
});

test("three recurring captures yield a readable proposal with reason and target area", () => {
  const captures = ["first", "second", "third"].map(id => ({ id, path: `inbox/${id}.md`, at: new Date(now).toISOString(), via: "desk", text: `Explore orchard planting ${id}`, target: { place: "new" as const, area: "lab", reason: "Likely Lab" } }));
  expect(recurringThemes(captures.slice(0, 2), areas)).toEqual([]);
  const proposal = recurringThemes(captures, areas)[0];
  expect(proposal?.area).toBe("lab");
  expect(proposal?.reason).toContain("3 inbox captures");
  expect(recurringThemes([...captures].reverse(), areas)).toEqual(recurringThemes(captures, areas));
  const parsed = parseThreadFile(file("alpha").path, file("alpha").text);
  expect(parsed.ok).toBe(true);
  if (!proposal) throw new Error("missing proposal");
  expect(parseProposalFile(`proposals/${proposal.id}.md`, `---\n${stringify({ type: "question", areas: [proposal.area], proposed: new Date(now).toISOString(), target: { place: "new", area: proposal.area, reason: proposal.reason } })}---\n## Question\n${proposal.question}\n## Why\n${proposal.reason}`).ok).toBe(true);
});
