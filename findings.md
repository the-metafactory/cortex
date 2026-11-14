# What the bundled Desk gets from Cortex by in-process import (node #3666)

Base: this branch's base commit (`7267f32f`). Threva was read at `jcfischer/threva-app` `main` `89a7939` (2026-11-14), production `src/` only. This node reads; no file other than this one changed.

## Summary

- **Scope.** 139 files under `src/surface/mc/dashboard-v2` import from `desk/` or `api/`. 27 of them are tests, so 112 production files remain.
- **Runtime imports.** Production code imports **100 distinct runtime symbols** (118 bindings) from 43 modules, in 40 files. Every one is under `desk/`. **No runtime value comes from `api/`.**
- **Type-only imports.** These are counted, not listed: 277 bindings, 164 distinct symbols, 66 modules. There are also 12 inline `import("…")` type references, to 7 `desk/mail-*` modules.
  - The Desk accounts for 77 files and 127 type symbols.
  - Mission Control views that are not the Desk account for 35 files and 37 type symbols, all from 14 `api/` modules: `agents`, `attention`, `doctor`, `git-links`, `git-repos`, `governance`, `handoff`, `networks`, `observability-tab`, `phase-detail`, `plans`, `types`, `vigil` and `work-item-detail`.
- **How the 100 runtime symbols sort:**

| Bucket | Symbols |
|---|---|
| Already served by a route | 32 |
| Presentation that belongs in the external UI | 31 |
| Backend behaviour with no route (gap candidates) | 23: 11 derived-state rules, 12 input vocabularies |
| Used only by Mission Control views that are not the Desk | 0 |
| Imported by code the running Desk never mounts | 14 |

### Side findings

- **F1. The adapter-frame host is dead in the running Desk.** `components/desk-adapter-frame.tsx` and `lib/desk-adapter-frame.ts` are imported by nothing in production. Its 14 runtime symbols are reachable only from tests.
- **F2. Threva sends conversation input to a route that refuses it.** `threva-app` `src/ui/api/conversations.ts:54` sends `POST /api/conversations/{id}`. In `src/surface/mc/api/conversations.ts`, `/{id}` with no sub-part accepts only GET and PATCH, so it answers 405. The Desk posts to `/{id}/inputs` instead (`dashboard-v2/lib/conversations.ts:62`). I read this in the code and did not run it. It is the kind of drift a pinned contract test would catch.
- **F3. Several routes have no caller at all.** Neither the Desk nor any external client calls these today: `/api/desk/task-handoff`, `/api/desk/links`, `/api/desk/interruptions` (GET and POST), `/api/desk/studio/relations`, `/api/desk/balance/read`, `/api/conversations/discord/check`, `POST /api/conversations/{id}/links`, `POST /api/conversations/{id}/attachments` and `GET /api/conversations/{id}/discord`. The full list is in the last section.
- **F4. The Desk computes Studio relations itself.** The relations route serves the same data (`relatesTo`), but `desk-studio.tsx` computes it in-process through `buildThreadPage`.

## Method

The import inventory is a scan of every `import`, `export … from` and inline `import("…")` in `dashboard-v2` whose resolved path lies under `src/surface/mc/desk` or `src/surface/mc/api`.

- **Type-only.** A binding counts as type-only when it sits under `import type` or carries an inline `type` prefix.
- **Desk versus other views.** Reachability splits the two: files reachable from `components/desk-view.tsx` are the Desk. Files reachable from `app.tsx` without passing through `desk-view.tsx` belong to the other Mission Control views.
- **Backend importers.** For each runtime symbol, the backend importers are the non-test files outside `dashboard-v2` that import it.
- **Route callers.** Callers come from string and constant references to `/api/desk*` and `/api/conversations*` in three places:
  - the Desk;
  - `src/` outside `src/surface/mc/{server,api,desk}`;
  - Threva's `src/`.

The routes themselves come from `src/surface/mc/server.ts` and `src/surface/mc/api/conversations.ts`.

## 1. Already served by a route (32)

Each of these is a path constant, or a zod schema that parses a route's response or validates its input. An external UI gets the data over HTTP. It needs the schema published in the versioned contract, not the module.

