import { expect, test } from "bun:test";
import type { OutlineNode } from "../../../balance";
import { balanceDestinations } from "../desk/balance-destinations";
import { DestinationPicker } from "../dashboard-v2/components/desk-destination-picker";
import { renderToStaticMarkup } from "react-dom/server";

const node = (id: string, children: OutlineNode[] = [], extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title: "Same name", weight: 50, ordering: "parallel", children, ...extra });
const task = node("leaf", [], { effort: 1 });
const outline = node("root", [node("area:work", [node("one", [task]), node("empty", [], { done: true }), node("closed", [node("hidden", [task])], { done: true }), node("task", [], { effort: 1 }), node("studio-response:r", [task])]), node("area:home", [node("two", [task])]), node("area:foreign", [node("foreign", [task])])]);
const areas = [{ id: "work", label: "Work", color: "" }, { id: "home", label: "Home", color: "" }];
test("destination choices use configured areas, open project identity and complete paths", () => {
  const options = balanceDestinations(outline, areas);
  expect(options.map(option => option.id)).toEqual(["area:work", "one", "empty", "area:home", "two"]);
  expect(options.find(option => option.id === "one")).toMatchObject({ area: "work", label: "Work / Same name", project: true });
  expect(options.find(option => option.id === "two")?.label).toBe("Home / Same name");
  expect(options.filter(option => option.area === "home" && option.project).map(option => option.id)).toEqual(["two"]);
  expect(balanceDestinations(outline, areas, true).map(option => option.id)).toContain("task");
  expect(balanceDestinations(outline, [], true)).toEqual([]);
});
test("missing selected ids are explicit invalid destinations rather than a silently selected first option", () => {
  const html = renderToStaticMarkup(<DestinationPicker label="Saved location" value="deleted" options={[{ id: "other", label: "Other" }]} onChange={() => undefined} />);
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("no longer available");
  expect(html).not.toContain('value="Other"');
});

test("immutable historical selections retain neutral unavailable feedback", () => {
  const html = renderToStaticMarkup(<DestinationPicker label="Saved location" value="deleted" options={[]} disabled onChange={() => undefined} />);
  expect(html).toContain("saved proposal is kept");
  expect(html).not.toContain("Choose another before confirming");
});
