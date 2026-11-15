import { describe, expect, test } from "bun:test";
import type { Policy } from "../../types";
import type { ToolSession } from "../capabilities";
import { workContextTools, type WorkObject, type WorkOwner } from "../work-context";

const NOW = Date.parse("2026-11-15T09:00:00Z");
const object = (id: string, policy: Policy): WorkObject => ({ kind: "desk-item", id, title: `Item ${id}`, status: "open", summary: "summary", policy, area: null, url: `https://example.test/${id}`, observedAt: NOW });
const session = (policy: Policy, route: "local" | "cloud"): ToolSession => ({ principal: "p", conversationId: "c", transport: "web", route, policy, scope: [] });

async function call(name: "work_search" | "work_read", objects: readonly WorkObject[], to: ToolSession, input: object): Promise<{ answer: Record<string, unknown>; remembered: string[] }> {
  const remembered: string[] = [];
  const byId = new Map(objects.map(item => [item.id, item]));
  const owner: WorkOwner = {
    readers: () => ({
      "desk-item": {
        search: () => Promise.resolve({ items: [...objects], more: false }),
        read: id => {
          const found = byId.get(id);
          return Promise.resolve(found ? { state: "available", object: found } : { state: "unavailable", reason: "not-found" });
        },
      },
    }),
    now: () => NOW,
    remember: (_session, released) => { remembered.push(...released.map(item => item.id)); return Promise.resolve(true); },
  };
  const tool = workContextTools(owner).find(candidate => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const text = await tool.run(input, { project: null, graph: null, projects: [], session: to, signal: new AbortController().signal });
  return { answer: JSON.parse(typeof text === "string" ? text : text.text) as Record<string, unknown>, remembered };
}

describe("work tools release only what the residency gate clears", () => {
  const items = [object("open", "cloud"), object("private", "local"), object("unlabelled", "" as Policy)];

  test("a cloud conversation's search returns and remembers only cloud objects, even when the reader returns more", async () => {
    const { answer, remembered } = await call("work_search", items, session("cloud", "cloud"), { kinds: ["desk-item"], limit: 5 });
    expect(remembered).toEqual(["open"]);
    expect((answer.results as { id: string }[]).map(result => result.id)).toEqual(["open"]);
  });

  test("a cloud conversation cannot read a local or unlabelled object, and nothing is remembered", async () => {
    for (const id of ["private", "unlabelled"]) {
      const { answer, remembered } = await call("work_read", items, session("cloud", "cloud"), { kind: "desk-item", id });
      expect(answer.status).toBe("unauthorized");
      expect(answer).not.toHaveProperty("object");
      expect(remembered).toEqual([]);
    }
  });

  test("a local web conversation on the local model reads local objects", async () => {
    const { answer, remembered } = await call("work_read", items, session("local", "local"), { kind: "desk-item", id: "private" });
    expect(answer.status).toBe("ok");
    expect(remembered).toEqual(["private"]);
  });
});
