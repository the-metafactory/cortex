import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskPlan } from "../api/desk-plan";
import { handleDeskMyDay } from "../api/desk-my-day";
import { handleGetDesk } from "../api/desk";
import { addNote } from "../desk/notes";
import { HandledLedger } from "../desk/actions";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { DEFAULT_SETTINGS, findNode, type AppState } from "../../../balance";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import {
  changeMyDay,
  localDay,
  movedKeys,
  readMyDay,
  sourceIdentity,
} from "../desk/my-day";
import type { DeskOptions } from "../desk/compose";
import type { DeskItem } from "../desk/types";
import { balanceParents, proposeBalanceParent } from "../desk/balance-parent";

const now = new Date(2026, 10, 1, 10).getTime();
const date = localDay(now);
const desk: DeskOptions = {
  enabled: true,
  displayName: "",
  topN: 5,
  rangerUrl: "",
  sources: [],
  areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }],
};
const item: DeskItem = {
  key: "probe:source",
  source: "probe",
  kind: "agent-blocked",
  area: "work",
  title: "Review launch",
  why: "Needs a review",
  urgency: "today",
  dueAt: "2026-11-04T12:00:00Z",
  score: 50,
  actions: [],
  detail: {
    summary: "Owned synthetic source",
    history: [],
    refs: [],
    links: [],
  },
};
const routing = {
  version: 1,
  kind: "selected",
  provider: "pi",
  reason: "pi-fallback",
  attempted: ["pi"],
  candidates: [
    { substrate: "claude", reason: "not-permitted" },
    { substrate: "codex", reason: "not-permitted" },
    { substrate: "pi", reason: "eligible" },
  ],
  fallbackReasons: [],
  capabilityExclusions: [],
};
let db: Database;
beforeEach(() => {
  db = initDatabase(":memory:");
  const state: AppState = {
    outline: {
      id: "root",
      title: "Outline",
      weight: 100,
      ordering: "parallel",
      children: [
        {
          id: "area:work",
          title: "Work",
          weight: 50,
          ordering: "parallel",
          children: [
            {
              id: "existing",
              title: "Existing work",
              weight: 50,
              ordering: "parallel",
              children: [],
              effort: 1,
            },
          ],
        },
      ],
    },
    settings: { ...DEFAULT_SETTINGS },
    log: [],
    dayState: null,
    history: { deficits: {}, lastSurfaced: {} },
  };
  saveBalanceState(db, state);
});
afterEach(() => db.close());
function plan(
  parent: string | null = "area:work",
  requestId = crypto.randomUUID(),
) {
  const day = readMyDay(db, desk, now);
  const command = {
    op: "source-plan",
    revision: day.revision,
    key: item.key,
    fingerprint: sourceIdentity(item),
    parent,
  } as const;
  const args = { db, desk, now, date, requestId, command, source: item };
  return { args, result: changeMyDay(args) };
}
it("atomically files the current source once with due date, exact receipt and unchanged day", () => {
  const before = readMyDay(db, desk, now);
  changeMyDay({
    db,
    desk,
    now,
    date,
    requestId: crypto.randomUUID(),
    command: { op: "start", ids: before.items.map((i) => i.task.id) },
  });
  const dayBefore = loadBalanceState(db)?.dayState;
  const { args, result } = plan();
  expect(result.outlineId).toBeDefined();
  const saved = result.view.outline.children[0]?.children.find(
    (n) => n.id === result.outlineId,
  );
  expect(saved).toMatchObject({
    title: item.title,
    dueDate: "2026-11-04",
    children: [],
  });
  expect(result.view.inbox).toHaveLength(0);
  expect(result.view.sources).toMatchObject([
    {
      taskId: result.outlineId,
      key: item.key,
      fingerprint: sourceIdentity(item),
    },
  ]);
  expect(loadBalanceState(db)?.dayState).toEqual(dayBefore);
  expect(changeMyDay({ ...args, source: undefined }).outlineId).toBe(
    result.outlineId,
  );
  expect(readMyDay(db, desk, now).sources).toHaveLength(1);
  expect(movedKeys(db).has(sourceIdentity(item))).toBe(true);
});
it("retains a source on missing parent, stale revision, changed fingerprint or unavailable owner source", () => {
  const before = readMyDay(db, desk, now);
  const base = {
    db,
    desk,
    now,
    date,
    requestId: crypto.randomUUID(),
    command: {
      op: "source-plan",
      revision: before.revision,
      key: item.key,
      fingerprint: sourceIdentity(item),
      parent: "area:work",
    } as const,
    source: item,
  };
  for (const args of [
    { ...base, command: { ...base.command, parent: "missing" } },
    {
      ...base,
      command: { ...base.command, revision: base.command.revision + 1 },
    },
    { ...base, source: { ...item, title: "Changed" } },
    { ...base, source: undefined },
  ])
    expect(() => changeMyDay(args)).toThrow();
  expect(readMyDay(db, desk, now).sources).toHaveLength(0);
  expect(readMyDay(db, desk, now).inbox).toHaveLength(0);
});
it("reverses only the original unmodified filing and refuses old successful-plan replay", () => {
  const { args, result } = plan(null);
  if (!result.outlineId) throw new Error("missing receipt");
  const undo = {
    db,
    desk,
    now,
    date,
    requestId: crypto.randomUUID(),
    command: {
      op: "source-unplan",
      id: result.outlineId,
      filing: args.requestId,
    } as const,
  };
  changeMyDay(undo);
  changeMyDay(undo);
  expect(readMyDay(db, desk, now).sources).toHaveLength(0);
  expect(readMyDay(db, desk, now).inbox).toHaveLength(0);
  expect(() => changeMyDay(args)).toThrow("undone");
  expect(movedKeys(db).has(sourceIdentity(item))).toBe(false);
});
it("rejects reversal after a task is edited, moved, credited or selected", () => {
  const { args, result } = plan();
  if (!result.outlineId) throw new Error("missing receipt");
  const original = loadBalanceState(db);
  if (!original) throw new Error("missing state");
  const command = {
    op: "source-unplan",
    id: result.outlineId,
    filing: args.requestId,
  } as const;
  for (const change of ["edit", "move", "credit", "day"]) {
    const state = structuredClone(original);
    const node = findNode(state.outline, result.outlineId);
    if (!node) throw new Error("missing task");
    if (change === "edit") node.title = "Changed";
    if (change === "move") {
      const area = state.outline.children[0];
      if (!area) throw new Error("missing area");
      area.children = area.children.filter((n) => n.id !== node.id);
      area.children.push({
        id: "project",
        title: "New parent",
        weight: 50,
        ordering: "parallel",
        children: [node],
      });
    }
    if (change === "credit")
      state.log.push({
        taskId: node.id,
        title: node.title,
        areaId: "area:work",
        effort: 1,
        date,
      });
    if (change === "day")
      state.dayState = { date, closed: false, confirmed: [node.id] };
    saveBalanceState(db, state);
    expect(() =>
      changeMyDay({
        db,
        desk,
        now,
        date,
        requestId: crypto.randomUUID(),
        command,
      }),
    ).toThrow();
  }
});
it("proposes only existing parents with routing permissions covering all catalogue areas and no writes", async () => {
  const day = readMyDay(db, desk, now);
  const before = JSON.stringify(loadBalanceState(db));
  const options: DeskOptions = {
    ...desk,
    areas: [
      ...desk.areas,
      {
        id: "local",
        label: "Local",
        color: "",
        repos: [],
        goals: [],
        policy: "local",
      },
    ],
    ask: {
      parser: ["parser"],
      timeoutSeconds: 30,
      writers: {},
      taskMaps: [],
      routing: { permitted: ["claude", "pi"] },
    },
  };
  day.outline.children.push({
    id: "area:local",
    title: "Local",
    weight: 50,
    ordering: "parallel",
    children: [],
  });
  expect(balanceParents(day, options.areas).map((p) => p.id)).toEqual([
    "area:work",
    "area:local",
  ]);
  const proposal = await proposeBalanceParent({
    desk: options,
    day,
    source: item,
    run: async (_argv, stdin) => {
      expect(JSON.parse(stdin).routing.permitted).toEqual(["pi"]);
      return JSON.stringify({
        kind: "balance-parent",
        parent: "area:work",
        reason: "This area owns the review.",
        routing,
      });
    },
  });
  expect(proposal.parent).toBe("area:work");
  expect(JSON.stringify(loadBalanceState(db))).toBe(before);
  for (const output of [
    { kind: "balance-parent", parent: "absent", reason: "Choose", routing },
    { kind: "task", fields: {}, routing },
    {
      kind: "balance-parent",
      parent: "area:work",
      reason: "Choose",
      routing: { ...routing, provider: "claude" },
    },
  ]) {
    const fallback = await proposeBalanceParent({
      desk: options,
      day,
      source: item,
      run: async () => JSON.stringify(output),
    });
    expect(fallback.parent).toBeNull();
    expect(fallback.routing.kind).toBe("unavailable");
  }
});

