import { describe, expect, it } from "bun:test";
import type { DeskItem } from "../../desk/types";
import { catchupItems } from "../components/desk-catch-up";
import { catchupMailGroups } from "../lib/catchup-filters";
import { catchupSearch, readCatchupLocation } from "../hooks/use-catchup-location";

const card = (over: Partial<DeskItem> = {}): DeskItem => ({
  key: "mail:one", kind: "mail", area: "work", source: "work-mail", urgency: "today",
  title: "Budget approval", why: "A reply is due", score: 50, actions: [],
  excerpt: "The invoice contains Zürich travel expenses.",
  detail: { summary: "Please approve the workshop", history: ["Discussed with Ada"], refs: ["sender@example.org"], links: [] },
  ...over,
});

describe("Catch-Up filters", () => {
  it("combines area, kind, attention and all search terms", () => {
    const mail = card();
    const cards = [mail, card({ key: "other", area: "home" }), card({ key: "decision", kind: "decision" }), card({ key: "update", attention: "update" })];
    expect(catchupItems(cards, "work", "action", "mail", "BUDGET zürich")).toEqual([mail]);
    expect(catchupItems(cards, "work", "all", "grilling", "")).toEqual([]);
    expect(catchupItems(cards, "", "all", "all", "nonexistent")).toEqual([]);
  });
  it("searches details, sender and history beyond the title, as literal text", () => {
    for (const query of ["workshop", "sender@example.org", "Ada", "  Zürich   invoice ", "reply"]) {
      expect(catchupItems([card()], "", "all", "all", query)).toHaveLength(1);
    }
    expect(catchupItems([card()], "", "all", "all", ".*")).toEqual([]);
    expect(catchupItems([card()], "", "all", "all", "  ")).toHaveLength(1);
  });
  it("preserves unrelated URL settings and round-trips filters and selected card", () => {
    const next = { area: "work", filter: "update", kind: "mail", query: "Zürich & budget", card: "mail:one" } as const;
    const search = catchupSearch("?api=local&thread=old", next);
    expect(readCatchupLocation(search)).toEqual(next);
    expect(new URLSearchParams(search).get("api")).toBe("local");
    expect(new URLSearchParams(search).has("thread")).toBe(false);
    expect(readCatchupLocation("?catchup-kind=invalid").kind).toBe("all");
    const cleared = catchupSearch(search, { area: "", filter: "all", kind: "all", query: "", card: null });
    expect(cleared).toBe("?api=local&desk=catchup");
  });
  it("finds grouped mail by member subject and sender and excludes it for other kinds", () => {
    const group = { id: "digest", kind: "digest", basis: "sender", target: "archive", label: "News", title: "Daily digest", why: "For later", area: "work", mails: [{ key: "one", subject: "Invoice", from: "Ada", at: "2026-11-02" }] } as const;
    const groups = [{ ...group, mails: [...group.mails] }];
    expect(catchupMailGroups(groups, "work", "mail", "ada invoice")).toHaveLength(1);
    expect(catchupMailGroups(groups, "home", "mail", "")).toEqual([]);
    expect(catchupMailGroups([{ ...group, mails: [...group.mails], id: "cross", area: null }], "home", "mail", "").map((g) => g.id)).toEqual(["cross"]);
    expect(catchupMailGroups(groups, "", "decision", "")).toEqual([]);
    expect(catchupMailGroups(groups, "", "mail", "missing")).toEqual([]);
  });
});
