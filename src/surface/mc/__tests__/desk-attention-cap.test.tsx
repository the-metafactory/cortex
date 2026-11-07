import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { rankItems, rangerAttention } from "../desk/rank";
import type { RangerState } from "../desk/sources/ranger";
import { RangerAttentionList } from "../dashboard-v2/components/desk-catch-up";
import { applyCorrections } from "../desk/corrections";

const state = (): RangerState => ({
  current: [],
  needsYou: [
    { key: "stopped", repo: "example/app", nodeId: "500", title: "Blocked task", status: "blocked", endedAt: "2020-01-01", reason: { class: "blocked", detail: "Pick a direction" } },
    { key: "failed", repo: "example/app", nodeId: "501", title: "Failed task", status: "failed", endedAt: "2020-01-01" },
  ],
  maps: ["app", "other"].map((name, map) => ({
    key: `example/${name}#1`, repo: `example/${name}`,
    decisions: Array.from({ length: 50 }, (_, i) => ({ id: String(map * 100 + i + 1), title: `Decision ${map}-${i}` })),
    grillings: Array.from({ length: 50 }, (_, i) => ({ id: String(map * 100 + i + 51), title: `Question ${map}-${i}` })),
  })),
});
const ranked = () => rankItems({ now: Date.parse("2026-11-07"), subjects: [], ranger: state(), areas: [], conversations: true });

describe("Ranger attention cap", () => {
  test("200 ranked map nodes use the day limit, preserve every item per map, and never hide stopped agents", () => {
    const items = ranked();
    expect(items).toHaveLength(202);
    const corrected = applyCorrections(items, [{ kind: "grilling", source: "ranger", mode: "always", label: "Questions", createdAt: 0 }]);
    const { visible, groups } = rangerAttention(corrected, 5);
    expect(visible.filter(i => i.source === "ranger" && (i.kind === "decision" || i.kind === "grilling"))).toHaveLength(5);
    expect(visible.filter(i => i.kind.startsWith("agent-"))).toHaveLength(2);
    expect(visible[0]?.kind).toBe("grilling");
    expect(groups.map(g => [g.key, g.items.length])).toEqual([["example/app#1", 95], ["example/other#1", 100]]);
    expect(new Set([...visible, ...groups.flatMap(g => g.items)].map(i => i.key)).size).toBe(202);
    expect(rangerAttention(items, 1).groups.flatMap(g => g.items)).toHaveLength(199);
    expect(rangerAttention(items, 200).groups).toEqual([]);
  });

  test("fold rows name each map, show the count, and open a directly linked hidden card", () => {
    const items = ranked();
    const html = renderToStaticMarkup(<RangerAttentionList items={items} limit={5} selected="ranger:example/other#151" renderItem={item => <article key={item.key}>{item.title}</article>} />);
    expect(html.match(/<summary>/g)).toHaveLength(2);
    expect(html).toContain("95 more decisions and questions in example/app");
    expect(html).toContain("100 more decisions and questions in example/other");
    expect(html.match(/<details[^>]*open=""/g)).toHaveLength(1);
    expect(html.match(/<article/g)).toHaveLength(202);
  });

  test("grilling needs conversations, independently of Ranger execution configuration", () => {
    expect(ranked().find(i => i.kind === "grilling")?.actions[0]?.wired).toBe(true);
    const items = rankItems({ now: 0, subjects: [], ranger: state(), areas: [], rangerActions: true, waitingTasks: new Map([["example/app#51", { kind: "open", title: "Current source title", question: "A source question?", url: "https://example.test/51" }]]) });
    const grilling = items.find(i => i.kind === "grilling");
    expect(grilling?.actions[0]).toMatchObject({ id: "ranger.grill", wired: false });
    expect(grilling?.why).toBe("Conversations are not set up on this stack.");
  });
});