it("freezes the existing proposed day before first-ever filing without a prior read", () => {
  const result = changeMyDay({
    db,
    desk,
    now,
    date,
    requestId: crypto.randomUUID(),
    source: item,
    command: {
      op: "source-plan",
      revision: 0,
      key: item.key,
      fingerprint: sourceIdentity(item),
      parent: "area:work",
    },
  });
  expect(result.view.items.map((i) => i.task.id)).toEqual(["existing"]);
  expect(result.view.items.map((i) => i.task.id)).not.toContain(
    result.outlineId,
  );
});

it("actual Desk handlers retain a changed source and file/read back/replay one current reminder", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
  const runtime = { options: desk, ledger: new HandledLedger() };
  addNote(db, "reminder", "Owned planning probe", now - 60_000, now);
  const initial = await handleGetDesk(db, runtime, undefined);
  const view = await initial.json();
  const source = view.items.find((i: DeskItem) => i.kind === "reminder");
  if (!source) throw new Error("missing reminder");
  const request = (body: unknown) =>
    new Request("http://localhost/api/desk/plan", {
      method: "POST",
      body: JSON.stringify(body),
    });
  const snapshot = JSON.stringify(loadBalanceState(db));
  const proposalResponse = await handleDeskPlan(
    request({ key: source.key, fingerprint: source.todoFingerprint }),
    db,
    runtime,
    undefined,
    now,
  );
  expect(proposalResponse.status).toBe(200);
  const proposal = await proposalResponse.json();
  expect(proposal.parent).toBeNull();
  expect(JSON.stringify(loadBalanceState(db))).toBe(snapshot);
  expect(
    (
      await handleDeskPlan(
        request({ key: source.key, fingerprint: "a".repeat(64) }),
        db,
        runtime,
        undefined,
        now,
      )
    ).status,
  ).toBe(409);
  const body = {
    date,
    requestId: crypto.randomUUID(),
    command: {
      op: "source-plan",
      revision: proposal.revision,
      key: source.key,
      fingerprint: source.todoFingerprint,
      parent: "area:work",
    },
  };
  const filed = await handleDeskMyDay(
    request(body),
    db,
    runtime,
    undefined,
    now,
  );
  expect(filed.status).toBe(200);
  const receipt = await filed.json();
  expect(receipt.location).toBe("Work");
  expect(receipt.outlineId).toBeDefined();
  expect(
    (await (await handleGetDesk(db, runtime, undefined)).json()).items.some(
      (i: DeskItem) => i.key === source.key,
    ),
  ).toBe(false);
  expect(
    (
      await (
        await handleDeskMyDay(request(body), db, runtime, undefined, now)
      ).json()
    ).outlineId,
  ).toBe(receipt.outlineId);
  const removed = await handleDeskMyDay(
    request({
      date,
      requestId: crypto.randomUUID(),
      command: {
        op: "source-unplan",
        id: receipt.outlineId,
        filing: body.requestId,
      },
    }),
    db,
    runtime,
    undefined,
    now,
  );
  expect(removed.status, await removed.text()).toBe(200);
  expect(
    (await handleDeskMyDay(request(body), db, runtime, undefined, now)).status,
  ).toBe(409);
  expect(
    (await (await handleGetDesk(db, runtime, undefined)).json()).items.some(
      (i: DeskItem) => i.key === source.key,
    ),
  ).toBe(true);
  } finally { clock.mockRestore(); }
});