| Symbol | Module (`desk/…`) | Desk importer | Route |
|---|---|---|---|
| `ParentProposalSchema` | `balance-parent-schema` | `desk-catch-up.tsx` | `POST /api/desk/plan` |
| `BALANCE_SURFACES_DESTINATIONS` | `balance-surface-schema` | `lib/desk-balance-surfaces.ts` | `GET /api/desk/balance-surfaces/*` |
| `balanceSurfaceTaskPath` | `balance-surface-schema` | `lib/desk-balance-surfaces.ts` | `GET /api/desk/balance-surfaces/*` |
| `CalendarSchema` | `calendars` | `lib/desk-calendars.ts` | `/api/desk/calendars` |
| `DESK_DRAFTS_PATH` | `draft-editor-contract` | `lib/desk-drafts.ts` | `/api/desk/drafts[/*]` |
| `flowCardPath` | `flow-surface-schema` | `lib/desk-flows.ts` | `GET /api/desk/flows/card` |
| `GRAPH_REPOSITORIES_PATH` | `graph-repository-schema` | `lib/desk-graph-repositories.ts` | `/api/desk/graph-repositories[/*]` |
| `GRAPH_TICKED_PARAM` | `graph-repository-schema` | `lib/desk-graph-repositories.ts` | same |
| `graphNodesPath` | `graph-repository-schema` | `lib/desk-graph-repositories.ts` | same |
| `parseGitlabRef` | `graph-repository-schema` | `desk-graph-repositories.tsx` | same (the route validates the ref; the UI pre-checks it) |
| `GRAPH_SURFACES_DESTINATIONS` | `graph-surface-schema` | `lib/desk-graph-surfaces.ts` | `GET /api/desk/graph-surfaces/*` |
| `graphSurfaceNodePath` | `graph-surface-schema` | `lib/desk-graph-surfaces.ts` | same |
| `RoutineResultSchema` | `routine-action-contract` | routine lifecycle, schedule and delete; `lib/desk-capability-install.ts` | `/api/desk/routines`, `/routine-lifecycle`, `/routine-schedule`, `/routine-removal` |
| `CapabilityBuildResultSchema` | `routine-capability-contract` | `lib/desk-ask.ts` | `POST /api/desk/routine-capability` |
| `RoutineDisplayPageSchema` | `routine-display-contract` | `lib/routine-display.ts` | `/api/desk/routine-display` |
| `RoutineDisplayResultSchema` | `routine-display-contract` | `lib/routine-display.ts` | same |
| `RoutineDetailSchema` | `routine-editor-contract` | `desk-routine-editor.tsx`, `desk-routine-detail.tsx` | `/api/desk/routine-editor` |
| `RoutineInventorySchema` | `routine-editor-contract` | `desk-routine-editor.tsx` | same |
| `parameterError` | `routine-editor-contract` | `desk-routine-detail.tsx` | same (the route rejects with the same check; the UI pre-checks) |
| `RoutineEvidencePageSchema` | `routine-evidence-contract` | `lib/routine-evidence.ts`, `lib/routine-attention.ts` | `GET /api/desk/routine-history` |
| `RoutineLogPageSchema` | `routine-evidence-contract` | `lib/routine-evidence.ts` | `GET /api/desk/routine-log` |
| `LifecycleDetailSchema` | `routine-lifecycle-contract` | `desk-routine-lifecycle.tsx` | `/api/desk/routine-lifecycle` |
| `LifecyclePreviewSchema` | `routine-lifecycle-contract` | `desk-routine-lifecycle.tsx` | same |
| `createRoutineOccurrencePageSchema` | `routine-occurrence-contract` | `lib/routine-calendar.ts` | `GET /api/desk/routine-occurrences` |
| `RemovalDetailSchema` | `routine-removal-contract` | `desk-routine-delete.tsx` | `/api/desk/routine-removal` |
| `ScheduleDetailSchema` | `routine-schedule-contract` | `desk-routine-schedule.tsx` | `/api/desk/routine-schedule` |
| `SchedulePreviewSchema` | `routine-schedule-contract` | `desk-routine-schedule.tsx` | same |
| `relatesContext` | `studio/relates` | `desk-studio.tsx` | `GET /api/desk/studio/relations` (the Desk computes it in-process instead) |
| `NO_CONTEXT` | `studio/relates` | `desk-studio.tsx` | same |
| `StudioSessionSchema` | `studio/session-schema` | `desk-studio-session.tsx` | `POST /api/desk/studio/session` |
| `SessionRequestSchema` | `studio/session-schema` | `desk-studio-session.tsx` | same |
| `SessionEndSchema` | `studio/session-schema` | `desk-studio-session.tsx` | same |

