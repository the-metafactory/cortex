# Image input (paste + drag-drop) — pre-implementation addendum

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-image-input.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §6.2 (Image and screenshot support).
**Relationship to prior work:** F-10 (`docs/design-mc-f10-operator-input.md`) explicitly deferred images per its Decision 1. This addendum picks that up.
**Date:** 2026-04-25.
**Status:** Decided. Resolves the open questions enumerated below before image-input implementation begins.

## Why this addendum

§6.2 is four bullets: paste / drag-drop / base64 data URLs / embedded in stream-json via Maestro's `buildStreamJsonMessage` helper. F-10's Decision 1 deferred images because landing them correctly requires three coordinated changes:

1. A stream-json message-framing extension. Current `src/mission-control/session/stream-json.ts` is a nine-line text-only helper; Maestro's equivalent produces rich content-block arrays with both `text` and `image` blocks.
2. An event-renderer extension. F-7's attention view renders `stream-json.assistant` and `stream-json.user` events by expanding `content[]` at render time per F-7 Decision 4. The expander today handles `text`, `thinking`, `tool_use`, `tool_result` — not `image`.
3. A sizing policy. Base64 inflates event-table payloads ~33%; a handful of casual screenshots (~1 MB each) in a chat session balloon the session's event rows fast. The cap shape and storage strategy must be decided once rather than iterated under production pressure.

F-6 / F-7 / F-8 / F-9 / F-10 all shipped with addenda that resolve exactly this kind of cluster before code. Image input gets the same discipline.

**Feature-id naming.** Kept consistent with the iteration plan: there is no "F-10b" sub-letter convention. The iteration tracker bullet is already *"Image/screenshot paste + drag-drop (§6.2) — deferred from F-10, follow-up PR once stream-json content-blocks + event-renderer image support land in lockstep"*. That bullet is the one this addendum's PR ticks.

## Decision 1 — Scope: paste AND drag-drop ship together

Maestro ships both. F-10 operators expect both. Shipping only paste leaves screenshot-from-file workflows stranded (quick Finder drag, screenshot to desktop → drag); shipping only drag-drop leaves copy-from-another-app workflows stranded (⌘-shift-4-then-⌘-V muscle memory). The delta in complexity between them is small — both end at the same "here's a Blob, base64-encode it, send" path — and splitting creates a confusing partial-availability UX.

**In scope:**
- Paste from clipboard (ClipboardEvent on the drill-down textarea).
- Drag-drop onto the drill-down input area.
- Both attach to the *next* text message, rendered as thumbnail chips above the textarea.

**Out of scope:**
- File picker button (explicit "Attach" button). Can add later; not idiomatic for Maestro, not in the v1 `§6.2` bullet list.
- Image-only messages (no accompanying text). The stream-json frame accepts a content-array; we accept it if the operator submits with no text but at least one image. UI allows this — no friction required for what is a one-line JS guard.
- Pre-send image editing (crop, annotate). Post-v2.

## Decision 2 — Wire format: `buildStreamJsonMessage` is extended to accept rich content arrays

Today:

```ts
export function buildStreamJsonMessage(text: string): string {
  const msg = JSON.stringify({ type: "user_message", content: text });
  return msg + "\n";
}
```

After:

```ts
export type StreamJsonContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export function buildStreamJsonMessage(
  input: string | StreamJsonContentBlock[]
): string {
  const content = typeof input === "string"
    ? [{ type: "text", text: input } as const]
    : input;
  const msg = JSON.stringify({ type: "user_message", content });
  return msg + "\n";
}
```

**Contract notes:**
- The string-argument overload remains so existing callers (`endpoint.write(body.text)` in `handlers.ts`) continue to work unchanged. This keeps the F-10 code path one line of backward-compatibility glue rather than a call-site-wide edit.
- Even a pure-text message now sends as `content: [{type: "text", ...}]` when routed through the rich overload. That's the shape CC's stream-json already expects — it was just cheaper to send `content: "..."` when we had no choice.
- `media_type` is restricted at the caller layer (Decision 5) but not at the framer — the framer is a dumb formatter.

**This is the Maestro pattern verbatim.** Re-inventing the shape would mean re-verifying what CC accepts. Decision made once in Maestro; replicate.

## Decision 3 — Storage: embedded base64 in the event payload. No separate blob store in v1.

**Chosen:** Images live inline in the `events.payload` JSON for `operator.input` events (the authoritative H-source for operator-sent turns; see Decision 4) and in the request body of `POST /api/assignments/:id/input` as raw base64 + `media_type`.

