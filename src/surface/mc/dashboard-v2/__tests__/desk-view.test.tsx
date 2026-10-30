import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskBody } from "../components/desk-view";
import type { DeskItem, DeskView } from "../../desk/types";

const NOW = Date.parse("2026-10-30T13:16:00.000Z");

const item = (n: number, over: Partial<DeskItem> = {}): DeskItem => ({
  key: `vigil:state:escalation:default:example/app#${n}`,
  kind: "escalation",
  area: "work",
  urgency: "waiting",
  title: `Task ${n} needs you.`,
  why: `It waited since this morning (${n}).`,
  score: 100 - n,
  actions: [
    { id: "detail", label: "Look first", role: "primary", wired: true },
    { id: "ranger.retry", label: "Let it retry", role: "secondary", wired: false },
  ],
  detail: { summary: "s", history: [], refs: [`example/app#${n}`], links: [] },
  ...over,
});

const view: DeskView = {
  generatedAt: NOW,
  displayName: "Ada",
  topN: 3,
  areas: [{ id: "work", label: "Work", color: "#2563eb" }],
  items: [1, 2, 3, 4, 5].map((n) => item(n)),
  today: [{ key: "ranger:run:example/app#7", at: NOW - 3_600_000, title: 'An agent is working on "Add export"', area: "work", kind: "agent" }],
  agents: { line: "1 agent working, 0 waiting on you", working: [{ title: "Add export", note: "review", since: NOW - 3_600_000 }], waiting: 0 },
  goals: [{ id: "G1", text: "Ship one release a week", state: "off-track" }],
  systems: [],
  sources: [{ id: "vigil", ok: true }],
};

describe("DeskBody", () => {
  const html = renderToStaticMarkup(<DeskBody view={view} error={null} onOpenMissionControl={() => {}} />);

  it("shows the top N items with their reasons and folds the rest into the margin", () => {
    expect((html.match(/class="desk-row desk-item"/g) ?? []).length).toBe(3);
    for (const n of [1, 2, 3]) expect(html).toContain(`Task ${n} needs you.`);
    expect(html).not.toContain("Task 4 needs you.");
    expect(html).toContain("2 more can wait");
    expect(html).toContain("It waited since this morning (1).");
  });

  it("keeps raw identifiers out of the visible text until the detail panel opens", () => {
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toContain("example/app#");
    expect(text).not.toContain("state:escalation");
  });

  it("greets by name and shows agents, goals, the area filter and the way to Mission Control", () => {
    expect(html).toContain("Good afternoon, Ada.");
    expect(html).toContain("1 agent working, 0 waiting on you");
    expect(html).toContain("Ship one release a week");
    expect(html).toContain(">Work</button>");
    expect(html).toContain("Open Mission Control");
  });

  it("disables actions that are not connected yet", () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Not connected yet"[^>]*>Let it retry<\/button>/);
  });
});
