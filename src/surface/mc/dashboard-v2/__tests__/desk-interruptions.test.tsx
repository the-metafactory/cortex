import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InterruptionsSection, INTERRUPTIONS_UNAVAILABLE, switchInterruption, type InterruptionSwitch } from "../components/desk-interruptions";
import { ApiFailure } from "../lib/api";
import type { InterruptReasonView } from "../../desk/types";

const REASONS: InterruptReasonView[] = [
  { code: "meeting.soon", label: "A meeting is about to start", on: true, available: true, setBy: "default" },
  { code: "mail.vip", target: "boss@example.com", label: "Mail from Boss", on: false, available: true, setBy: "feedback", changedAt: 1 },
  { code: "mail.ranked", label: "Other mail ranked for today", on: true, available: false, setBy: "default" },
];

describe("the interruption switch list", () => {
  it("renders one switch per reason, disabled when the stack has it off, and says when feedback switched it off", () => {
    const html = renderToStaticMarkup(<InterruptionsSection reasons={REASONS} onSwitch={() => undefined} />);
    expect(html).toContain('aria-label="Interruptions"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="A meeting is about to start interrupts you" checked=""');
    expect(html).toContain('aria-label="Other mail ranked for today interrupts you" disabled="" checked=""');
    expect(html).toContain(INTERRUPTIONS_UNAVAILABLE);
    expect(html).toContain("Off after you said it was not important enough.");
    expect(renderToStaticMarkup(<InterruptionsSection reasons={[]} onSwitch={() => undefined} />)).toBe("");
  });

  it("posts the switch and shows the Desk's message, or the error and nothing else", async () => {
    const sent: [string, InterruptionSwitch][] = [];
    const ok = await switchInterruption({ code: "mail.vip", target: "boss@example.com", on: true }, async (path, body) => { sent.push([path, body]); return { message: "\"Mail from Boss\" interrupts you from now on." }; });
    expect(sent).toEqual([["/api/desk/interruptions", { code: "mail.vip", target: "boss@example.com", on: true }]]);
    expect(ok).toEqual({ ok: true, text: "\"Mail from Boss\" interrupts you from now on." });
    const refused = await switchInterruption({ code: "mail.ranked", on: true }, async () => { throw new ApiFailure({ status: 409, message: "Mail interruptions are turned off for this stack (mc.desk.interruptions.mail)." }); });
    expect(refused).toEqual({ ok: false, text: "Mail interruptions are turned off for this stack (mc.desk.interruptions.mail)." });
  });
});
