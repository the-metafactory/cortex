import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { canSendInvite, InvitationBox, newInviteAsk, type InviteAsk } from "../components/desk-mail-invitation";
import { fetchInviteProposal } from "../lib/desk-action";
import type { InvitationView } from "../../desk/mail-invitation";

const VIEW: InvitationView = {
  uid: "uid-1", summary: "Budget review", when: "Tuesday 3 November, 14:00–15:00", start: "2026-11-03T13:00:00.000Z", end: "2026-11-03T14:00:00.000Z",
  organizer: "Olga <olga@example.org>", attendee: true, status: "NEEDS-ACTION", canReply: true,
  conflicts: { kind: "conflicts", events: [{ title: "Team sync", at: Date.parse("2026-11-03T13:00:00Z"), end: Date.parse("2026-11-03T13:30:00Z"), calendar: "Work", maybe: false }] },
  conflictLine: 'It overlaps "Team sync" (14:00–14:30).',
};

const box = (ask: InviteAsk | null, view: InvitationView = VIEW) => renderToStaticMarkup(<InvitationBox view={view} ask={ask} sending={false} onNothing={() => {}} onConfirm={() => {}} onCancel={() => {}} />);

it("shows the event, when, the organizer and its conflicts, and asks nothing until an answer is chosen", () => {
  const html = box(null);
  expect(html).toContain("Budget review");
  expect(html).toContain("Tuesday 3 November, 14:00–15:00");
  expect(html).toContain("From Olga &lt;olga@example.org&gt;");
  expect(html).toContain("It overlaps &quot;Team sync&quot;");
  expect(html).not.toContain("Send decline");
});

it("accept cannot be sent until a commitment falls away or nothing does; decline can", () => {
  const accept = { ...newInviteAsk("mail:i"), reply: "accept" as const };
  expect(canSendInvite(accept)).toBe(false);
  expect(box(accept)).toMatch(/<button[^>]*disabled=""[^>]*>Send acceptance<\/button>/);
  expect(canSendInvite({ ...accept, nothing: true })).toBe(true);
  expect(canSendInvite({ ...accept, commitment: { kind: "thread", id: "t", label: "Field Notes" } })).toBe(true);
  expect(box({ ...accept, commitment: { kind: "thread", id: "t", label: "Field Notes" } })).toContain("Falls away: Field Notes");
  const decline = { ...newInviteAsk("mail:i"), reply: "decline" as const };
  expect(canSendInvite(decline)).toBe(true);
  expect(box(decline)).toContain("Send your decline to Olga");
});

it("an answered invitation shows what was sent and offers no second answer", () => {
  const html = box({ ...newInviteAsk("mail:i"), reply: "decline" }, { ...VIEW, decision: { reply: "decline", status: "sent", at: 0, fallsAway: null, result: "Declined.", calendar: null } });
  expect(html).toContain("Decline sent.");
  expect(html).not.toContain("Send decline");
});

it("asks the mail route for proposed times", async () => {
  const calls: unknown[] = [];
  const fake = async (_path: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, body: "Would one of these work?", slots: 1 });
  };
  expect(await fetchInviteProposal("mail:i", fake)).toEqual({ ok: true, body: "Would one of these work?", note: null });
  expect(calls).toEqual([{ action: "invite.propose", key: "mail:i" }]);
});
