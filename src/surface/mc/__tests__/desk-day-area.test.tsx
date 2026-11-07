import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import { DeskTimeFirst } from "../dashboard-v2/components/desk-time-first";
import { readMyDay } from "../desk/my-day";
import { reorderVisible } from "../desk/time-first";
import { DATE, NOW, dayDatabase, desk } from "./desk-day-fixture";

const areas = [{ id: "work", label: "Same label", color: "", repos: [], goals: [] }, { id: "personal", label: "Same label", color: "", repos: [], goals: [] }, { id: "empty", label: "Empty area", color: "", repos: [], goals: [] }];
const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: areas.map(area => ({ id: `area:${area.id}`, title: area.label, weight: 50, ordering: "parallel", children: area.id === "empty" ? [] : [1, 2].map(index => ({ id: `${area.id}-${index}`, title: `${area.id} task ${index}`, weight: 50, ordering: "parallel", children: [] })) })) },
  settings: { ...DEFAULT_SETTINGS, todayCap: 5 }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: { date: DATE, confirmed: ["work-1", "personal-1", "work-2", "personal-2"], closed: false },
});

describe("Day priorities area", () => {
  const { db } = dayDatabase(seed);
  const render = (selectedArea: string): string => {
    const day = readMyDay(db(), { ...desk, areas }, NOW);
    const html = renderToStaticMarkup(<DeskTimeFirst {...{ selectedArea }} day={day} now={NOW} before={null} after={null} proposal={null} preview={null} ambient={null} areas={areas} onChanged={() => undefined} onThread={() => undefined} />);
    return html.slice(html.indexOf('id="today-priorities"'), html.indexOf('</aside>'));
  };
  it("filters by area identity when two areas share the same label", () => {
    const personal = render("personal");
    expect(personal).toContain("personal task 1");
    expect(personal).toContain("personal task 2");
    expect(personal).not.toContain("work task 1");
    expect(personal).not.toContain("work task 2");
    const work = render("work");
    expect(work).toContain("work task 1");
    expect(work).not.toContain("personal task 1");
  });
  it("restores every priority in saved order when the area is cleared", () => {
    const all = render("all");
    expect([...all.matchAll(/<strong>(.*?)<\/strong>/g)].map(match => match[1])).toEqual(["work task 1", "personal task 1", "work task 2", "personal task 2"]);
  });
  it("names an area with no priorities without changing the saved day", () => {
    const before = readMyDay(db(), { ...desk, areas }, NOW);
    const empty = render("empty");
    expect(empty).toContain("No priorities in Empty area today.");
    expect(empty).not.toContain("personal task 1");
    expect(readMyDay(db(), { ...desk, areas }, NOW)).toEqual(before);
  });
  it("reshuffles visible priorities while keeping hidden priorities in their slots", () => {
    const ids = ["work-1", "personal-1", "work-2", "personal-2"];
    expect(reorderVisible(ids, ["personal-1", "personal-2"], "personal-2", -1)).toEqual(["work-1", "personal-2", "work-2", "personal-1"]);
    expect(ids).toEqual(["work-1", "personal-1", "work-2", "personal-2"]);
  });
});