it("reopens a file-backed DB and reverses an unchanged area filing through its original receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "source-plan-reopen-"));
  const path = join(dir, "owner.sqlite");
  let disk = initDatabase(path);
  try {
    const state = loadBalanceState(db);
    if (!state) throw new Error("missing fixture");
    saveBalanceState(disk, state);
    const before = readMyDay(disk, desk, now);
    const filing = crypto.randomUUID();
    const result = changeMyDay({
      db: disk,
      desk,
      now,
      date,
      requestId: filing,
      source: item,
      command: {
        op: "source-plan",
        revision: before.revision,
        key: item.key,
        fingerprint: sourceIdentity(item),
        parent: "area:work",
      },
    });
    if (!result.outlineId) throw new Error("missing receipt");
    disk.close();
    disk = initDatabase(path);
    const reversed = changeMyDay({
      db: disk,
      desk,
      now,
      date,
      requestId: crypto.randomUUID(),
      command: { op: "source-unplan", id: result.outlineId, filing },
    });
    expect(reversed.view.sources).toHaveLength(0);
    expect(findNode(reversed.view.outline, result.outlineId)).toBeNull();
  } finally {
    disk.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("rejects a parent snapshot changed by Studio while the read-only model proposal is in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "source-plan-studio-"));
  try {
    expect(
      await Bun.spawn(["git", "init", dir], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited,
    ).toBe(0);
    await mkdir(join(dir, "threads"));
    const file = join(dir, "threads/sketch.md");
    const text = (question: string) =>
      `---\nstudioId: 8add3e86-8796-4d32-9fd0-a3625f45bc92\ntype: question\nareas: [work]\nstate: active\nopened: ${date}\n---\n## Question\n${question}\n## Where I stand\nTry a small sketch.\n## Material\n## Ivy's notes\n## Log\n`;
    await writeFile(file, text("Which sketch?"));
    const options: DeskOptions = {
      ...desk,
      studio: { dir, maxActive: 5 },
      ask: {
        parser: ["controlled-parser"],
        writers: {},
        taskMaps: [],
        timeoutSeconds: 30,
        routing: { permitted: ["pi"] },
      },
    };
    const runtime = { options, ledger: new HandledLedger() };
    addNote(
      db,
      "reminder",
      "Owned source while Studio changes",
      now - 60_000,
      now,
    );
    const initial = await (await handleGetDesk(db, runtime, undefined)).json();
    expect(initial.myDay.studioStatus).toBe("synced");
    expect(JSON.stringify(initial.myDay.outline)).toContain("Which sketch?");
    const source = initial.items.find((i: DeskItem) => i.kind === "reminder");
    if (!source) throw new Error("missing source");
    const request = (body: unknown) =>
      new Request("http://localhost/api/desk/plan", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const response = await handleDeskPlan(
      request({ key: source.key, fingerprint: source.todoFingerprint }),
      db,
      runtime,
      undefined,
      now,
      async () => {
        await writeFile(file, text("Which revised sketch?"));
        return JSON.stringify({
          kind: "balance-parent",
          parent: "area:work",
          reason: "This area owns the sketch.",
          routing,
        });
      },
    );
    const proposal = await response.json();
    expect(response.status).toBe(200);
    const confirmed = await handleDeskMyDay(
      request({
        date,
        requestId: crypto.randomUUID(),
        command: {
          op: "source-plan",
          revision: proposal.revision,
          key: source.key,
          fingerprint: source.todoFingerprint,
          parent: proposal.parent,
        },
      }),
      db,
      runtime,
      undefined,
      now,
    );
    expect(confirmed.status).toBe(409);
    expect(await confirmed.text()).toContain("outline changed");
    expect(readMyDay(db, options, now).sources).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
