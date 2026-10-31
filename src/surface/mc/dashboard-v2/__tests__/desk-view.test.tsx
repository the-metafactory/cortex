import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionButton, DeskBody, DeskView, RestGroups } from "../components/desk-view";
import type { DeskItem, DeskView as DeskViewModel } from "../../desk/types";
import { ProposalCard } from "../components/desk-proposal";
import { askDesk, createFromProposal } from "../lib/desk-ask";
import type { DeskProposal } from "../../desk/ask";
import { openGroup, selectItems } from "../../desk/present";

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
  notes: [],
  ask: { kinds: ["reminder", "note"], maps: [] },
  sources: [{ id: "vigil", ok: true }],
  chime: false,
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

describe("the folded rest", () => {
  const decisions = [6, 7, 8].map((n) => item(n, { key: `ranger:example/app#${n}`, kind: "decision", title: `Decision ${n} waits.`, score: 10 - n }));
  const withRest: DeskViewModel = { ...view, items: [...view.items, ...decisions] };

  it("offers each folded group as a button that opens it in the main list", () => {
    const { groups } = selectItems(withRest, "all", new Set());
    const html = renderToStaticMarkup(<RestGroups groups={groups} active="decision" onOpen={() => {}} />);
    expect(html).toContain('<button type="button" class="desk-group" aria-pressed="true"><span class="n">3</span><div>Decisions agents are waiting for');
    expect(html).toContain('<button type="button" class="desk-group" aria-pressed="false"><span class="n">2</span>');
  });

  it("opens a group with every folded item of its kind, and only those", () => {
    const group = openGroup(selectItems(withRest, "all", new Set()), "decision");
    expect(group.label).toBe("Decisions agents are waiting for");
    expect(group.items.map((i) => i.title)).toEqual(["Decision 6 waits.", "Decision 7 waits.", "Decision 8 waits."]);
    const after = openGroup(selectItems(withRest, "all", new Set(["ranger:example/app#6"])), "decision");
    expect(after.items).toHaveLength(2);
  });
});

describe("ActionButton while an action is in flight", () => {
  const approve = { id: "ranger.approve", label: "Approve", role: "primary" as const, wired: true };
  const later = { id: "snooze", label: "Not now", role: "secondary" as const, wired: true };

  it("disables the clicked button and says it is sending", () => {
    const html = renderToStaticMarkup(<ActionButton action={approve} onRun={() => {}} sending="ranger.approve" />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(">Sending…</button>");
  });

  it("disables the item's other buttons too, and leaves an idle item alone", () => {
    expect(renderToStaticMarkup(<ActionButton action={later} onRun={() => {}} sending="ranger.approve" />)).toContain('disabled=""');
    const idle = renderToStaticMarkup(<ActionButton action={approve} onRun={() => {}} sending={null} />);
    expect(idle).not.toContain("disabled");
    expect(idle).toContain(">Approve</button>");
  });
});

describe("the command bar", () => {
  const card = (p: Partial<DeskProposal>) => renderToStaticMarkup(
    <ProposalCard proposal={{ kind: "reminder", label: "Reminder", fields: { text: "Call Ada" }, via: "rules", ...p }} said="remind me to call Ada" maps={[]} now={NOW} busy={false}
      onConfirm={() => {}} onCancel={() => {}} onGoto={() => {}} onFieldsChange={() => {}} />,
  );

  it("shows a pre-filled card that says nothing happens until confirmed", () => {
    const html = card({ fields: { text: "Call Ada", due: new Date(NOW + 3_600_000).toISOString() }, at: NOW + 3_600_000 });
    expect(html).toContain("Nothing happens until you confirm.");
    expect(html).toContain("Call Ada");
    expect(html).toContain("Lands on the timeline");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Confirm/);
  });

  it("keeps Confirm off until the time is set, and opens the fields to set it", () => {
    const html = card({ problem: "When should I remind you?" });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm/);
    expect(html).toContain("When should I remind you?");
    expect(html).toContain('type="datetime-local"');
  });

  it("says a kind this stack cannot write will not be created", () => {
    const html = card({ kind: "goal", label: "Goal draft", fields: { wording: "Run" }, problem: "Goal drafts are not set up on this stack.", unwritable: true });
    expect(html).toContain("Goal drafts are not set up on this stack. Nothing will be created.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm/);
    expect(html).not.toContain(">Edit<");
  });

  it("shows notes under Keep in mind", () => {
    const html = renderToStaticMarkup(<DeskBody view={{ ...view, notes: [{ id: 1, text: "Boiler code 4711", createdAt: NOW }] }} error={null} onOpenMissionControl={() => {}} />);
    expect(html).toContain("Keep in mind");
    expect(html).toContain("Boiler code 4711");
  });

  it("turns server answers into one line and never throws", async () => {
    const answering = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    expect(await askDesk("x", answering(422, { ok: false, error: "I could not tell." }))).toEqual({ ok: false, text: "I could not tell." });
    expect(await createFromProposal("req-1", "note", { text: "x" }, answering(200, { ok: true, message: "Noted." }))).toEqual({ ok: true, text: "Noted." });
    expect(await createFromProposal("req-1", "note", { text: "x" }, async () => { throw new Error("offline"); })).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });
});