**Event-type canonicalisation.** The dashboard already suppresses the `stream-json.user` text-block path (`dashboard/index.html:1226–1228`: *"CC echo of operator input. Suppressed — operator.input event is the authoritative H-source; rendering this too duplicates."*). Images follow the same rule: the operator's outbound turn — text and images — is stored on `operator.input` and rendered from there. The stream-json echo of the same turn carries the image blocks over the wire to CC (Decision 2) but is **not** the canonical store and is **not** rendered. Decisions 4 and 7 align on `operator.input` as the single canonical event type for operator-sent images.

**Why embedded.** §6.2 says "No temp files, no upload-to-cloud step". At Phase C scale (single operator, one dashboard), embedding is operationally indistinguishable from the alternative. Introducing a blob store (CF R2, S3, filesystem) is a distinct project with its own cleanup, auth, and data-retention concerns. Punt it.

**Known cost.** A 5 MB PNG becomes ~7 MB of JSON. Event-table rows get large. A dashboard session of 30 screenshot-assisted turns is ~200 MB of SQLite. That is acceptable at current deployment (local SQLite, single operator) and **unacceptable** at Tier 2 multi-operator D1 scale. Revisit before Tier 2 — recorded here so a future reviewer can point at the decision rather than re-derive it.

**Pagination response size.** The existing `GET /api/assignments/:id/events` paginates with a default `limit=50`. With inline base64, half-image-bearing rows at ~6.7 MB apiece means the initial fetch page can carry up to ~170 MB over the HTTP boundary. SQLite's per-row ceiling (`SQLITE_MAX_LENGTH` default 1 GB) easily accommodates a single 5 MB image in a TEXT payload, but the aggregate page size is real memory for both server (JSON.stringify) and client (parse + render). The F-7 virtualised event log trims to `DRILL_MAX_EVENTS = 500` client-side, but the initial fetch is the hit. Not a blocker for v1 (single operator); noted so a follow-up can either cut pagination default for image-bearing sessions or strip payloads in list responses and hydrate per-event on demand.

**Retention stays coupled.** Images share the events table's retention policy (whatever we pick later — today there is no retention policy). If we add retention, images get purged with their session on the same schedule.

**No thumbnail generation in v1.** The browser renders the full base64 in the F-7 attention view's event log row (Decision 7 below). Downscaling is a later optimisation; v1 relies on the client-side size cap (Decision 5) to keep this reasonable.

## Decision 4 — API: extend `POST /api/assignments/:id/input` body; no new endpoint

Current body: `{ text: string }`.

New body (backward-compatible):

```ts
interface SendInputRequest {
  text?: string;
  images?: Array<{
    media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    // Raw base64, without the `data:image/png;base64,` prefix.
    data: string;
  }>;
}
```

- Either `text` or at least one image must be present; empty-body stays a 400 (existing behaviour).
- The handler validates `media_type` against the allowlist (Decision 5).
- Server-side size cap applies to the request body as a whole (Decision 6) — same 413 status code as the PR under review for text-only over-cap.
- On success, the handler builds a content-block array and passes it to `endpoint.write(...)` via the rich overload (Decision 2). `endpoint.write` signature grows a polymorphism (`string | StreamJsonContentBlock[]`); `resolveSessionEndpoint`'s implementation passes through to `buildStreamJsonMessage` unchanged.
- **Polymorphism propagates.** `resolveSessionEndpoint` (`src/mission-control/session/endpoint-resolver.ts`) returns an endpoint whose `write` wraps the framer, so the polymorphism lifts outward from `buildStreamJsonMessage` → `EndpointWrite` → `handleSendInput`. `handleCreateSession` (handlers.ts ~line 365) also calls `endpoint.write(body.prompt)` for the optional initial prompt — that call site inherits the polymorphic signature, but the initial-prompt field stays **request-scoped text only in v1**; seeding a spawn with an image is explicitly deferred (keeps the spawn path simple).

**Why not a new endpoint.** F-10 Decision 4 reused this endpoint. Images are additive to the same operator-input semantic. Two endpoints would fragment the contract for no gain.

**Operator input event payload is the canonical store** (see Decision 3). It gains an `images` field in parallel:

```ts
// events.payload when type === 'operator.input'
{
  text?: string;
  images?: Array<{ media_type: string; data: string }>;
}
```

Same shape as the request. Stored in the same event row (no N:1 explosion into a dedicated table).

## Decision 5 — Size caps and allowlist

