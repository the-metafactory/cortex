import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskLink, DeskSourceLink } from "../dashboard-v2/components/desk-link";
import { deskLinkAttributes, deskLinkMode, openDeskLink, sourceLinkLabel } from "../dashboard-v2/lib/desk-link";

const MAIL = "message://%3Cprobe%40example.org%3E";
const WEB = "https://example.org/thread/1";
const HOSTILE = ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", " message://x", "message:", "https://", "//example.org"];

function recorder() {
  const calls: string[] = [];
  return { calls, win: { open: (url: string, target: string, features: string) => { calls.push(`open ${url} ${target} ${features}`); return null; }, location: { assign: (url: string) => { calls.push(`assign ${url}`); } } } };
}

describe("desk link helper", () => {
  test("opens http(s) in a new tab and message:/mailto: in place", () => {
    expect(deskLinkMode(WEB)).toBe("tab");
    expect(deskLinkMode("HTTP://example.org")).toBe("tab");
    expect(deskLinkMode(MAIL)).toBe("here");
    expect(deskLinkMode("mailto:ada@example.org")).toBe("here");
    expect(deskLinkAttributes(WEB)).toEqual({ href: WEB, target: "_blank", rel: "noopener noreferrer" });
    expect(deskLinkAttributes(MAIL)).toEqual({ href: MAIL });
    const { calls, win } = recorder();
    expect(openDeskLink(WEB, win)).toBe(true);
    expect(openDeskLink(MAIL, win)).toBe(true);
    expect(calls).toEqual([`open ${WEB} _blank noopener`, `assign ${MAIL}`]);
  });

  test("refuses every other scheme", () => {
    const { calls, win } = recorder();
    for (const url of HOSTILE) {
      expect(deskLinkMode(url)).toBeNull();
      expect(deskLinkAttributes(url)).toBeNull();
      expect(openDeskLink(url, win)).toBe(false);
      expect(renderToStaticMarkup(createElement(DeskLink, { url, children: "Open" }))).toBe("");
      expect(renderToStaticMarkup(createElement(DeskSourceLink, { source: { kind: "mail", url } }))).toBe("<p>From mail</p>");
    }
    expect(calls).toEqual([]);
  });

  test("labels mail sources Open in Mail and opens them in place", () => {
    expect(sourceLinkLabel("mail")).toBe("Open in Mail");
    expect(sourceLinkLabel("github")).toBe("Open original source");
    expect(renderToStaticMarkup(createElement(DeskSourceLink, { source: { kind: "mail", url: MAIL } }))).toBe(`<a href="${MAIL}">Open in Mail</a>`);
    expect(renderToStaticMarkup(createElement(DeskSourceLink, { source: { kind: "github", url: WEB } }))).toBe(`<a href="${WEB}" target="_blank" rel="noopener noreferrer">Open original source</a>`);
    expect(renderToStaticMarkup(createElement(DeskSourceLink, { source: { kind: "note" } }))).toBe("<p>From note</p>");
  });
});
