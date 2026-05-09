/**
 * Cross-module sync test — dashboard-v2 mirror ↔ backend authoritative array.
 *
 * Mirrors the legacy `src/mission-control/__tests__/state-ranks-sync.test.ts`
 * (which extracts `TASK_STATE_RANKS` from the legacy HTML monolith) but takes
 * the cheaper path here: the v2 dashboard is bundled, so we can `import` the
 * backend `STATE_RANKS` directly and assert array equality.
 *
 * Why this exists alongside `state-ranks.test.ts`:
 *   - `state-ranks.test.ts` pins the v2 array to a literal expectation, so a
 *     coordinated change to both backend and dashboard that contradicts F-8
 *     Decision 4 still fails.
 *   - This test pins the v2 array to the backend, so a one-sided edit to
 *     `db/tasks.ts` (or to the dashboard mirror) surfaces immediately.
 *
 * Together they catch both lock-step drift and silent cross-module drift.
 */

import { describe, it, expect } from "bun:test";
import { STATE_RANKS as BACKEND_RANKS } from "../../db/tasks";
import { STATE_RANKS as DASHBOARD_RANKS } from "../lib/state-ranks";

describe("STATE_RANKS — dashboard-v2 mirror ↔ db/tasks.ts authority", () => {
  it("v2 mirror stays in lock-step with the backend array", () => {
    expect([...DASHBOARD_RANKS]).toEqual([...BACKEND_RANKS]);
  });
});
