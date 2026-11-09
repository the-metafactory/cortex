import { describe, expect, it } from "bun:test";
import { mailHeader, openInMail, withoutMailFrame } from "../desk/studio/mail-header";

describe("mail capture header", () => {
  it("strips exactly the header and link it builds", () => {
    const body = "“Idea generator 2.0”. A video about ideas.";
    const framed = `${mailHeader("Ana Example <ana@example.org>", "2026-11-09 18:42")}${body}${openInMail("message:%3Cid@example.org%3E")}`;
    expect(withoutMailFrame(framed)).toBe(body);
  });

  it("strips a header whose sender has no name and whose date fell back to the raw value", () => {
    expect(withoutMailFrame(`${mailHeader("ana@example.org", "not-a-date: soon")}“Hi”.`)).toBe("“Hi”.");
  });

  it("leaves a question that is not a mail capture alone", () => {
    expect(withoutMailFrame("Mail from the bank: what next?")).toBe("Mail from the bank: what next?");
  });
});