## 2. Presentation that belongs in the external UI (31)

None of these derives state that a second client must reproduce exactly. They are wording, formatting, filters over served data and React keys.

| Symbol | Module (`desk/…`) | Desk importer | Note |
|---|---|---|---|
| `ALL_AREAS` | `present` | `desk-view.tsx`, `desk-time-first.tsx` | area filter sentinel |
| `URGENCY_LABEL` | `present` | `desk-view.tsx` | label |
| `briefing` | `present` | `desk-view.tsx` | greeting and briefing lines over `DeskView` |
| `spokenBriefing` | `present` | `desk-view.tsx` | spoken form of the same |
| `isBriefingRequest` | `present` | `desk-view.tsx` | decides whether typed text asks for a briefing |
| `selectItems` | `present` | `desk-view.tsx` | area and snooze filter over `DeskView.items` |
| `canSee` | `present` | `desk-view.tsx` | empty-view check |
| `clock` | `present` (re-export of `time`) | `desk-view.tsx` | `HH:MM` |
| `clock` | `time` | `desk-proposal.tsx` | `HH:MM` (also used by the backend) |
| `DAY_MS` | `time` | `desk-view.tsx` | constant |
| `startOfDay` | `time` | `desk-view.tsx`, `desk-studio.tsx` | date helper |
| `proposalTime` | `ask` | `desk-view.tsx`, `desk-proposal.tsx` | parses a proposal's time fields for display |
| `balanceDetails` | `balance-command` | `desk-task-details.tsx` | pre-fills the edit form from an outline node served by `/api/desk/my-day` |
| `calendarKey` | `calendars` | `desk-calendar-settings.tsx` | used only as a React list key |
| `snoozeWhen` | `mail-snooze-schema` | `desk-mail-snooze.tsx` | "tomorrow at 08:00" wording |
| `rangerAttention` | `rank` | `desk-catch-up.tsx` | folds ranger decisions beyond a limit into groups |
| `ROUTINE_BACKGROUND_THRESHOLD` | `routine-display-contract` | `desk-routine-display.tsx`, `desk-routine-calendar.tsx` | quoted in the explanation text; the page already carries the resolved mode |
| `RULING_FALLBACK` | `ruling` | `desk-ruling.tsx` | fallback sentence; the route returns it as `line` when it cannot explain |
| `clip` | `studio/board` | `desk-studio.tsx`, `desk-studio-acts.tsx`, `desk-studio-thread.tsx` | text shortening |
| `plainQuestion` | `studio/board` | `desk-studio.tsx`, `desk-studio-thread.tsx` | strips trailing punctuation |
| `MONTHS` | `studio/labels` | `desk-studio-parts.tsx` | label |
| `TYPE_LABEL` | `studio/labels` | `desk-studio.tsx` | label |
| `YES_ANSWERS` | `studio/labels` | `desk-studio-acts.tsx` | label |
| `dayMonth` | `studio/labels` | `desk-studio.tsx`, `desk-studio-thread.tsx` | date format |
| `localDate` | `studio/labels` | `desk-studio-thread.tsx` | date format |
| `outcomeLabel` | `studio/labels` | `desk-studio.tsx` | label |
| `relationCount` | `studio/relates` | `desk-studio-thread.tsx` | counts a served `Relations` |
| `draftWasRecorded` | `studio/session-draft` | `desk-studio-session.tsx` | compares a draft with the served session |
| `projectContext` | `time-first` | `desk-time-first.tsx` | nearest ancestor note in the served outline |
| `reorderVisible` | `time-first` | `desk-time-first.tsx` | list reorder before posting the order to `/api/desk/my-day` |
| `freshnessLabel` | `types` | `desk-catch-up.tsx`, `desk-view.tsx` | label for the served `freshness` |

## 3. Backend behaviour with no route: gap candidates (23)

### 3a. Derived-state rules (11)

Each rule turns served data into state that any client would have to reproduce exactly. No route returns the result.

