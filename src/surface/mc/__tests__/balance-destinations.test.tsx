import { expect, test } from "bun:test";
import type { OutlineNode } from "../../../balance";
import { areaProjects, balanceDestinations, resolveBalanceProject } from "../desk/balance-destinations";
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

test("unique legacy project titles resolve to IDs while duplicate titles need an explicit selection", () => {
  const choices = balanceDestinations(outline, areas);
  const projects = areaProjects(choices, "work");
  expect(resolveBalanceProject(projects, " same NAME ")?.id).toBeUndefined();
  expect(resolveBalanceProject(projects, "one")?.id).toBe("one");
  expect(resolveBalanceProject(areaProjects(choices, "home"), " same NAME ")?.id).toBe("two");
  expect(resolveBalanceProject(projects, "deleted")).toBeUndefined();
});

test("stale generated project IDs cannot be reinterpreted as another project's title", () => {
  const stale = "d5bd709e-9b83-4000-8000-4e91f1ba4d11";
  const choices = [{ id: "other", title: stale, label: `Work / ${stale}`, area: "work", project: true }];
  expect(resolveBalanceProject(choices, stale)).toBeUndefined();
  expect(resolveBalanceProject(choices, "other")?.id).toBe("other");
});
