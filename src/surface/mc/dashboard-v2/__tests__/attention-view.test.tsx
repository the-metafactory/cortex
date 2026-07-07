/**
 * CK-6b (cortex#1289 Track A) — attention lifecycle render tests.
 *
 * Pins the render half of the resolve/dismiss affordance:
 *   - Resolve + Dismiss buttons render when the host wires `onLifecycle`, and
 *     each button drives the callback with the right `(id, action)` (the CK-6a
 *     `POST /api/attention/:id/{resolve,dismiss}` contract).
 *   - No mutation affordance when `onLifecycle` is omitted (read-only queue —
 *     the legacy tab / a scope with no host handler).
 *   - TRUTH-NOT-THEATER: NO Approve/Deny affordance is EVER rendered. Approve/
 *     Deny is SPX-7/SPX-8 (the runner arbitration channel doesn't exist yet), so
 *     shipping those buttons would be theater. This test is the standing guard.
 *
 * DOM-free, matching the suite convention (`renderToStaticMarkup` + a direct
 * element-tree walk of the pure component — AttentionView uses no hooks).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { AttentionView, type AttentionViewProps } from "../components/attention-view";
import type { AttentionEntry } from "../../api/attention";

function attn(id: string, over: Partial<AttentionEntry["item"]> = {}): AttentionEntry {
  return {
    item: {
      id,
      stackId: "meta-factory",
      workItemId: null,
      sessionId: null,
      kind: "review",
      severity: "high",
      status: "open",
      ...over,
    },
    link: { kind: "none" },
  };
}

/** Flatten a React children blob (element | array | string | null) to a list. */
function childList(children: ReactNode): ReactNode[] {
  if (Array.isArray(children)) return children.flatMap(childList);
  return children == null || children === false ? [] : [children];
}

/** Recursively collect every intrinsic element of `tag` in a rendered tree. */
function collect(node: ReactNode, tag: string, acc: ReactElement[] = []): ReactElement[] {
  if (!isValidElement(node)) return acc;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === tag) acc.push(el);
  for (const child of childList(el.props?.children)) collect(child, tag, acc);
  return acc;
}

/** Render the pure component to its element tree (no DOM needed). */
function tree(over: Partial<AttentionViewProps>): ReactElement {
  const props: AttentionViewProps = { entries: [], loaded: true, ...over };
  return AttentionView(props) as ReactElement;
}

function buttonsByClass(el: ReactElement, cls: string): ReactElement<{ className?: string; onClick?: () => void }>[] {
  return collect(el, "button").filter((b) =>
    ((b.props as { className?: string }).className ?? "").includes(cls),
  ) as ReactElement<{ className?: string; onClick?: () => void }>[];
}

describe("AttentionView — CK-6b lifecycle buttons", () => {
  it("renders Resolve + Dismiss for each open item when onLifecycle is wired", () => {
    const html = renderToStaticMarkup(
      createElement(AttentionView, {
        entries: [attn("a1"), attn("a2")],
        loaded: true,
        onLifecycle: () => {},
      }),
    );
    expect(html).toContain("attention-resolve");
    expect(html).toContain("attention-dismiss");
    expect(html).toContain("Resolve");
    expect(html).toContain("Dismiss");
    // one Resolve + one Dismiss per open item.
    expect((html.match(/attention-resolve/g) ?? []).length).toBe(2);
    expect((html.match(/attention-dismiss/g) ?? []).length).toBe(2);
  });

  it("renders NO lifecycle buttons when onLifecycle is omitted (read-only queue)", () => {
    const html = renderToStaticMarkup(
      createElement(AttentionView, { entries: [attn("a1")], loaded: true }),
    );
    expect(html).not.toContain("attention-action");
    expect(html).not.toContain("attention-resolve");
    expect(html).not.toContain("attention-dismiss");
  });

  it("wires Resolve → onLifecycle(id,'resolve') and Dismiss → onLifecycle(id,'dismiss')", () => {
    const calls: Array<[string, "resolve" | "dismiss"]> = [];
    const el = tree({
      entries: [attn("attn-42")],
      onLifecycle: (id, action) => calls.push([id, action]),
    });
    buttonsByClass(el, "attention-resolve")[0]!.props.onClick?.();
    buttonsByClass(el, "attention-dismiss")[0]!.props.onClick?.();
    expect(calls).toEqual([
      ["attn-42", "resolve"],
      ["attn-42", "dismiss"],
    ]);
  });

  it("TRUTH-NOT-THEATER — never renders an Approve/Deny affordance", () => {
    // Wired (buttons present) is the worst case for leaking a theater verb.
    const html = renderToStaticMarkup(
      createElement(AttentionView, {
        entries: [attn("a1"), attn("a2", { kind: "permission" }), attn("a3", { kind: "input_needed" })],
        loaded: true,
        onLifecycle: () => {},
      }),
    );
    const lower = html.toLowerCase();
    expect(lower).not.toContain("approve");
    expect(lower).not.toContain("deny");
    // And no button carries an approve/deny handle at the element level.
    const el = tree({ entries: [attn("a1")], onLifecycle: () => {} });
    expect(buttonsByClass(el, "approve").length).toBe(0);
    expect(buttonsByClass(el, "deny").length).toBe(0);
    // The full lifecycle surface is exactly {resolve, dismiss}.
    expect(buttonsByClass(el, "attention-resolve").length).toBe(1);
    expect(buttonsByClass(el, "attention-dismiss").length).toBe(1);
  });

  it("keeps the deep-link button alongside the lifecycle actions", () => {
    const entry: AttentionEntry = {
      item: attn("wi-1").item,
      link: { kind: "work-item", workItemId: "wi-1", label: "Fix the thing" },
    };
    const html = renderToStaticMarkup(
      createElement(AttentionView, {
        entries: [entry],
        loaded: true,
        onOpenWorkItem: () => {},
        onLifecycle: () => {},
      }),
    );
    expect(html).toContain("attention-link");
    expect(html).toContain("Fix the thing");
    expect(html).toContain("attention-resolve");
    expect(html).toContain("attention-dismiss");
  });
});
