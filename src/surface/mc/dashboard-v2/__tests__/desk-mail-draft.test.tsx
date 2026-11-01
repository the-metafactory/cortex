import { MailYesFilterBox } from "../components/desk-mail-yes-filter";
import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { newReplyDraft, prepareDeclineDraft, ReplyDraftBox } from "../components/desk-mail-draft";
import { DESK_MAIL_PATH, submitMailAction } from "../lib/desk-action";

const REPLY = { to: "Ada Boss <boss@example.org>", subject: "Re: Budget" };
const box = (text: string, note: string | null, sending = false) =>
  renderToStaticMarkup(<ReplyDraftBox reply={REPLY} draft={{ ...newReplyDraft("mail:b1"), text, note }} sending={sending} onChange={() => {}} onConfirm={() => {}} onCancel={() => {}} />);

it("shows who the reply goes to and its subject, and saves nothing until there is text", () => {
  const html = box("", null);
  expect(html).toContain("To: Ada Boss &lt;boss@example.org&gt;");
  expect(html).toContain("Subject: Re: Budget");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save as draft<\/button>/);
  expect(box("Friday works.", null)).not.toMatch(/disabled=""[^>]*>Save as draft/);
});

it("keeps the text and says what failed after a failed save", () => {
  const html = box("Friday works.", "The draft was not saved: The work account has no Drafts mailbox.");
  expect(html).toContain("Friday works.");
  expect(html).toContain('role="alert">The draft was not saved: The work account has no Drafts mailbox.</p>');
  expect(html).toContain(">Try again</button>");
  expect(box("Friday works.", null, true)).toContain(">Saving draft…</button>");
});

it("posts the reply text to the mail route", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fake = async (path: string, init: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, message: "Reply saved in your work Drafts." });
  };
  expect(await submitMailAction({ action: "draft", key: "mail:b1", body: "Friday works." }, fake)).toEqual({ ok: true, text: "Reply saved in your work Drafts." });
  expect(calls).toEqual([{ path: DESK_MAIL_PATH, body: { action: "draft", key: "mail:b1", body: "Friday works." } }]);
});


it("renders the configured mail Yes-filter and commitment action", () => {
  const html = renderToStaticMarkup(<MailYesFilterBox filter={{ questions: ["Configured capacity question?"], commitments: [{ kind: "project", id: "constructor", label: "Owned focus project" }], problems: [] }} canDraft disabled={false} onChoose={() => {}} onDecline={() => {}} />);
  expect(html).toContain("Configured capacity question?");
  expect(html).toContain("Which current commitment falls away?");
  expect(html).toContain("Prepare a decline");
});


it("preparing a decline preserves an existing unsent reply and commitment", () => {
  const draft = { ...newReplyDraft("mail:owned"), text: "My unsent words", commitment: { kind: "thread" as const, id: "owned", label: "Owned" } };
  expect(prepareDeclineDraft(draft)).toMatchObject({ text: draft.text, commitment: draft.commitment, intent: "decline", note: null });
});
