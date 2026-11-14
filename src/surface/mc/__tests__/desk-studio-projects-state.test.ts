import { afterEach, describe, expect, test } from "bun:test";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findNode } from "../../../balance";
import { acquireStudioLock } from "../desk/studio/write-lock";
import { balanceSyncFixture, SYNC_NOW } from "./fixtures/desk-balance-sync-fixture";

type Stack = Awaited<ReturnType<typeof balanceSyncFixture>>;
const stacks: Stack[] = [];
afterEach(async () => { await Promise.all(stacks.splice(0).map(stack => stack.close())); });

const note = (at: string, extra = "") => `### ${at}\ntrigger: A design check\nmodel: local\n${extra}\nA note.\n`;
const threadFile = (id: string, question: string, front: string, notes: string) => `---
studioId: ${id}
type: question
areas: [work]
${front}
opened: 2026-11-01
---
## Question
${question}
## Where I stand
Thinking.
## Ivy's notes
${notes}
## Log
`;
const ACTIVE = "5f0c7f4e-2d6b-4a43-9f8e-1a2b3c4d5e01";
const PARKED = "5f0c7f4e-2d6b-4a43-9f8e-1a2b3c4d5e02";
const CLOSED = "5f0c7f4e-2d6b-4a43-9f8e-1a2b3c4d5e03";

async function studio(): Promise<Stack> {
  const stack = await balanceSyncFixture();
  stacks.push(stack);
  const write = (name: string, body: string) => writeFile(join(stack.directory, "threads", `${name}.md`), body);
  await write("active", threadFile(ACTIVE, "Which sketch?", "state: active", note("2026-11-01T08:00:00Z") + note("2026-11-01T08:10:00Z", "sample: true") + note("2026-11-01T08:20:00Z", "status: kept")));
  await write("parked", threadFile(PARKED, "Which venue?", "state: parked", note("2026-11-01T08:00:00Z")));
  await write("closed", threadFile(CLOSED, "Which colour?", "state: closed\nclosed: 2026-11-01\noutcome: decided", note("2026-11-01T08:00:00Z", "status: dismissed")));
  return stack;
}
const bySlug = <T extends { slug: string }>(projects: T[]): Record<string, T | undefined> => Object.fromEntries(projects.map(project => [project.slug, project]));

describe("GET /api/desk/my-day studioProjects", () => {
  test("carries each thread's state and its open notes, sample notes included", async () => {
    const stack = await studio();
    const day = await stack.read();
    expect(day.studioStatus).toBe("synced");
    const projects = bySlug(day.studioProjects);
    expect(Object.keys(projects).sort()).toEqual(["active", "closed", "parked"]);
    expect(projects.active).toMatchObject({ slug: "active", state: "active", openNotes: 2 });
    expect(projects.parked).toMatchObject({ slug: "parked", state: "parked", openNotes: 1 });
    expect(projects.closed).toMatchObject({ slug: "closed", state: "closed", openNotes: 0 });
    for (const project of day.studioProjects) {
      expect(Object.keys(project).sort()).toEqual(["id", "openNotes", "slug", "state"]);
      expect(project.id).toStartWith("studio-thread:");
    }
  });

  test("keeps the outline rows, their done values and the proposals as the projection left them", async () => {
    const stack = await studio();
    const day = await stack.read();
    const ids = Object.fromEntries(day.studioProjects.map(project => [project.slug, project.id]));
    expect(findNode(day.outline, ids.active ?? "")?.done).toBe(false);
    expect(findNode(day.outline, ids.parked ?? "")?.done).toBe(true);
    expect(findNode(day.outline, ids.closed ?? "")?.done).toBe(true);
    const proposed = day.items.map(item => item.task.title);
    expect(proposed).toContain("Respond to the note on Which sketch?");
    expect(proposed).not.toContain("Which venue?");
    const again = await stack.read();
    expect(again.outline).toEqual(day.outline);
    expect(again.items).toEqual(day.items);
    expect(again.revision).toBe(day.revision);
  });

  test("leaves out an entry whose thread is no longer in the Studio", async () => {
    const stack = await studio();
    const before = bySlug((await stack.read()).studioProjects);
    await rm(join(stack.directory, "threads", "parked.md"));
    const after = await stack.read();
    expect(after.studioProjects.map(project => project.slug).sort()).toEqual(["active", "closed"]);
    expect(findNode(after.outline, before.parked?.id ?? "")?.done).toBe(true);
  });

  test("keeps id and slug but reports no state while the Studio cannot be read", async () => {
    const stack = await studio();
    const synced = (await stack.read()).studioProjects;
    const release = await acquireStudioLock(await realpath(stack.directory));
    if (!release) throw new Error("Could not hold the Studio lock");
    try {
      stack.setNow(SYNC_NOW + 1000);
      const day = await stack.read();
      expect(day.studioStatus).toBe("unavailable");
      expect(day.studioProjects).toEqual(synced.map(({ id, slug }) => ({ id, slug, state: null, openNotes: null })));
    } finally { await release(); }
  });

  test("keeps id and slug but reports no state while the Studio is turned off", async () => {
    const stack = await studio();
    const synced = (await stack.read()).studioProjects;
    const { studio: _off, ...options } = stack.runtime.options;
    stack.runtime.options = options;
    const day = await stack.read();
    expect(day.studioStatus).toBe("disabled");
    expect(day.studioProjects).toEqual(synced.map(({ id, slug }) => ({ id, slug, state: null, openNotes: null })));
  });
});
