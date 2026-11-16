import { describe, expect, test } from "bun:test";
import { CloseAnswer, DESK_ADAPTER_SDK_VERSION, MailLinkSchema, ParserAnswerSchema, ParserFieldSchemas, SourceEventSchema, SourceMailSchema, SourceOutputSchema, WriterAnswer } from "@the-metafactory/cortex/desk-sdk";

const mail = { kind: "mail", id: "m1", from: { address: "a@example.org" }, subject: "Hi", receivedAt: "2026-11-02T09:00:00Z", unread: true };

describe("desk-sdk command contract", () => {
  test("a source output with events and items passes, an array does not", () => {
    expect(SourceOutputSchema.safeParse({ events: [], items: [], capabilities: ["mail"] }).success).toBe(true);
    expect(SourceOutputSchema.safeParse([]).success).toBe(false);
    expect(SourceOutputSchema.safeParse(null).success).toBe(false);
  });

  test("an event without start is refused", () => {
    expect(SourceEventSchema.safeParse({ title: "Standup" }).success).toBe(false);
  });

  test("a mail item with a javascript link is refused, a safe one accepted", () => {
    expect(SourceMailSchema.safeParse({ ...mail, url: "javascript:alert(1)" }).success).toBe(false);
    expect(SourceMailSchema.safeParse({ ...mail, url: "https://example.org/m" }).success).toBe(true);
    expect(MailLinkSchema.safeParse({ text: "x", href: "javascript:alert(1)" }).success).toBe(false);
  });

  test("writer, closer and parser answers validate", () => {
    expect(WriterAnswer.safeParse({ id: "1", url: "ftp://x" }).success).toBe(false);
    expect(WriterAnswer.safeParse({ id: "1" }).success).toBe(true);
    expect(CloseAnswer.safeParse({ id: "" }).success).toBe(false);
    expect(ParserAnswerSchema.safeParse({ kind: "none", reason: "x" }).success).toBe(true);
    expect(ParserFieldSchemas.reminder.safeParse({ text: "Stretch", due: "not a date" }).success).toBe(false);
  });

  test("the version is the one this contract shipped in", () => {
    expect(DESK_ADAPTER_SDK_VERSION).toBe("1.16.1");
  });
});
