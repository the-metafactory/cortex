import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailRuleSettingsBody } from "../components/desk-mail-rules";
import { DoneForYou } from "../components/desk-view";
import { submitMailRule } from "../lib/desk-action";
import type { MailRuleView } from "../../desk/mail-rules";

const RULE: MailRuleView = { id: "r1", match: "sender", value: "reports@dmarc.example", action: "archive", on: true, sentence: "Archive mail from reports@dmarc.example", lastRunAt: null, count: 3, held: null };
const ok = async (): Promise<boolean> => true;

describe("mail rules in Settings", () => {
  it("lists each rule with its match, action, count and the ways to change it", () => {
    const html = renderToStaticMarkup(<MailRuleSettingsBody rows={[RULE, { ...RULE, id: "r2", on: false, held: 34, sentence: "Delete mail from anyone at shop.example" }]} note={null} busy={false} onChange={ok} />);
    expect(html).toContain("Archive mail from reports@dmarc.example<small>On · handled 3 mails · never ran</small>");
    expect(html).toContain("Off · handled 3 mails · never ran · paused, 34 waiting");
    expect(html).toContain(">Turn off<");
    expect(html).toContain(">Turn on<");
    expect(html).toContain('aria-label="Delete: Archive mail from reports@dmarc.example"');
  });

  it("says how a rule comes about when there is none", () => {
    expect(renderToStaticMarkup(<MailRuleSettingsBody rows={[]} note={null} busy={false} onChange={ok} />)).toContain("No rules yet.");
  });
});

describe("rule runs in Done for you", () => {
  it("offers Undo and Stop doing this on a rule's line", () => {
    const html = renderToStaticMarkup(<DoneForYou autonomy={{ types: [], done: [{ key: "mail-move:x", action: "mail.rule", undo: "x", stop: "r1", title: "Archived by your rule: “Report”", message: "Moved to Archive.", at: 0, ok: true }] }} onPromote={() => {}} onUndo={() => {}} onStop={() => {}} />);
    expect(html).toContain("Archived by your rule: “Report”");
    expect(html).toContain(">Undo<");
    expect(html).toContain(">Stop doing this<");
  });

  it("posts a rule change and carries the changed rule back", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const out = await submitMailRule({ op: "stop", rule: "r1" }, async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, message: "Stopped.", rule: { ...RULE, on: false } });
    });
    expect(calls).toEqual([{ path: "/api/desk/mail/rules", body: { op: "stop", rule: "r1" } }]);
    expect(out).toEqual({ ok: true, text: "Stopped.", rule: { ...RULE, on: false } });
  });
});