**Per-image cap:** 5 MB decoded. `media_type` allowlist: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. PDFs, SVGs, and TIFFs are rejected in the UI *and* server-side.

**SVG/PDF exclusion rationale — three points pinned so future reviewers don't relitigate:**

(a) **Render-context scope.** The risk isn't the `<img src="data:image/svg+xml;base64,...">` element itself — modern browsers treat that as a sandboxed image context (no script, no external fetch). The risk is *any* future code path that renders SVG inline via `innerHTML` (e.g., a lightbox thumbnail template, a custom preview tooltip). Excluding SVG upstream at the allowlist means the dashboard is never one innocent-looking template change away from a stored-XSS primitive.

(b) **PDF embedded JavaScript.** PDFs carry JS-capable object streams and external references; browsers render them via plugin-style contexts that historically leak. Not a format we want in an operator-trusted attention view.

(c) **Base64 is not a sanitizer — it's an encoding.** Base64-encoding malicious bytes keeps the bytes intact; the allowlist is the defence, decoding doesn't validate anything. See the dedicated note below for the full treatment including GIF-polyglot handling.

**Per-message cap:** 8 images. An operator pasting 50 screenshots is almost always a mistake, not a workflow.

**Per-request body cap:** 25 MB. Sized against 5 × 5 MB + base64 overhead (~33%) + text + headroom. Applied as the `413 Payload Too Large` response. This sits alongside the 50 KB text-only cap — once the server-side text-length check lands (in-flight chore tracked alongside F-10; today `handleSendInput` in `src/mission-control/api/handlers.ts:400–402` only validates that `text` is a non-empty string), the text-only cap will be separately enforced on `text` alone, so the two caps coexist as two independent checks rather than one ambiguous "total bytes" limit.

**Cap enforcement layer.** Three boundaries, three places:

1. **Per-image 5 MB decoded.** Measured without fully decoding: compute `Math.floor(encoded.length * 3 / 4) - paddingBytes` from the base64 string and reject before decoding. This is a tight upper bound on decoded size; an operator submitting exactly 5 MB decoded passes, one submitting 5.1 MB is rejected with 413.
2. **Per-message 8 images.** Simple `images.length` check at the top of `handleSendInput`, before any decoding.
3. **Per-body 25 MB.** Enforced at the server layer's JSON body limit (upstream of `handleSendInput` — the handler receives an already-parsed body, per the `handlers.ts` header comment). The JSON parser itself rejects oversized bodies at the framing layer; `handleSendInput` does not need to re-check total bytes post-parse. A 25 MB decoded JSON object is a real memory cost, so the cap belongs as early in the pipeline as possible.

The per-image and per-message checks are cheap and run post-parse in the handler. The per-body cap runs pre-parse in the server layer.

**Base64 is not a sanitizer.** The allowlist + per-image cap is the defence; base64 decoding has no idea whether bytes are a valid PNG. The handler does not attempt to parse the image bytes to confirm they match `media_type` — that's a separate concern (MIME sniffing at the browser `<img>` rendering boundary). In particular, GIF-polyglot bytes that also parse as other formats are not a worry here because (a) the renderer is the browser's `<img>` element which enforces format by `media_type`, and (b) the dashboard never executes image bytes as script.

**Animated GIFs** are accepted (included in the allowlist) but capped at the same 5 MB ceiling. The frame loop renders as-is in the attention view.

**Client-side checks mirror server-side.** Oversized / wrong-type images are rejected at the paste/drop moment with an inline notice; the server-side checks remain the authority because the client-side is UX, not a security boundary.

## Decision 6 — Dashboard UX: thumbnail chips above the textarea; paste-into-textarea and drop-onto-drill-input

**Paste.** Pasting an image into the drill-down textarea:
1. Intercepts the clipboard event; if `clipboardData.items[i].kind === 'file'` AND `file.type` is in the allowlist, hold the file, don't let paste land as text.
2. Read the file as base64 (`FileReader.readAsDataURL`), strip the `data:...;base64,` prefix.
3. Append a thumbnail chip to the "staged images" row above the textarea.
4. If `file.type` is out of allowlist, do NOT block the paste (pasted text still lands normally); flash an inline notice "PNG/JPEG/WebP/GIF only".

**Drag-drop.** The entire `.drill-input` section becomes a drop zone when a drag-with-files enters it. On drop:
1. Files iterate through the same filter + read-and-chip pipeline.
2. Drop zone shows a visible "Drop image here" overlay during drag-hover.
3. Dropping on the textarea specifically works too (browser default behaviour); drag-drop onto the whole `.drill-input` is the broader target.

