import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, findNode, shiftDays } from "../src/balance";
import { loadBalanceState, saveBalanceState } from "../src/surface/mc/desk/balance-store";
import { localDay } from "../src/surface/mc/desk/time";
import { openMailRoundRig, roundAt } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";
import { runWithTemporaryHome } from "./probe-temp-home";

const HANDOFF = "00000000-0000-4000-8000-000000000001";
const KEY = `handoff:${HANDOFF}`;

async function probe(): Promise<void> {
  const now = roundAt(16, 10);
  const rig = await openMailRoundRig(now, {
    mailDigest: undefined,
    mailInvitations: undefined,
    dispatch: { agents: [{ id: "luna", label: "Luna", policy: "cloud" }], startTimeoutSeconds: 120, runTimeoutMinutes: 60 },
    areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" }],
  });
  const post = (body: unknown) => fetch(`${rig.baseUrl()}/api/desk/items/defer`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify(body) });
  try {
    rig.setState({ mail: [] });
    const db = rig.database();
    saveBalanceState(db, {
      outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: [{ id: "t1", title: "Fixture task", weight: 50, ordering: "parallel", children: [], effort: 1 }] }] },
      settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
    });
    db.query(
      `INSERT INTO desk_task_handoffs (id, task_id, title, area, agent, instruction, brief, attempt, attempt_request, state, sent_at, error, created_at, finished_at)
       VALUES (?, 't1', 'Fixture task', 'lab', 'luna', NULL, 'brief', 'attempt-1', 'request-1', 'failed', ?, 'fixture failure', ?, ?)`,
    ).run(HANDOFF, now - 3_600_000, now - 3_600_000, now - 60_000);
    assert.ok((await rig.get()).items.some((item) => item.key === KEY));
    assert.equal((await post({ action: "defer", key: KEY, until: { kind: "tomorrow" } })).status, 200);
    const read = (): string | undefined => {
      const state = loadBalanceState(db);
      return state ? findNode(state.outline, "t1")?.deferredUntil : undefined;
    };
    assert.equal(read(), shiftDays(localDay(now), 1));
    const away = await rig.get();
    assert.ok(!away.items.some((item) => item.key === KEY));
    assert.ok(away.deferred.some((item) => item.key === KEY));
    console.log(`POST defer task-handoff tomorrow: 200; outline deferredUntil = ${read()}; card in deferred[]`);
    assert.equal((await post({ action: "defer.cancel", key: KEY })).status, 200);
    assert.equal(read(), undefined);
    console.log("POST defer.cancel: 200; deferredUntil back to its earlier value");
  } finally {
    await rig.close();
  }
}

await runWithTemporaryHome(import.meta.path, probe);
