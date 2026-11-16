import { describe, expect, test } from "bun:test";
import {
  MailDraftCommandRequestSchema, MailDraftCommandResultSchema,
  MailInvitationReplyCommandRequestSchema, MailInvitationReplyCommandResultSchema,
  MailLocateCommandRequestSchema, MailLocateCommandResultSchema,
  MailMoveCommandRequestSchema, MailMoveCommandResultSchema,
  MailReportCommandRequestSchema, MailReportCommandResultSchema,
  MailRestoreCommandRequestSchema, MailRestoreCommandResultSchema,
  MailTrashCommandRequestSchema, MailTrashCommandResultSchema,
  PushCommandRequestSchema,
} from "@the-metafactory/cortex/desk-sdk";

const ref = { account: "work", messageId: "mail@example.org" };

describe("desk-sdk mail command requests", () => {
  test("accepts the requests Cortex writes without changing their fields", () => {
    const requests = [
      [MailMoveCommandRequestSchema, { action: "move", ...ref, target: "archive" }],
      [MailRestoreCommandRequestSchema, { action: "restore", ...ref, from: "junk" }],
      [MailTrashCommandRequestSchema, { action: "trash", ...ref }],
      [MailLocateCommandRequestSchema, { action: "locate", ...ref }],
      [MailDraftCommandRequestSchema, { action: "draft", ...ref, to: "sender@example.org", subject: "Re: Hello", body: "A reply" }],
      [MailReportCommandRequestSchema, { action: "report", ...ref }],
      [MailReportCommandRequestSchema, { action: "report", ...ref, to: "report@example.org" }],
      [MailInvitationReplyCommandRequestSchema, { action: "invite-reply", ...ref, uid: "event", reply: "accept", requestId: "request" }],
      [MailInvitationReplyCommandRequestSchema, { action: "invite-reply", ...ref, uid: "event", reply: "decline", requestId: "request" }],
    ] as const;
    for (const [schema, request] of requests) expect(schema.parse(request)).toEqual(request);
    expect(MailMoveCommandRequestSchema.safeParse({ action: "move", ...ref, target: "other" }).success).toBe(false);
  });
});

describe("desk-sdk mail command results", () => {
  test("move, restore and trash preserve optional text and normalize the folder independently", () => {
    for (const schema of [MailMoveCommandResultSchema, MailRestoreCommandResultSchema, MailTrashCommandResultSchema]) {
      const answer = { message: "Moved.\nSaved.", folder: "  Archive  ", extra: true };
      expect(schema.parse(answer)).toEqual({ message: answer.message, folder: "Archive" });
      expect(schema.parse(JSON.stringify(answer))).toEqual(schema.parse(answer));
      expect(schema.parse({ message: 4, folder: "x".repeat(201) })).toEqual({ message: "", folder: "x".repeat(200) });
      expect(schema.parse({ message: "Moved", folder: "  " })).toEqual({ message: "Moved", folder: null });
    }
  });

  test("successful actions keep their fallbacks for unstructured or malformed stdout", () => {
    for (const stdout of ["", "not JSON", "null", "[]", "42", '"saved"', "{}", '{"message":false,"id":5,"folder":7}']) {
      expect(MailMoveCommandResultSchema.parse(stdout)).toEqual({ message: "", folder: null });
      expect(MailDraftCommandResultSchema.parse(stdout)).toEqual({ id: "" });
      expect(MailReportCommandResultSchema.parse(stdout)).toEqual({ message: "" });
      expect(MailInvitationReplyCommandResultSchema.parse(stdout)).toEqual({ message: "" });
      expect(MailLocateCommandResultSchema.safeParse(stdout).success).toBe(false);
    }
  });

  test("locate accepts only the five known places and only literal true means unread", () => {
    for (const place of ["inbox", "archive", "junk", "trash", "gone"] as const) {
      expect(MailLocateCommandResultSchema.parse(JSON.stringify({ place }))).toEqual({ place, folder: null, unread: false });
      expect(MailLocateCommandResultSchema.parse({ place, folder: "  Folder  ", unread: true })).toEqual({ place, folder: "Folder", unread: true });
      for (const unread of [false, "true", 1, null]) expect(MailLocateCommandResultSchema.parse({ place, unread }).unread).toBe(false);
    }
    expect(MailLocateCommandResultSchema.safeParse({ place: "other" }).success).toBe(false);
    expect(MailLocateCommandResultSchema.safeParse({ place: "INBOX" }).success).toBe(false);
  });

  test("draft ids are trimmed, and a missing or invalid id remains an empty id", () => {
    expect(MailDraftCommandResultSchema.parse('{"id":"  draft-1  "}')).toEqual({ id: "draft-1" });
    for (const answer of [{}, { id: null }, { id: 3 }, { id: "  " }]) expect(MailDraftCommandResultSchema.parse(answer)).toEqual({ id: "" });
  });

  test("report keeps long messages for one-line formatting while invitation replies bound the original message", () => {
    const long = "x".repeat(301);
    expect(MailReportCommandResultSchema.parse({ message: long })).toEqual({ message: long });
    expect(MailInvitationReplyCommandResultSchema.parse({ message: long })).toEqual({ message: "" });
    expect(MailInvitationReplyCommandResultSchema.parse({ message: "x".repeat(300) }).message).toHaveLength(300);
    expect(MailInvitationReplyCommandResultSchema.parse({ message: "   " })).toEqual({ message: "" });
    expect(MailInvitationReplyCommandResultSchema.parse({ message: " Sent.\nDone. " })).toEqual({ message: " Sent.\nDone. " });
  });
});

test("desk-sdk command push preserves reason wording and meeting hold metadata", () => {
  const push = {
    key: "mail:1", title: "Mail", why: "It matters.",
    action: { label: "Open", url: "https://mail.example.org/1" },
    reason: { code: "mail.vip", target: "sender@example.org", dueAt: "2026-11-16", eventKey: "meeting", phrase: { code: "mail.vip", params: { target: "sender@example.org", receivedAt: "2026-11-16", dismissed: 1 } } },
    held: { eventKey: "meeting", title: "Review", until: 1794816000000 },
  } as const;
  expect(PushCommandRequestSchema.parse(push)).toEqual(push);
  expect(PushCommandRequestSchema.parse({ key: "k", title: "t", why: "w" })).toEqual({ key: "k", title: "t", why: "w" });
  for (const url of ["javascript:alert(1)", "https://example.org/a b", "https://example.org/<x>"]) expect(PushCommandRequestSchema.safeParse({ ...push, action: { label: "Open", url } }).success).toBe(false);
});