**Chip row.** Above the textarea, horizontal row:

```
[ img1.png ✕ ]  [ screenshot.jpg ✕ ]  [ paste-2026-04-25-104512.png ✕ ]
```

- Thumbnail is a 32 × 32 `<img>` with `object-fit: cover`.
- Filename: paste events get an auto-generated name (`paste-YYYY-MM-DD-HHMMSS.png`); drag-drop preserves the file's `name`.
- `✕` removes the chip from the staged list (pre-send only; once sent, images are in the event log and immutable).
- Hovering the chip expands a small preview (100-200 px).

**Submit.** When Send is pressed, the staged images are included in the `POST /input` body alongside `text`. On success, chips clear along with the textarea. On failure, chips (and text) are preserved for Retry.

**No paste-preview auto-prompt.** The current chip is the preview. No modal or additional confirmation dialogue.

## Decision 7 — Event renderer: F-7 attention view grows an `image` handler on `operator.input`

The F-7 `eventToRows()` function (docs/design-mc-f7-attention-view.md Decision 4) expands `content[]` into one rendered row per block on `stream-json.assistant` and only `tool_result` on `stream-json.user` — the `stream-json.user` `text` case is already suppressed because `operator.input` is the authoritative H-source (`dashboard/index.html:1226–1228`).

**Where the image case lands.** Since Decision 3 / Decision 4 make `operator.input` the canonical store for operator-sent images, the new rendering case belongs on the `operator.input` handler, **not** on `stream-json.user`. The existing `operator.input` branch today renders a single H-coloured row showing `ev.payload.text`; this addendum extends it to also emit one row per entry in `ev.payload.images[]` (thumbnail chip, identical visual treatment to pre-send chips). The `stream-json.user` suppression stays exactly as-is — no change there — so a single operator turn renders once, from `operator.input`.

**Rendering:**
- Inline `<img src="data:{media_type};base64,{data}">` with CSS `max-width: 320px; max-height: 240px; object-fit: contain`.
- Click-to-enlarge opens a modal lightbox (new UI primitive — small overlay, click-outside-closes, reuses F-7 drill-down close semantics).
- Below the image, the message text (if any) renders as the usual text-block row.

**Accessibility.**
- `alt` text is the filename (for operator-pasted chips, the auto-generated name; no user-level alt-text input in v1).
- `role="img"` on the outer chip div.

**Cost.** Rendering 5 MB base64 inline is fine for the message count F-7 deals with (virtualised to last-N events). If operators pile up dozens of screenshots per session, the drill-down's memory cap (`DRILL_MAX_EVENTS = 500`) caps the working set.

## Decision 8 — Observed sessions: image input disabled with the same UI gate as text

F-10 Decision 6 disables text input on `local.observed` sessions. Images inherit the same gate: paste events and drops onto the `.drill-input` are no-ops when `resolveDrillInputMode()` returns `"observed"` or `"ended"`. Existing readonly-textarea copy still explains why — no new string.

Server-side 409 remains authoritative.

## Decision 9 — Error UX: inline notices below the chip row + inline banner for send failures

Three failure points:
1. Paste/drop rejected client-side (wrong type, too big, too many). Inline hint line below the chip row, auto-clearing after ~3s. Reuses F-10's existing paste-notice pattern.
2. Server rejects oversized body (413). Triggers the F-10 inline error banner with the 413-specific copy: *"Attachments too large — total request body exceeds 25 MB."*
3. Server rejects unsupported media type (400). Banner copy: *"Attachment type not supported. Use PNG, JPEG, WebP, or GIF."*

**Implementation note — banner map grows.** F-10's `DRILL_INPUT_ERROR_COPY` map in `dashboard/index.html:2415` today only contains entries for 404 / 409 / 410 (F-10 addendum Decision 8's status-specific-copy set). 400 and 413 currently fall through to the generic `Send failed: ${serverMsg}` branch. This addendum's implementation explicitly extends the map with the two new entries above so 400 and 413 surface the Decision 9 copy rather than the generic fallback. The F-10 addendum Decision 8 pattern thus grows from {404, 409, 410, 5xx} to {400, 404, 409, 410, 413, 5xx}.

