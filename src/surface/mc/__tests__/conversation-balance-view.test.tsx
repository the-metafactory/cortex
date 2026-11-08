import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import { ConversationBalanceTask, ConversationBalanceTaskDetails } from "../dashboard-v2/components/desk-conversation-balance-task";
import { balanceItemSearch, readBalanceLocation } from "../dashboard-v2/hooks/use-balance-location";
import { readMyDay } from "../desk/my-day";
import { NOW, dayDatabase, desk } from "./desk-day-fixture";

const ID = "task:glider/wing?part=1&note";
const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [{ id: ID, title: "Fold a glider", note: "Current saved instructions", dueDate: "2026-12-01", estimateMinutes: 20, context: "At home", weight: 50, ordering: "parallel", effort: 2, children: [] }] }] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});

describe("created conversation Balance task view", () => {
  const { db } = dayDatabase(seed);
  const render = (id: string): string => renderToStaticMarkup(<ConversationBalanceTaskDetails id={id} day={readMyDay(db(), desk, NOW)} onEdit={() => undefined} />);
  test("uses the shared saved summary and preserves the exact canonical identifier in its Balance route", () => {
    const html = render(ID);
    for (const value of ["Saved task details", "Fold a glider", "Current saved instructions", "20 minutes", "2026-12-01", "At home", ">Edit</button>"]) expect(html).toContain(value);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(readBalanceLocation(balanceItemSearch("?conversation=old&balance-search=hidden", ID)).item).toBe(ID);
  });
  test("a deleted or absent canonical task stays a clear missing reference instead of a creation form", () => {
    const html = render("missing-task");
    expect(html).toContain("no longer available in the saved outline");
    expect(html).not.toContain("<input");
    expect(html).not.toContain(">Edit</button>");
    expect(render("task:glider")).toContain("no longer available");
  });
  test("a created operation without a canonical reference cannot expose an editor", () => {
    const html = renderToStaticMarkup(<ConversationBalanceTask id={undefined} balance={{ reading: { kind: "loading" }, reload: () => undefined }} />);
    expect(html).toContain("has no saved reference");
    expect(html).not.toContain("<input");
    expect(html).not.toContain(">Edit</button>");
  });

});
