import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskBody, DeskView, StepUpPrompt } from "../components/desk-view";
import type { DeskItem, DeskView as DeskViewModel } from "../../desk/types";

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

const view: DeskViewModel = {
  generatedAt: NOW,
  displayName: "Ada",
  topN: 3,
  areas: [{ id: "work", label: "Work", color: "#2563eb" }],
  items: [1, 2, 3, 4, 5].map((n) => item(n)),
  today: [{ key: "ranger:run:example/app#7", at: NOW - 3_600_000, title: 'An agent is working on "Add export"', area: "work", kind: "agent" }],
  agents: { line: "1 agent working, 0 waiting on you", working: [{ title: "Add export", note: "review", since: NOW - 3_600_000 }], waiting: 0 },
  goals: [{ id: "G1", text: "Ship one release a week", state: "off-track" }],
  systems: [],
  ahead: [],
  vips: [],
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

describe("DeskView before the Desk has loaded", () => {
  it("still offers the way to Mission Control", () => {
    const html = renderToStaticMarkup(<DeskView onOpenMissionControl={() => {}} />);
    expect(html).toContain("Loading your Desk");
    expect(html).toContain("Open Mission Control");
  });
});

describe("DeskBody with calendar, mail and VIPs", () => {
  const mailItem = item(9, {
    key: "mail:m1", kind: "mail", urgency: "today", title: 'Ada Lovelace wrote: "Budget"', why: "Ada Lovelace is on your VIP list.",
    excerpt: "Could you look at the budget before Monday?",
    actions: [{ id: "open", label: "Open in Mail", role: "primary", wired: true, url: "message://%3Cm1%3E" }],
  });
  const html = renderToStaticMarkup(
    <DeskBody
      view={{
        ...view,
        items: [mailItem],
        today: [{ key: "cal:w:1", at: NOW + 44 * 60_000, end: NOW + 104 * 60_000, title: "DA results", area: "work", kind: "meeting", url: "https://teams.example/j/1", online: true }],
        ahead: [{ key: "cal:w:2", at: NOW + 3 * 86_400_000, title: "Partner visit", area: "work", kind: "meeting" }],
        vips: [{ address: "ada@example.org", label: "Ada" }],
      }}
      error={null}
      onOpenMissionControl={() => {}}
    />,
  );

  it("leads with the minutes before the next meeting and offers to join it", () => {
    expect(html).toContain("You have 44 minutes before your");
    expect(html).toMatch(/<a href="https:\/\/teams\.example\/j\/1"[^>]*>Join<\/a>/);
  });

  it("shows the mail's first paragraph and the next days", () => {
    expect(html).toContain("Could you look at the budget before Monday?");
    expect(html).toContain("Partner visit");
  });

  it("lists VIPs with a way to remove and add them", () => {
    expect(html).toContain(">Ada</span>");
    expect(html).toContain('aria-label="Remove ada@example.org"');
    expect(html).toContain('placeholder="Add an address or @domain"');
  });
});

describe("DeskBody when the next meeting is hours away", () => {
  const html = renderToStaticMarkup(
    <DeskBody view={{ ...view, today: [{ key: "cal:p:1", at: NOW + 5 * 3_600_000, title: "Concert", area: null, kind: "meeting" }] }} error={null} onOpenMissionControl={() => {}} />,
  );

  it("says what needs you once, not twice", () => {
    expect((html.match(/3 things need you, most important first\./g) ?? []).length).toBe(1);
    expect(html).toContain("Concert");
  });
});

describe("StepUpPrompt", () => {
  it("asks for the step-up code and holds the action until six digits are in", () => {
    const html = renderToStaticMarkup(
      <StepUpPrompt item={item(1)} action={{ id: "ranger.approve", label: "Approve", role: "primary", wired: true }} onConfirm={async () => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Step-up code");
    expect(html).toContain("Task 1 needs you.");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Approve<\/button>/);
  });
});