**Retry** on the inline banner: re-submits with the same text AND the same staged images (cached in a separate state slot since the textarea's optimistic clear already nukes `lastSentText`).

## Decision 10 — Tests: framing unit tests + end-to-end endpoint tests + renderer rendering tests

**Framing unit tests** (`__tests__/stream-json.test.ts` — new):
- `buildStreamJsonMessage("hello")` still returns the legacy shape (backward-compat).
- `buildStreamJsonMessage([{type:"text", text:"hello"}])` returns rich shape.
- `buildStreamJsonMessage([{type:"image", source:{...}}])` returns rich shape.
- Mixed blocks survive ordering.

**Endpoint tests** (extend `__tests__/api.test.ts` POST input block):
- 200 on text-only (existing).
- 200 on text + 1 image.
- 200 on image-only (text absent).
- 400 on empty body.
- 400 on `images[].media_type` outside allowlist.
- 400 on `images[].data` not valid base64 (malformed input — handler must reject cleanly, not crash on decode).
- 413 on a single image > 5 MB decoded (per-image cap — distinct from the body cap; an implementer enforcing only body-size would let a solitary 10 MB image through).
- 413 on > 25 MB combined body.
- 413 on `images.length > 8`.
- 409 on observed session with images present (belt-and-braces with Decision 8; server-side gate must reject writes regardless of payload shape).
- Operator-input event payload contains both text and images[] as submitted.

**Renderer tests** are dashboard-integration; matching F-7/F-8/F-9 precedent, rely on smoke + manual browser test. Not blocking.

## Scope summary — what this ships

- `src/mission-control/session/stream-json.ts` — extended to accept string or content-block array (Decision 2).
- `src/mission-control/api/handlers.ts` — request body accepts `images[]`; enforces media-type allowlist, per-image cap, per-message image count, per-body 25 MB cap (Decisions 4, 5).
- `src/mission-control/api/types.ts` — `SendInputRequest` shape extended.
- `src/mission-control/db/events.ts` — `createOperatorInputEvent` payload extended with `images`.
- Dashboard: `.drill-input` grows chip row + paste/drop handlers; staged-images state in `state.drillInput`; F-7 `eventToRows` grows the `image` content-block case + lightbox modal (Decisions 6, 7).
- Tests: framing unit, endpoint coverage (Decision 10).
- Forward-link from `docs/design-mission-control.md` §6.2 to this addendum.

## Scope summary — what this defers

- Blob storage (CF R2, filesystem) — stay embedded until Tier 2 forces a revisit (Decision 3).
- Server-side thumbnailing / downscaling — cap-based sizing plus browser `max-width` is enough for v1.
- File-picker "Attach" button — not in §6.2's bullet list, not Maestro's pattern (Decision 1).
- Image editing (crop, annotate) — post-v2.
- Alt-text input affordance — filename-as-alt is sufficient for v1 accessibility (Decision 7).

## Acceptance criteria

- [ ] Pasting a PNG/JPEG/WebP/GIF into the drill-down textarea stages a chip; other types show a rejection notice and do not stage.
- [ ] Dragging and dropping files onto the drill-down stages chips for allowlist types and notices-out unknown types.
- [ ] ✕ on a chip removes it from the staged list pre-send.
- [ ] Over 8 staged images: paste/drop rejected with notice "Maximum 8 images per message."
- [ ] Per-image > 5 MB: rejected with notice.
- [ ] Submit with text + images sends both; on success, chips clear alongside the textarea.
- [ ] Image-only submit (no text) sends successfully.
- [ ] 413 (oversized) and 400 (bad media_type) trigger the F-10 inline error banner with the Decision 9 copy.
- [ ] Observed / ended sessions do not accept paste or drop (gate reuses F-10's `resolveDrillInputMode`).
- [ ] The event log's `operator.input` row for a sent image renders the image inline (one row per `payload.images[]` entry), click-to-enlarge lightbox. The `stream-json.user` echo remains suppressed.
- [ ] `buildStreamJsonMessage` accepts both a string and a content-block array; legacy callers work unchanged.
- [ ] All existing tests still pass; new framing + endpoint tests ship green.

## Where this goes

- Framer: `src/mission-control/session/stream-json.ts` (extend) + `src/mission-control/__tests__/stream-json.test.ts` (new).
- API: `src/mission-control/api/handlers.ts`, `src/mission-control/api/types.ts`, `src/mission-control/db/events.ts`.
- Dashboard: `src/mission-control/dashboard/index.html` — chip row, paste/drop handlers, F-7 renderer image case, lightbox.
- Tests: `src/mission-control/__tests__/api.test.ts` extended.
- Forward-link from the main spec §6.2 added in the same PR that lands this addendum.
