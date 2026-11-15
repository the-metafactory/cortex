# Desk decisions list

`GET /api/desk` carries an additive `decisions` array: the rulings and Ranger approvals, retries and `ranger.run-now` calls the principal gave today. It is separate from `autonomy.done` and has no cap.

- **Today** is the current calendar day in the stack's time zone (the `timeZone` field of the view), newest first, ties broken by `id`.
- **Retention** is 90 elapsed days from `decidedAt`, in the stack's Desk SQLite database (`desk_decisions`). Older entries are pruned on every record and every read.
- **Entry**: `id` (stable, derived from the request id or the versioned action identity), `key` (the item key), `title` (snapshot from the authoritative subject), `target {repo, nodeId, link}`, `action` (`ranger.rule`, `ranger.approve`, `ranger.retry`, `ranger.run-now`), `text` (the ruling, else `null`), `decidedAt`, `outcome {state, detail, at}`, `withdrawable` (always `false`) and `supersededBy {id, decidedAt}` (or `null`).
- **Outcome states**: `not-requested` (a ruling that triggers no Ranger call, such as a Vigil escalation), `pending` (the ruling is saved and the resume is unknown), `accepted` (Ranger's CLI accepted the call), `queued` (Ranger queued the resume), `failed`. `accepted` never means a worker started or finished.
- **Recorded when** the graph accepts a ruling (`POST /api/desk/ruling`) or Ranger accepts an action (`POST /api/desk/action`). Invalid, denied or refused requests are not listed. A repeat of the same ruling request or versioned action keeps the original `id`, text and timestamp and only moves the outcome; a failed repeat never downgrades `accepted` or `queued`.
- **Superseding**: a later ruling on the same target marks earlier ones with `supersededBy`. Nothing is withdrawn or rewritten, and there is no Undo.
