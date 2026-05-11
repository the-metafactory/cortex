# Hardening Sprint Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-hardening-sprint.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan tracks the hardening sprint work. The sprint ships when all P0 and P1 items are complete.

**Mission:** Every agent event reliably reaches the dashboard. Failures are visible, not silent.
**Scope:** Pipeline reliability, error observability, session context, event delivery integrity
**Design Spec:** `docs/design-hardening-sprint.md`
**Research:** Issue [#90](https://github.com/the-metafactory/grove/issues/90) — brittleness analysis
**Tracking Issue:** [#104](https://github.com/the-metafactory/grove/issues/104)

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## P0 — Stop the Bleeding

### Explicit Metadata Through Spawn Boundary

- [x] Add GROVE_PROJECT, GROVE_ENTITY, GROVE_OPERATOR env vars to CCSession.start()
- [x] EventLogger reads new env vars and includes in event payload
- [x] Dashboard uses explicit metadata instead of regex detection
- [x] Delete regex-based project detection code (kept as fallback — explicit metadata takes priority)

### Pipeline Health Indicator

- [x] Add GET /api/pipeline/health endpoint (relay PID, last event time, event count)
- [x] Dashboard shows green/yellow/red pipeline health indicator
- [x] Health indicator visible on mobile layout

### Error Logging in Non-Hook Code

- [x] Audit all empty catch {} blocks in non-hook code
- [x] Replace with actual error logging (usage-monitor.ts, dashboard-api.ts, cloud-publisher.ts)
- [x] Preserve empty catch ONLY in EventLogger.hook.ts (correct there)

### Acceptance (P0)

- [x] Session metadata appears on dashboard cards without regex
- [x] Pipeline health indicator works and reflects actual relay state
- [x] Errors in relay/bot/cloud are logged, not swallowed

---

## P1 — Reliability

### HTTP POST Ingestion

- [x] Add POST /api/events/ingest endpoint on dashboard-api.ts
- [x] EventLogger.hook.ts POSTs events to localhost:8766 first
- [x] Fallback to JSONL appendFileSync if POST fails
- [x] Bot processes HTTP-ingested events (bypass file watcher for direct events)

### Heartbeat and Stale Eviction

- [x] Emit agent.session.heartbeat on UserPromptSubmit hook
- [x] Increase stale session threshold from 10 to 20 minutes
- [x] Dashboard correctly shows long-running sessions as active

### Acceptance (P1)

- [x] Events delivered via HTTP POST appear on dashboard within 1 second
- [x] JSONL fallback works when bot is not running
- [x] Long Algorithm runs (>10 min) not marked as completed

---

## P2 — Persistence & Observability (💪 stretch)

### SQLite Event Store

- [ ] Create events table schema
- [ ] Persist events to SQLite on ingestion
- [ ] Query SQLite for dedup instead of in-memory sets
- [ ] Dashboard state survives process restart without full JSONL replay

### Relay Allow List Expansion

- [ ] Add tool.file.read to relay-policy.yaml
- [ ] Add tool.search.used to relay-policy.yaml
- [ ] Dashboard shows "agent actively searching" activity

### Event Drop Counter

- [ ] Count filtered events in policy engine
- [ ] Expose drop count via /api/pipeline/health
- [ ] Dashboard health indicator includes event throughput stats

---

## P3 — Schema Hygiene (💪 stretch)

### UniversalEvent Validation

- [ ] Define runtime schema validation for event ingestion
- [ ] Reject malformed events with error log
- [ ] Validation errors visible in pipeline health

### OTel Field Naming

- [ ] Map event fields to OTel GenAI semantic conventions
- [ ] Alias gen_ai.agent.name, gen_ai.usage.input_tokens, etc.
- [ ] Existing consumers unaffected (backwards compatible aliases)

---

## Sprint Exit Criteria

- [x] All P0 checkboxes complete
- [x] All P1 checkboxes complete
- [ ] No regressions in Discord worklog or dashboard
- [ ] Pipeline health shows green
- [ ] Version bumped and GitHub release created
