# Meeting evidence without a model

`POST /api/desk/meeting-brief` accepts only `{ "event": "cal:source:event", "refresh": true }`; `refresh` is optional. The event is an opaque key from the current Desk calendar source. `GET /api/desk/meeting-brief?event=...` reads a prepared resource. Both methods require the existing MC Host, Origin and principal identity gates.

Every request rereads configured sources and linked built-in material. Facts include the source's excerpt or link; saved link titles are never evidence. New Mail link snapshots retain the source connection; reads require that connection and the recorded account. Legacy links without a recorded connection fail closed until relinked; a newly configured connection cannot inherit them. Built-in Balance, Studio and Desk notes identify their owner with `adapter: null`. Configured calendar/Mail commands identify their built-in `SourceCache` command owner as `desk-source-command`, with `adapter: null`; this is an evidence-owner classification, not a registered adapter. Balance uses its existing structured owner authorization check: a task whose area is no longer configured is an `access-denied` gap. Task evidence quotes only an available current leaf task from that shared owner read; gone, wrong-kind and unavailable reads become redacted gaps, never facts from a day projection. Command source failures have no structured denial signal and remain `read-failed`; their private error text is never classified or exposed. The evidence never waits for a model. `previousMeeting` follows the explicit relationship below, and is `unidentified` without one; `synthesis` is described under Cited summary, and is `unavailable` with `reason: not-configured` when no model lane exists.

Revisions include the meeting, its source configuration and connection, linked evidence content and coverage. A changed or failed source causes GET to return `409 refresh-required` without the prepared facts; prepare again to receive current evidence and named gaps. An unavailable or gone meeting returns 404. Source failures never expose private error details. Responses contain `Cache-Control: no-store`.

The new endpoint-scoped [v1 examples](examples/meeting-brief-v1.json) pin successful preparation and malformed, stale and gone failures. They are exercised through the real authenticated HTTP route by `bun scripts/probe-desk-meeting-brief.ts` and its test. Only the opaque revision and preparation timestamp are normalized when comparing a successful example. This fixture version is an example-pinning convention introduced for this endpoint; it does not add an API-wide handshake, response header or SDK version. The map's planned API-wide compatibility mechanism remains separate work.

The probe uses a temporary database, synthetic calendar/Mail command and explicit task/note/Mail links, with no model or production credentials. It reads the brief, verifies identity/Origin/Host refusals, removes Mail, verifies the stale conflict, refreshes to a named Mail gap, then verifies wrong-kind and gone task gaps, restores a readable task control, and removes the meeting to verify 404. All temporary resources are removed when it finishes.


## Previous meeting

`POST /api/desk/meeting-brief/previous` accepts only `{ "event": "cal:source:event", "previousEvent": "cal:source:event" | null }` and sets or clears an explicit relationship in the Desk database (`desk_meeting_previous`). Both keys are resolved through the configured calendar sources; the caller supplies no meeting description. Setting is idempotent and returns `{ ok, event, previousEvent, relation: "explicit" | null, message, messagePhrase }`. Bad input is 400, a current meeting the Desk no longer sees is 404, and a self-link, a predecessor that does not start before the meeting, or a predecessor the sources cannot read is 409. Clearing needs only the current meeting. Stored identities are the connection-scoped event keys plus the connection that resolved each one, so equal titles or ids on another connection never match. A relation to another calendar is allowed because the explicit write validates it.

The brief's `previousMeeting` is `identified` with `event`, `relation: "explicit"`, and its own `facts` and `gaps` when the predecessor is readable; `unavailable` with a redacted phrase when it is not (never replaced by a guess); and `unidentified` ("No previous meeting identified.") with no relation. Material is read from the predecessor's stored meeting links, not through today's cutoff, so it stays eligible after its date passes. Unlinked material stays out, source content is read under current policy, and unreadable or gone material is a gap. Setting or clearing a relation, or losing access to the predecessor or its material, changes the brief revision, so a cached brief answers `409 refresh-required` until prepared again.

The source reader supplies no trustworthy series identity or occurrence chronology (an event has an id and a calendar id, and the Mail `recurring` flag is not a series), so nothing is inferred; a meeting stays unidentified until the relation is set. The adapter SDK is unchanged. [Pinned examples](examples/meeting-brief-previous-v1.json) run through the real routes with `bun scripts/probe-desk-meeting-brief-previous.ts`.


## Cited summary

`POST /api/desk/meeting-brief` always answers with the evidence first, whatever the model does. When a policy-permitted model lane exists, the response carries `synthesis.state: "preparing"` with a `generation` id and a background job prepares the summary; `GET` reads the current brief and starts no model work, so a client polls it. `refresh: true` rereads the evidence and always starts a new generation.

| `synthesis.state` | Carries |
|---|---|
| `preparing` | `generation`, `startedAt` |
| `ready` | `generation`, `completedAt` (separate from the brief's `preparedAt`), `claims[]` of `{ text, references }` |
| `unavailable` | `reason`: `not-configured`, `no-local-model`, `no-evidence` or `not-prepared`; no model was called |
| `failed` | `reason`: `model-failed`, `invalid-output` or `interrupted`; `generation`, `failedAt`; a later `POST` retries |

Every state has a `phrase` (`brief.synthesis-*` codes in the DeskPhrase vocabulary) and a `message`. A failure carries no model or provider text.

`references` are ids of facts in the same brief, from the current or the previous meeting. The model receives exactly those facts, and the answer is validated against them: an unknown, empty or foreign reference, an empty claim list or an answer that is not the expected shape fails the whole summary as `invalid-output`. Gaps and unidentified previous meetings are never sent to the model.

**Lane.** The lane is the Studio filer, the same conversation lane `outline/ask` uses. A fact is local unless its source is in a cloud-policy area: Mail by its connection's area, a task by its area, a Studio thread by its policy; a Desk note is always local. If any fact in the brief, current or previous meeting, is local, only `filer.local` may be used, and only when it is not a cloud route. Otherwise the cloud filer is used. With no permitted lane the brief is `unavailable` and no model is called; the cloud lane is never a fallback for local content.

**Cache.** A completed summary is reused while the evidence revision, the local/cloud classification of its facts and the selected model are unchanged. The key is rechecked on every read: a changed or revoked source answers `409 refresh-required` without any claims, and a removed or changed lane hides the stored summary as `unavailable`. Identical requests share one in-flight call. A result applies only if its generation is still the current one, so a late older result never replaces a refreshed one. A `preparing` generation with no live worker in this process (for example after a restart) is reported as `failed` with reason `interrupted` rather than staying `preparing`.

Contract version 1.2.0 adds the `brief.synthesis-*` phrase codes and the `BRIEF_SYNTHESIS_*` vocabularies.
