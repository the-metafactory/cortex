import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceConversationList } from "../components/desk-source-conversations";
import type { SourceConversations } from "../lib/conversations";

const title = `${"Rechnung Raumnutzung Theater Ida ".repeat(5)}${"X".repeat(40)}`.slice(0, 200);
const data: SourceConversations = {
  source: { ref: { owner: "balance-task", id: "t1" }, state: "available", policy: "local", title: "Task" },
  conversations: [{ id: "c1", stack: "default", title, links: [], policy: "local", state: "current", pinned: false, activity: { lastAt: "2026-11-02T12:00:00Z", status: "idle" }, origin: { kind: "web" } }],
  sessions: [{ id: "s1", subject: title, scope: "thread", phase: "ended", turns: 2 }],
};
const noop = () => {};
const rules = (file: string) => readFileSync(join(import.meta.dir, "../components", file), "utf8");
const rule = (css: string, selector: string): string => {
  const at = /\n([^\n{]+)\{/g;
  for (const m of css.matchAll(at)) if ((m[1] ?? "").trim() === selector) return /\{([^}]*)\}/.exec(css.slice(m.index))?.[1] ?? "";
  return "";
};

describe("Conversations with Ivy under a source", () => {
  const html = renderToStaticMarkup(<SourceConversationList data={data} pending={false} onResume={noop} onImport={noop} onNew={noop} newLabel="New conversation" />);
  const conversation = rules("desk-conversation.css");

  it("renders a 200-character title whole inside list-item buttons with the status after it", () => {
    expect(title).toHaveLength(200);
    expect(html).toContain(`<li><button type="button" class="desk-btn ghost">Resume · ${title} · ready</button></li>`);
    expect(html).toContain(`Open earlier exchange · ${title} (2 turns, saved)</button></li>`);
    expect(html).toContain(`<button type="button" class="desk-btn">New conversation</button></section>`);
  });

  it("lets list entries wrap, breaks unbroken strings, and keeps New conversation inside the column", () => {
    const entry = rule(conversation, ".dcv-src li .desk-btn");
    expect(entry).toContain("white-space: normal");
    expect(entry).toContain("height: auto");
    expect(entry).toContain("!important");
    expect(rule(conversation, ".dcv-src")).toContain("overflow-wrap: anywhere");
    expect(rule(conversation, ".dcv-src .desk-btn")).toContain("max-width: 100%");
  });

  it("leaves every other desk button single-line", () => {
    const base = rule(rules("desk-view.css"), ".desk-btn");
    expect(base).toContain("white-space:nowrap");
    expect(base).toContain("height:34px");
    expect([...conversation.matchAll(/^([^{@]*\.desk-btn[^{]*)\{/gm)].map(m => (m[1] ?? "").trim())).toEqual([".dcv-src .desk-btn", ".dcv-src li .desk-btn"]);
  });
});