| Symbol | Module (`desk/…`) | Desk importer | What no route serves |
|---|---|---|---|
| `buildBoard` | `studio/board` | `desk-studio.tsx` | The Studio board: which place an inbox capture or proposal lands in (free-place resolution), threads that share material (`sharedPairs`), `waitsOnYou` per thread, and which threads were "thought about" in the look window. `GET /api/desk/studio` serves only the raw `StudioView`. |
| `buildThreadPage` | `studio/page` | `desk-studio.tsx` | Partly served: `personas` and `thinking` come on `/api/desk/studio`, and `relations` and `proposed` come on `/api/desk/studio/relations`. Not served: `waitsOnYou`, `needsResponse` (`studio/response.ts`), material shared with other threads (`also`), the outcome block, and the place line. |
| `nextTask` | `time-first` | `desk-time-first.tsx` | Which task to do in the current calendar gap: the eligibility, deferral and estimate-fits rules. |
| `currentGap` | `calendar-availability` | `desk-time-first.tsx` | The current calendar gap (busy, bounded, open or unknown). The backend computes it for the meeting hold (`interrupt.ts`), but `GET /api/desk` serves only the raw `calendarAvailability`. |
| `balanceDestinations` | `balance-destinations` (from `src/balance`) | `desk-balance.tsx`, `desk-time-first.tsx`, `desk-conversation-destination.tsx` | The list of filing destinations derived from the outline. The backend uses the same rule (`balance-conversation-writer.ts`, `conversations/domain-adapters/balance/task-binding.ts`). |
| `areaProjects` | `balance-destinations` | `desk-conversation-destination.tsx` | Projects per area. Same backend users. |
| `resolveBalanceProject` | `balance-destinations` | `desk-conversation-destination.tsx` | Resolves a project by id or unique title. The server applies the same rule, and the client must match it. |
| `snoozeAt` | `mail-snooze-schema` | `desk-mail-snooze.tsx` | The time the server will pick for a snooze choice. The UI previews it; `mail-snooze.ts` computes it again on the action. |
| `buildDisplayEntry` | `routine-display-contract` | `lib/routine-display.ts` | The resolved display entry after a change. `POST /api/desk/routine-display` returns only `{routineId, mode}`, so the client recomputes it. |
| `displayEntry` | `routine-display-contract` | `lib/routine-display.ts`, `desk-routine-editor.tsx` | Same. |
| `parserRoutingNotice` | `parser-routing` | `desk-proposal.tsx` | The text explaining which model answered. `POST /api/desk/ask` returns it only on failure; on success it returns `routing`, and the client writes the sentence. |

### 3b. Input vocabularies (12)

Each is an enum, limit or key format that the server validates, but no route publishes. Publishing these in the versioned contract would close the gap without a new route.

| Symbol | Module (`desk/…`) | Desk importer | Used by route |
|---|---|---|---|
| `ADAPTER_CAPABILITY_ACTION` | `adapter-actions` | `desk-view.tsx` | action id prefix on `DeskItem.actions`; `POST /api/desk/adapter` |
| `STUDIO_RESPOND_ACTION` | `adapter-actions` | `desk-view.tsx` | action id on items; opens Studio |
| `FIELD_SCHEMAS` | `ask` | `desk-view.tsx` | card field schemas for `POST /api/desk/create` |
| `handoffKey` | `handoff` | `desk-mail-handoff.tsx` | item key format of a hand-off |
| `CORRECTION_MOVES` | `mail-correction-schema` | `desk-view.tsx` | which corrections move the mail; `POST /api/desk/action` |
| `MAX_INSTRUCTION` | `mail-handoff-schema` | `desk-mail-handoff.tsx` | instruction length limit |
| `RULE_ACTIONS` | `mail-rules-schema` | `desk-mail-rules.tsx` | `POST /api/desk/mail/rules` |
| `RULE_MATCHES` | `mail-rules-schema` | `desk-mail-rules.tsx` | same |
| `SNOOZE_TIMES` | `mail-snooze-schema` | `desk-mail-snooze.tsx` | snooze choices for `POST /api/desk/action` |
| `SWEEP_WORDS` | `mail-sweep-schema` | `desk-mail-sweeps.tsx` | sweep names for `POST /api/desk/action` |
| `WAITING_OPS` | `mail-waiting-schema` | `desk-view.tsx` | `waiting.*` action ids |
| `DESK_ITEM_KINDS` | `types` | `desk-catch-up.tsx`, `lib/catchup-filters.ts` | item kinds in `GET /api/desk` |

## 4. Used only by Mission Control views that are not the Desk (0 runtime)

None. The 35 files reachable only from the other views import types only: 37 symbols from the 14 `api/` modules named in the summary.

## 5. Imported by code the running Desk never mounts (14)

`lib/desk-adapter-frame.ts` imports these 14 symbols. Its only importer is `components/desk-adapter-frame.tsx`, which nothing in production imports (F1).

