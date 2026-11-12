# Result attention review dispositions

This record covers all nineteen findings from Sage round 1 on [PR #2665](https://github.com/the-metafactory/cortex/pull/2665), reviewed at `48e55964fa29643fc3d12e0c8e03cc3291adeb29`, for [Review findings left open by node #2569](https://github.com/the-metafactory/cortex/issues/2667). Locations below refer to that reviewed commit, so subsequent line movement does not change which finding is addressed. The checkpoint is `review-findings-2569-48e55964`.

## Goal and criteria

Every finding has a correction or an explicit decline with a reason. Wire fields, attention kinds, digest text and diagnostic strings stay as they were. The supervisor owns publication, review and the eventual close receipt; this record supplies its dispositions and does not attest that this branch has merged.

## Dispositions

| ID | Reviewed location and finding | Disposition and reason |
| --- | --- | --- |
| F1 | `src/vigil/digest.ts:16`, unused `"proposals"` section | Already fixed by node #2589 in merged PR #2676: `prepareDigest` pushes `proposalDigestLines` into that section (`src/vigil/digest.ts:65`), so the heading is emitted with proposal lines and is not dead. |
| F2 | `src/vigil/result-render.ts:25`, cortex reads soma's on-disk layout | Fixed: every soma layout path now lives in one module, `src/vigil/soma-output.ts` (`outputs`, `proposals`, `profile/goals`, and the containment checks). `GoalWordingResolver` stays injected; `somaGoalWording` only maps a stack to its soma home and asks `readSomaGoalTitle`. The cross-boundary read remains a recorded coupling: cortex reads soma's files because soma publishes no envelope carrying result titles or goal wording. The coupling is one module wide and is removed when soma provides that contract. |
| F3 | `src/surface/mc/api/attention.ts:60`, MC API handler queries the Vigil table with inline SQL | Fixed: `getResultByAttentionId` and `getResult` are exported from `src/vigil/results.ts`, `getProposalByAttentionId`, `getProposal` and `setProposalFilingError` from `src/vigil/proposals.ts`, and `handleListAttention`/`handleAttentionLifecycle` call them. The MC API layer holds no Vigil SQL. `src/surface/mc/api/vigil.ts` already delegates to `src/vigil/subjects-view.ts`; its inline `vigil_result_subjects` query was removed by node #2661. |
| F4 | `src/vigil/result-render.ts:17`, whole output file read for its first line | Fixed: titles are read through `readSomaTitle`/`readTitleWithin`, which open the file and read an 8 KiB prefix. A prefix that is cut inside frontmatter falls back to the reference. The `/results/` and `/proposals/` route still reads the full file because it serves the body. Covered by the new bounded-prefix test in `src/vigil/__tests__/results.test.ts`. |
| F5 | `src/vigil/results.ts:69`, `vigil_results` grows forever and scans grow with it | Fixed by the second option the finding offers: `idx_vigil_results_ran_ref`, `idx_vigil_results_expires_at`, `idx_vigil_proposals_ran_ref` and `idx_vigil_proposals_expires_at` are created in `SCHEMA_SQL` and asserted in `src/surface/mc/__tests__/schema.test.ts`. Retention deletion is not added: rows carry the history replay needs, and the two hot queries are now indexed. |
| F6 | `src/vigil/result-render.ts:8`, result base URL default duplicated | Fixed: `DEFAULT_RESULT_BASE_URL` lives in `src/common/result-base-url.ts`; `VigilSchema.result_base_url` defaults from it and `result-render.ts`/`proposals.ts` build links from the same import. The config test still asserts the loopback URL, so a drift in either place fails. |
| F7 | `src/vigil/results.ts:24`, `ingestResult` does four jobs | Fixed: `ingestResult` now returns early, calls `linkResultSubjects`, then `ingestRefAttention`. The version bump and sibling supersession had already moved to `src/vigil/ref-attention.ts`; the subject-link loop is the only step left in `results.ts` and it has its own name. |
| F8 | `src/surface/mc/api/attention.ts:60`, inline Vigil row lookups duplicated | Fixed by the same getters as F3: proposal rows come from `getProposalByAttentionId`, result rows from `getResultByAttentionId`, and proposal filing errors are written by `setProposalFilingError`. A schema change to either Vigil ref table now touches one module. |
| F9 | `src/vigil/result-render.ts:49`, result links target a route this diff never adds | Already fixed by node #2570 in merged PR #2668: `src/surface/mc/server.ts:351` routes `/results/` and `/proposals/` to `handleResult`, which resolves the ref through soma-output containment, sanitizes the markdown and marks the result read. `src/surface/mc/__tests__/results-route.test.ts` proves nested and symlinked refs resolve, traversal and encoded dot-dot return 404 without opening a file, and the route is absent on a non-loopback bind. |
| F10 | `src/surface/mc/__tests__/vigil.test.ts:43`, alias `run` | Already fixed by node #2661 in merged PR #3538: the file opens with `// glossary-ignore: node, run` (line 1). The flagged occurrences are `run:…` subject-key literals and the `run:%s` cadence case, which are the Vigil subject vocabulary itself. |
| F11 | `src/surface/mc/dashboard-v2/__tests__/vigil-view.test.tsx:9`, alias `run` | Already fixed by node #2661 in merged PR #3538: the file opens with `// glossary-ignore: server, run` (line 1). The flagged occurrences are `lastRunId` and `run-123`, the field and value the view renders. |
| F12 | `src/vigil/__tests__/config.test.ts:61`, alias `agent` | Declined: `{ agent: { name, displayName } }` is the existing top-level key of `AgentConfigSchema`, parsed here to prove the Vigil defaults survive the legacy agent config shape. It names the runtime identity block, not a Session; renaming it would change the config contract. |
| F13 | `src/vigil/__tests__/results.test.ts:3`, alias `node` | Declined: `node:fs` is a Node builtin module specifier. It names no Stack or Cortex runtime, and rewriting the specifier would break module resolution. |
| F14 | `src/vigil/__tests__/results.test.ts:5`, alias `path` | Declined: `node:path` is a Node builtin module specifier, and the file uses `join` for filesystem locations. Neither is a NATS Subject. |
| F15 | `src/vigil/__tests__/results.test.ts:27`, alias `body` | Corrected here: the fixture and assertion text now say `contents` (`Private file contents`, `Private goal contents`, `Private revised contents`), which is what the assertion is about. |
| F16 | `src/vigil/__tests__/results.test.ts:102`, alias `run` | Declined: the test descriptions speak of `run` envelopes and `run` identity because they replay `execution.run.finished` payloads. Myelin's `CONTEXT.md` defines that Execution Run and distinguishes it from a cortex Session; substituting `Session` would misdescribe the ledger contract under test. |
| F17 | `src/vigil/result-render.ts:1`, alias `node` | Fixed: `result-render.ts` no longer imports `node:fs/promises`; the file-reading code moved to `src/vigil/soma-output.ts`. |
| F18 | `src/vigil/result-render.ts:3`, alias `path` | Fixed: `result-render.ts` no longer imports `node:path` or names a filesystem path; the remaining goal-wording function takes a goal ID and a soma home. |
| F19 | `src/vigil/result-render.ts:17`, alias `body` | Fixed: `firstBodyLine` moved into `src/vigil/soma-output.ts` and became `readTitleWithin`; `result-render.ts` now names the title, not a body. |

## Contract evidence

- Soma's on-disk layout is read only in [`soma-output.ts`](../src/vigil/soma-output.ts), which owns the `outputs`, `proposals` and `profile/goals` paths and the containment checks; [`result-render.ts`](../src/vigil/result-render.ts) takes an injected `GoalWordingResolver`.
- [`results.ts`](../src/vigil/results.ts) and [`proposals.ts`](../src/vigil/proposals.ts) own the `vigil_results` and `vigil_proposals` rows; [`attention.ts`](../src/surface/mc/api/attention.ts) calls their getters.
- [`schema.ts`](../src/surface/mc/db/schema.ts) creates the two ref tables and their `ran_ref`/`expires_at` indexes in `SCHEMA_SQL`; both columns exist from table creation, so no column-add ordering hazard applies.
- Myelin's `CONTEXT.md` defines the Execution Run that the replayed `execution.run.finished` envelopes report, which is why F16 keeps that vocabulary.
- Cortex [`CONTEXT.md`](../CONTEXT.md) defines **Session**, **Subject** and **Payload**, which bound the aliases in F10–F19.

## Settled by

[What is the Vigil contract: run-ledger envelope, tick, routing and attention budget?](https://github.com/the-metafactory/soma/issues/787) defines the execution reporting vocabulary and the attention contract these dispositions preserve.

## Verification

On 2026-11-12, `bun run check` passed on this host: lint, duplication, typecheck, vocabulary, SDK, shippable hygiene, XDG, tests and branch ancestry. The test runner reported 15,671 passed, 31 skipped and 201 todo tests across 956 files, zero failures. A disposition audit confirmed F1-F19 appear exactly once: eleven corrected on this branch, four already fixed by merged changes (F1 by node #2589, F9 by node #2570, F10 and F11 by node #2661) and four declined with a reason. Every relative source link in this record resolves.
