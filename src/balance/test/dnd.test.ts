import { required } from "../core/required";
import { describe, expect, test } from "bun:test";
import { computeDrop, findParent } from "../core/dnd";
import type { OutlineNode } from "../core/types";
function tree(): OutlineNode {
    const leaf = (id: string, children: OutlineNode[] = []): OutlineNode => ({
        id, title: id, weight: 50, ordering: "parallel", children,
    });
    return {
        id: "root", title: "Life", weight: 100, ordering: "parallel",
        children: [
            leaf("A", [leaf("a1"), leaf("a2", [leaf("a2x")]), leaf("a3")]),
            leaf("B"),
        ],
    };
}
describe("computeDrop", () => {
    test("into: append as last child of the target", () => {
        expect(computeDrop(tree(), "B", "A", "into")).toEqual({ parentId: "A" });
    });
    test("before a sibling: insert at that index in the shared parent", () => {
        expect(computeDrop(tree(), "a3", "a1", "before")).toEqual({ parentId: "A", index: 0 });
    });
    test("after a sibling: insert at index+1", () => {
        expect(computeDrop(tree(), "B", "a1", "after")).toEqual({ parentId: "A", index: 1 });
    });
    test("same-parent move DOWN corrects the index (detach shifts later items)", () => {
        expect(computeDrop(tree(), "a1", "a2", "after")).toEqual({ parentId: "A", index: 1 });
    });
    test("same-parent move UP does not over-correct", () => {
        expect(computeDrop(tree(), "a3", "a1", "before")).toEqual({ parentId: "A", index: 0 });
    });
    test("dropping a top-level area onto another resolves parent to 'root'", () => {
        expect(computeDrop(tree(), "B", "A", "before")).toEqual({ parentId: "root", index: 0 });
    });
    test("illegal: onto self", () => {
        expect(computeDrop(tree(), "A", "A", "into")).toBeNull();
    });
    test("illegal: into own subtree (would cut the branch off)", () => {
        expect(computeDrop(tree(), "a2", "a2x", "into")).toBeNull();
        expect(computeDrop(tree(), "A", "a2x", "after")).toBeNull();
    });
});
describe("findParent", () => {
    test("finds the parent at any depth; root for top-level", () => {
        const t = tree();
        expect(required(findParent(t, "a2x")).id).toBe("a2");
        expect(required(findParent(t, "A")).id).toBe("root");
        expect(findParent(t, "nope")).toBeNull();
    });
});
