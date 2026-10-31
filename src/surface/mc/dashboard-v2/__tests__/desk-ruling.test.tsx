import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { afterFailure, cancelRuling, newRuling, RulingBox } from "../components/desk-ruling";
import { DESK_RULING_PATH, submitRuling } from "../lib/desk-action";
import { RULING_FALLBACK } from "../../desk/ruling";
import type { DeskItem } from "../../desk/types";

const ALLOW = {
  label: "Allow the edit",
  consequence: "The agent may edit the export spec, and the node is resumed.",
  ruling: "Allow the edit to the export spec in example/app; resume the node.",
};

const PARK = {
  label: "Keep it parked",
  consequence: "Nothing is granted, and the node stays parked with the work undone.",
  ruling: "Do not grant the lane; keep the node parked in example/app.",
};

const explanation = {
  sentence: "The agent wants to edit the export spec in example/app, but it may only commit on its own node branch.",
  choices: [ALLOW, PARK],
};

const blocked: DeskItem = {
  key: "ranger:example/app#12",
  kind: "agent-blocked",
  source: "ranger",
  area: null,
  urgency: "waiting",
  title: '"Pick the export format" waits for your ruling.',
  why: "The agent in app cannot go on without a decision from you.",
  score: 65,
  actions: [{ id: "ranger.rule", label: "Give your ruling", role: "primary", wired: true }],
  detail: { summary: "blocked: …", history: [], refs: ["example/app#12"], links: [{ label: "Issue", url: "https://github.com/example/app/issues/12" }] },
  question: { condition: "the principal picks CSV or JSON", reason: "Blocked: the spec names both formats." },
  explanation,
};

const unexplained: DeskItem = { ...blocked, explanation: undefined };

const box = (item: DeskItem = blocked, draft = newRuling(item.key, "req-1"), sending = false) =>
  renderToStaticMarkup(<RulingBox item={item} draft={draft} sending={sending} onChange={() => {}} onConfirm={() => {}} onCancel={() => {}} />);

describe("the ruling box", () => {
  it("says what you are deciding in one sentence, names the choices, and keeps Ranger's report under a disclosure", () => {
    const html = box(blocked, { ...newRuling(blocked.key, "req-1"), text: ALLOW.ruling });
    expect(html.indexOf(explanation.sentence)).toBeGreaterThan(-1);
    expect(html.indexOf(explanation.sentence)).toBeLessThan(html.indexOf("<textarea"));
    expect(html).toContain(ALLOW.label);
    expect(html).toContain(ALLOW.consequence);
    expect(html).toContain(PARK.label);
    expect(html).toContain(PARK.consequence);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(ALLOW.ruling);
    expect(html).toMatch(/<details[^>]*class="desk-ruling-raw"/);
    expect(html).toMatch(/<summary>[^<]*Ranger[^<]*report<\/summary>/);
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("<textarea"));
    expect(html).toContain("Resume once: the principal picks CSV or JSON");
    expect(html).toContain("Blocked: the spec names both formats.");
    expect(html).toContain('href="https://github.com/example/app/issues/12"');
    expect(html).toMatch(/<button[^>]*>Confirm<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
  });

  it("says it could not explain the question, and still shows Ranger's report and the issue link", () => {
    const html = box(unexplained);
    expect(html).toContain(RULING_FALLBACK);
    expect(html).toMatch(/<details[^>]*class="desk-ruling-raw"/);
    expect(html).toContain("Resume once: the principal picks CSV or JSON");
    expect(html).toContain('href="https://github.com/example/app/issues/12"');
  });

  it("keeps Confirm off until there is a ruling", () => {
    expect(box()).toMatch(/<button[^>]*disabled=""[^>]*>Confirm<\/button>/);
  });

  it("after a refused resume, shows why, locks the recorded text and offers to resume again", () => {
    const draft = afterFailure({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." }, { text: "Your ruling is recorded; Ranger did not resume: lane held", recorded: true });
    const html = box(blocked, draft);
    expect(html).toContain("Your ruling is recorded; Ranger did not resume: lane held");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toMatch(/>Resume again<\/button>/);
    expect(afterFailure(draft, { text: "Mission Control did not answer: offline" }).recorded).toBe(true);
  });

  it("locks the text when no answer came, so a retry cannot record other words under the same request id", () => {
    const draft = afterFailure({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." }, { text: "Mission Control did not answer: offline", uncertain: true });
    expect([draft.recorded, draft.locked]).toEqual([false, true]);
    const html = box(blocked, draft);
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toMatch(/>Try again<\/button>/);
  });

  it("locks the choices with the text once a ruling may be recorded, so the box cannot show words the node does not hold", () => {
    const draft = afterFailure({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." }, { text: "lane held", recorded: true });
    const html = box(blocked, draft);
    expect(html).toMatch(/class="desk-ruling-choice"[^>]*disabled=""/);
    expect(box()).not.toMatch(/class="desk-ruling-choice"[^>]*disabled/);
  });

  it("keeps a ruling that may be recorded across Cancel, and drops one that cannot be", () => {
    const recorded = afterFailure({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." }, { text: "lane held", recorded: true });
    expect(cancelRuling(recorded)).toEqual({ ...recorded, open: false });
    const refused = afterFailure({ ...newRuling(blocked.key, "req-2"), text: "Use JSON." }, { text: "Your ruling was not recorded: closed" });
    expect(cancelRuling(refused)).toBeNull();
  });
});

describe("submitRuling", () => {
  it("posts the ruling with its request id and reports a recorded ruling whose resume failed", async () => {
    const seen: { path: string; body: unknown }[] = [];
    const result = await submitRuling({ key: blocked.key, text: "Use JSON.", requestId: "req-1" }, async (path, init) => {
      seen.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: false, recorded: true, error: "Your ruling is recorded; Ranger did not resume: lane held" }, { status: 502 });
    });
    expect(seen).toEqual([{ path: DESK_RULING_PATH, body: { key: blocked.key, text: "Use JSON.", requestId: "req-1" } }]);
    expect(result).toEqual({ ok: false, recorded: true, text: "Your ruling is recorded; Ranger did not resume: lane held" });
  });
});