- From `adapter-frame-contract`: `DESK_ADAPTER_FRAMES_PATH`, `FrameOpenReplySchema`, `FrameReplySchema` and `frameEntryUrl`.
- From `adapter-frame-protocol`: `DESK_UI_HANDSHAKE_MS`, `DESK_UI_MAX_MESSAGE_BYTES`, `DESK_UI_WIRE_VERSION`, `HostMessageSchema`, `InboundGate`, `InitSchema`, `identityOf`, `newInstance`, `sameIdentity` and `withinWireBounds`.

The routes behind them exist: `/api/desk/adapters/frames[/*]` and `/api/desk/adapters/assets/*`.

## Routes no external client calls today

"External" means every caller except the bundled Desk. The external callers found are:

- **Threva** calls these routes:
  - `/api/desk`, `/api/desk/action`, `/ask`, `/capture/undo`, `/create`, `/interruptions/feedback`, `/mail`, `/mail/rules`, `/my-day`, `/outline/ask`, `/ruling`, `/studio`, `/studio/act` and `/studio/session`.
  - `/api/conversations/asks`, `/source`, `/starts`, `GET /{id}`, `GET /{id}/entries`, and `POST /{id}`, which is refused (F2).
- **`src/cli/studio-overseer.ts`** calls `GET /api/desk` and `GET /api/desk/studio`.
- **`src/conversations/links.ts` and `tools/conversation-history.ts`** only format `/api/conversations/{id}/entries/{n}` as citation strings; they never fetch them.

Routes no external client calls:

### `/api/desk*`

| Route | Desk calls it? |
|---|---|
| `/api/desk/plan` | yes |
| `/api/desk/adapter` | yes |
| `/api/desk/autonomy` | yes |
| `/api/desk/calendars` | yes |
| `/api/desk/vips`, `/api/desk/unimportant` | yes |
| `/api/desk/graph-surfaces/*` | yes |
| `/api/desk/balance-surfaces/*` | yes |
| `/api/desk/graph-repositories[/*]` | yes |
| `/api/desk/task-handoff` | **no** |
| `/api/desk/links` | **no** |
| `/api/desk/mail/dmarc` | yes |
| `/api/desk/corrections` | yes |
| `/api/desk/interruptions` (GET, POST) | **no** |
| `/api/desk/routines` | yes |
| `/api/desk/routine-capability` | yes |
| `/api/desk/routine-history`, `/routine-log` | yes |
| `/api/desk/routine-occurrences` | yes |
| `/api/desk/routine-display` | yes |
| `/api/desk/routine-editor` | yes |
| `/api/desk/routine-removal` | yes |
| `/api/desk/routine-lifecycle` | yes |
| `/api/desk/routine-schedule` | yes |
| `/api/desk/voice/speak`, `/voice/transcribe` | yes |
| `/api/desk/notes/done` | yes |
| `/api/desk/goal` | yes |
| `/api/desk/studio/relations` | **no** (F4) |
| `/api/desk/drafts[/*]` | yes |
| `/api/desk/balance/read` | **no** (none found in cortex, the Desk, Threva or the adapters checkout) |
| `/api/desk/connections[/*]` | yes |
| `/api/desk/adapters/frames[/*]`, `/api/desk/adapters/assets/*` | only the unmounted host (F1) |
| `/api/desk/flows[/*]`, `/api/desk/flows/card` | yes |

### `/api/conversations*`

| Route | Desk calls it? |
|---|---|
| `GET` and `POST /api/conversations` | yes |
| `/api/conversations/overview` | yes |
| `/api/conversations/imports` | yes |
| `/api/conversations/discord/check` | **no** |
| `/api/conversations/capabilities` | yes |
| `/api/conversations/grants`, `DELETE /grants/{id}` | yes (DELETE) |
| `PATCH /{id}` | yes |
| `GET /{id}/stream` | yes |
| `POST /{id}/links` | **no** |
| `/{id}/discord` (GET, POST) | POST only |
| `PUT /{id}/draft` | yes |
| `POST /{id}/outcome` | yes |
| `GET /{id}/entries/{n}` | cited, never fetched |
| `POST /{id}/attachments` | **no** |
| `POST /{id}/inputs` and `GET /{id}/inputs/{key}` | yes (POST) |
| `/{id}/proposals[/{pid}[/confirm\|check]]` | yes |

"**no**" means no string reference in production `dashboard-v2`.
