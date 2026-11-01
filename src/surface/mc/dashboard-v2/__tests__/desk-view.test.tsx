import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionButton, DeskBody, DeskView, DoneForYou, EvidenceLink, ItemMenu, RankingSection, RestGroups, dismissesMenu, withConfirm } from "../components/desk-view";
import { submitMailAction } from "../lib/desk-action";
import type { DeskItem, DeskView as DeskViewModel } from "../../desk/types";
import { ProposalCard } from "../components/desk-proposal";
import { askDesk, createFromProposal } from "../lib/desk-ask";
import type { DeskProposal } from "../../desk/ask";
import { openGroup, selectItems } from "../../desk/present";

const NOW = Date.parse("2026-10-30T13:16:00.000Z");

const item = (n: number, over: Partial<DeskItem> = {}): DeskItem => ({
  key: `vigil:state:escalation:default:example/app#${n}`,
  kind: "escalation",
  source: "vigil",
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
  notifications: false,
  voice: { enabled: true, input: "browser", output: "browser" },
  autonomy: { types: [], done: [] },
  corrections: [],
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

describe("the Desk top bar", () => {
  const areas = [
    { id: "switch", label: "SWITCH", color: "#dc2626" },
    { id: "mf", label: "MetaFactory", color: "#2563eb" },
    { id: "personal", label: "Personal", color: "#16a34a" },
  ];
  const html = renderToStaticMarkup(<DeskBody view={{ ...view, areas }} error={null} onOpenMissionControl={() => {}} />);
  const top = html.slice(html.indexOf('class="desk-top-in"'), html.indexOf('class="desk-grid"'));
  const css = readFileSync(join(import.meta.dir, "../components/desk-view.css"), "utf8");

  it("puts the ask bar on the left and the area filter with Settings in their own cell on the right", () => {
    const left = top.indexOf('class="desk-left"');
    const right = top.indexOf('class="desk-topr"');
    expect(left).toBeGreaterThan(-1);
    expect(right).toBeGreaterThan(left);
    expect(top.indexOf('aria-label="Ask Ivy"')).toBeLessThan(right);
    const tabs = [...top.slice(right).matchAll(/role="tab" aria-selected="(true|false)">(?:<span[^>]*><\/span>)?([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(tabs).toEqual([["All", "true"], ["SWITCH", "false"], ["MetaFactory", "false"], ["Personal", "false"]]);
    expect(top.slice(right)).toContain(">Settings</button>");
  });

  it("sizes the right cell to its content so the ask bar shrinks first, never over the area filter", () => {
    const rule = (sel: string) => /\{([^}]*)\}/.exec(css.slice(css.indexOf(`\n${sel}{`)))?.[1] ?? "";
    expect(rule(".desk-top-in")).toContain("grid-template-columns:minmax(0,1fr) minmax(330px,max-content)");
    expect(rule(".desk-topr>*")).toContain("flex:none");
    expect(rule(".desk-askwrap")).toContain("min-width:0");
  });

  it("shows no area filter when the stack defines no areas", () => {
    const bare = renderToStaticMarkup(<DeskBody view={{ ...view, areas: [] }} error={null} onOpenMissionControl={() => {}} />);
    expect(bare).not.toContain('aria-label="Area"');
    expect(bare).toContain('aria-label="View"');
    expect(bare).toContain(">Settings</button>");
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

  it("keeps the VIP list off the margin and offers Settings in the top bar", () => {
    expect(html).not.toContain('aria-label="Remove ada@example.org"');
    expect(html).not.toContain('aria-label="Add a VIP"');
    expect(html).not.toMatch(/<h3 class="desk-mh">VIPs<\/h3>/);
    expect(html).toMatch(/<div class="desk-topr">.*<button type="button" class="desk-btn ghost">Settings<\/button><\/div>/);
  });

  it("still offers \"Always show mail from …\" on a mail item", () => {
    const other = item(10, {
      key: "mail:m2", kind: "mail", urgency: "today", title: 'Grace Hopper wrote: "Compilers"', why: "It arrived an hour ago.",
      actions: [
        { id: "open", label: "Open in Mail", role: "primary", wired: true, url: "message://%3Cm2%3E" },
        { id: "vip.add", label: "Always show mail from Grace", role: "secondary", wired: true, target: "grace@example.org" },
      ],
    });
    const page = renderToStaticMarkup(<DeskBody view={{ ...view, items: [other] }} error={null} onOpenMissionControl={() => {}} />);
    expect(page).toContain("Always show mail from Grace");
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

describe("Done for you", () => {
  const retry = { action: "ranger.retry", label: "Retry agent tasks that failed", note: "A retry cannot be taken back.", on: true };
  const types = [retry];

  it("lists what the Desk did on its own, a refused attempt with its reason, and the way to stop", () => {
    const html = renderToStaticMarkup(<DoneForYou autonomy={{ types, done: [
      { key: "a", title: "Fix the login timeout", message: "", at: NOW, ok: true },
      { key: "b", title: "Add export", message: "Ranger refused: map is paused", at: NOW, ok: false },
    ] }} onPromote={() => {}} />);
    expect(html).toContain("Retried &quot;Fix the login timeout&quot;");
    expect(html).toContain("Could not retry &quot;Add export&quot;");
    expect(html).toContain("Ranger refused: map is paused");
    expect(html).toContain("Stop doing this on your own");
    expect(html).not.toContain("Undo");
  });

  it("renders the promote and revoke controls as bordered secondary buttons", () => {
    const button = (on: boolean) => /<button[^>]*>([^<]*)<\/button>/.exec(renderToStaticMarkup(<DoneForYou autonomy={{ types: [{ ...retry, on }], done: [] }} onPromote={() => {}} />));
    for (const [on, label] of [[false, "Handle this yourself"], [true, "Stop doing this on your own"]] as const) {
      const m = button(on);
      expect(m?.[1]).toBe(label);
      expect(m?.[0]).toContain('class="desk-btn desk-promote"');
      expect(m?.[0]).not.toContain("ghost");
    }
  });

  it("offers to promote a type the Desk still asks about, and hides when nothing is promotable", () => {
    expect(renderToStaticMarkup(<DoneForYou autonomy={{ types: [{ ...retry, on: false }], done: [] }} onPromote={() => {}} />)).toContain("Handle this yourself");
    expect(renderToStaticMarkup(<DoneForYou autonomy={{ types: [], done: [] }} onPromote={() => {}} />)).toBe("");
  });
});

describe("ranking corrections on the Desk", () => {
  it("offers less like this and always show this on every item, and the way back on a corrected one", () => {
    const plain = renderToStaticMarkup(<ItemMenu onCorrect={() => {}} open />);
    expect(plain).toContain("Less like this");
    expect(plain).toContain("Always show this");
    expect(plain).not.toContain("Rank by the base rules again");
    const less = renderToStaticMarkup(<ItemMenu current="less" onCorrect={() => {}} open />);
    expect(less).not.toContain(">Less like this<");
    expect(less).toContain("Rank by the base rules again");
    const html = renderToStaticMarkup(<DeskBody view={{ ...view, items: [item(1, { correction: "always" }), item(2)] }} error={null} onOpenMissionControl={() => {}} />);
    expect((html.match(/aria-label="Ranking: less like this, always show"/g) ?? []).length).toBe(2);
    expect(html).toContain("Always shown");
  });

  it("shows the ranking control as a bordered button that says what it does", () => {
    const html = renderToStaticMarkup(<ItemMenu onCorrect={() => {}} />);
    const btn = /<button[^>]*>/.exec(html)?.[0] ?? "";
    expect(btn).toContain('class="desk-btn desk-rank-btn"');
    expect(btn).not.toContain("ghost");
    expect(btn).toContain('title="Ranking: less like this, always show"');
    expect(btn).toContain('aria-label="Ranking: less like this, always show"');
    expect(btn).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it("closes the menu on Escape and on a click outside it, not on a click inside or another key", () => {
    const inside = { id: "inside" };
    const outside = { id: "outside" };
    const root = { contains: (t: { id: string } | null) => t === inside };
    expect(dismissesMenu({ type: "keydown", key: "Escape", target: inside }, root)).toBe(true);
    expect(dismissesMenu({ type: "keydown", key: "Enter", target: inside }, root)).toBe(false);
    expect(dismissesMenu({ type: "mousedown", target: outside }, root)).toBe(true);
    expect(dismissesMenu({ type: "mousedown", target: null }, root)).toBe(true);
    expect(dismissesMenu({ type: "mousedown", target: inside }, root)).toBe(false);
    expect(dismissesMenu({ type: "mousedown", target: outside }, null)).toBe(false);
  });

  it("lists every correction in the margin with an undo button, and hides the section when there is none", () => {
    const corrections = [{ kind: "goal" as const, source: "vigil", mode: "less" as const, label: "Goals that need a look, from vigil", createdAt: NOW }];
    const html = renderToStaticMarkup(<RankingSection corrections={corrections} onUndo={() => {}} />);
    expect(html).toContain("Less like this: Goals that need a look, from vigil");
    expect(html).toContain('aria-label="Undo &quot;Less like this&quot; for Goals that need a look, from vigil"');
    expect(renderToStaticMarkup(<RankingSection corrections={[]} onUndo={() => {}} />)).toBe("");
  });
});

describe("a goal item's actions", () => {
  const check = { id: "goal.check", label: "Check again now", role: "primary" as const, wired: true };
  const pause = { id: "goal.pause", label: "Pause this goal", role: "secondary" as const, wired: true };
  const goal = item(9, { kind: "goal", goal: "G6", actions: [check, pause] });

  it("shows a running check as busy, also after a reload while Vigil has not reported", () => {
    const page = renderToStaticMarkup(<DeskBody view={{ ...view, items: [{ ...goal, checking: true }] }} error={null} onOpenMissionControl={() => {}} />);
    expect(page).toContain(">Checking…</button>");
    expect(page).toContain(">Pause this goal</button>");
  });

  it("asks once more before it pauses a goal", () => {
    expect(withConfirm(goal, "goal.pause").actions.map((a) => a.label)).toEqual(["Check again now", "Yes, pause it"]);
    expect(renderToStaticMarkup(<ActionButton action={pause} onRun={() => {}} sending="goal.pause" />)).toContain(">Pausing…</button>");
  });
});

describe("a mail item's actions", () => {
  const seen = { id: "mail.seen", label: "Seen, delete", role: "primary" as const, wired: true };
  const del = { id: "mail.trash", label: "Delete", role: "secondary" as const, wired: true };
  const always = { id: "vip.add", label: "Always show mail from Grace", role: "secondary" as const, wired: true, target: "grace@example.org" };
  const mail = item(11, { key: "mail:m3", kind: "mail", title: 'Grace Hopper wrote: "Compilers"', actions: [seen, del], more: [always] });

  it("asks once more before Delete, but not before Seen, delete", () => {
    expect(withConfirm(mail, "mail.trash").actions.map((a) => a.label)).toEqual(["Seen, delete", "Yes, move it to Trash"]);
    expect(withConfirm(mail, "mail.seen").actions.map((a) => a.label)).toEqual(["Seen, delete", "Delete"]);
    expect(renderToStaticMarkup(<ActionButton action={seen} onRun={() => {}} sending="mail.seen" />)).toContain(">Deleting…</button>");
  });

  it("keeps the extra actions off the card", () => {
    const page = renderToStaticMarkup(<DeskBody view={{ ...view, items: [mail] }} error={null} onOpenMissionControl={() => {}} />);
    expect(page).toContain(">Seen, delete</button>");
    expect(page).not.toContain("Always show mail from Grace");
  });

  it("posts a mail action to the mail route and returns the server's line", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fake = async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: false, error: "The message is no longer in the work INBOX." }, { status: 502 });
    };
    expect(await submitMailAction({ action: "trash", key: "mail:m3" }, fake)).toEqual({ ok: false, text: "The message is no longer in the work INBOX." });
    expect(calls).toEqual([{ path: "/api/desk/mail", body: { action: "trash", key: "mail:m3" } }]);
  });
});

describe("mail triage on the Desk", () => {
  const evidence = (e: Parameters<typeof EvidenceLink>[0]["evidence"]): string => renderToStaticMarkup(<EvidenceLink evidence={e} onShowEvent={() => undefined} />);

  it("shows a meeting as a button, a URL as a link and anything else as plain text", () => {
    expect(evidence({ kind: "event", title: "Budget review", eventKey: "cal:work:r1" })).toContain("<button");
    expect(evidence({ kind: "note", title: "Plan", url: "https://notes.example/?nodeid=n1" })).toContain('href="https://notes.example/?nodeid=n1"');
    expect(evidence({ kind: "mail", title: "Earlier mail" })).not.toMatch(/<a |<button/);
  });

  it("shows the suggestion as one line under the reason", () => {
    const suggested = item(1, { kind: "mail", suggestion: "Suggested: reply" });
    const html = renderToStaticMarkup(<DeskBody view={{ ...view, items: [suggested] }} error={null} onOpenMissionControl={() => {}} />);
    expect(html).toContain('<p class="desk-why desk-suggest">Suggested: reply</p>');
  });
});
