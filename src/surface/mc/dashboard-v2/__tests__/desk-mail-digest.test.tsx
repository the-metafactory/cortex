import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { digestsInArea, MailDigests } from "../components/desk-mail-digest";
import type { MailDigestView } from "../../desk/mail-digest";

const DIGEST: MailDigestView = {
  id: "digest:2026-11-02", day: "2026-11-02", kind: "digest", basis: "day", target: "archive", label: "newsletters", title: "3 newsletters from Monday 2 November",
  why: "Worth reading: 1 item.", area: null,
  mails: [
    { key: "mail:a", subject: "Patch round-up", from: "Security Briefing", at: "2026-11-02T06:00:00.000Z", url: "message://%3Ca%3E" },
    { key: "mail:b", subject: "Adapter contracts", from: "Cortex Weekly", at: "2026-11-02T06:01:00.000Z" },
    { key: "mail:c", subject: "Funding round-up", from: "Swiss Startups", at: "2026-11-02T06:02:00.000Z" },
  ],
  flags: [{ key: "mail:b", line: "It covers the adapter contract. (your Studio thread “Desk routing”)" }],
};

describe("the newsletter digest card", () => {
  it("lists each newsletter in one line, the flagged one first with its reason, and offers Archive all", () => {
    const html = renderToStaticMarkup(<MailDigests digests={[DIGEST]} busy={false} onMove={() => {}} onKeep={() => {}} />);
    expect(html).toContain("3 newsletters from Monday 2 November</h3>");
    expect(html.indexOf("Cortex Weekly")).toBeLessThan(html.indexOf("Security Briefing"));
    expect(html).toContain("worth reading");
    expect(html).toContain("your Studio thread “Desk routing”");
    expect(html).toContain('href="message://%3Ca%3E"');
    expect(html.match(/>Keep</g)).toHaveLength(3);
    expect(html).toContain("Archive all 3");
    expect(html).toContain(">Spam</button>");
    expect(html).toContain(">Delete</button>");
  });

  it("says why nothing is flagged, and shows nothing without digests", () => {
    const plain = { ...DIGEST, flags: [], why: "Nothing in them touches your Studio threads, focus projects or goals." };
    const html = renderToStaticMarkup(<MailDigests digests={[plain]} busy={false} onMove={() => {}} onKeep={() => {}} />);
    expect(html).not.toContain("worth reading");
    expect(html).toContain("Nothing in them touches");
    expect(renderToStaticMarkup(<MailDigests digests={[]} busy={false} onMove={() => {}} onKeep={() => {}} />)).toBe("");
  });

  it("offers Unsubscribe, the unsubscribe page or the archive rule on a newsletter line", () => {
    const mails = [
      { ...DIGEST.mails[0], key: "mail:a", unsubscribe: { kind: "one-click" as const, host: "lists.example" } },
      { ...DIGEST.mails[1], key: "mail:b", unsubscribe: { kind: "page" as const, host: "cortex.example", url: "https://cortex.example/leave?u=1" } },
      { ...DIGEST.mails[2], key: "mail:c", unsubscribe: { kind: "rule" as const, host: "startups.example" } },
    ].map((m) => ({ subject: "", from: "", at: "", ...m }));
    const html = renderToStaticMarkup(<MailDigests digests={[{ ...DIGEST, mails }]} busy={false} onMove={() => {}} onKeep={() => {}} onUnsubscribe={() => {}} />);
    expect(html).toContain(">Unsubscribe</button>");
    expect(html).toContain('href="https://cortex.example/leave?u=1"');
    expect(html).toContain("Unsubscribe page: cortex.example</a>");
    expect(html).toContain(">Archive what still arrives</button>");
    expect(renderToStaticMarkup(<MailDigests digests={[{ ...DIGEST, mails }]} busy={false} onMove={() => {}} onKeep={() => {}} />)).not.toContain("Unsubscribe");
  });

  it("filters by area and keeps cross-area digests everywhere", () => {
    const work = { ...DIGEST, id: "digest:w", area: "work" };
    expect(digestsInArea([DIGEST, work], "personal").map((d) => d.id)).toEqual([DIGEST.id]);
    expect(digestsInArea([DIGEST, work], "").map((d) => d.id)).toEqual([DIGEST.id, "digest:w"]);
  });
});
