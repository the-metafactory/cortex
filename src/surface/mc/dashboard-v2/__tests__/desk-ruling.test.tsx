import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { afterFailure, cancelRuling, newRuling, RulingBox } from "../components/desk-ruling";
import { DESK_RULING_PATH, submitRuling } from "../lib/desk-action";
import type { DeskItem } from "../../desk/types";

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
};

const box = (draft = newRuling(blocked.key, "req-1"), sending = false) =>
  renderToStaticMarkup(<RulingBox item={blocked} draft={draft} sending={sending} onChange={() => {}} onConfirm={() => {}} onCancel={() => {}} />);

describe("the ruling box", () => {
  it("is headed by the agent's question, keeps the issue as a link, and offers Confirm and Cancel", () => {
    const html = box({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." });
    expect(html.indexOf("Resume once: the principal picks CSV or JSON")).toBeLessThan(html.indexOf("<textarea"));
    expect(html).toContain("Blocked: the spec names both formats.");
    expect(html).toContain('href="https://github.com/example/app/issues/12"');
    expect(html).toMatch(/<button[^>]*>Confirm<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
  });

  it("keeps Confirm off until there is a ruling", () => {
    expect(box()).toMatch(/<button[^>]*disabled=""[^>]*>Confirm<\/button>/);
  });

  it("after a refused resume, shows why, locks the recorded text and offers to resume again", () => {
    const draft = afterFailure({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." }, { text: "Your ruling is recorded; Ranger did not resume: lane held", recorded: true });
    const html = box(draft);
    expect(html).toContain("Your ruling is recorded; Ranger did not resume: lane held");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toMatch(/>Resume again<\/button>/);
    expect(afterFailure(draft, { text: "Mission Control did not answer: offline" }).recorded).toBe(true);
  });
  it("locks the text when no answer came, so a retry cannot record other words under the same request id", () => {
    const draft = afterFailure({ ...newRuling(blocked.key, "req-1"), text: "Use JSON." }, { text: "Mission Control did not answer: offline", uncertain: true });
    expect([draft.recorded, draft.locked]).toEqual([false, true]);
    const html = box(draft);
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toMatch(/>Try again<\/button>/);
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
