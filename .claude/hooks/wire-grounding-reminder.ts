#!/usr/bin/env bun
// PreToolUse (Edit|Write) — emit a one-line reminder naming the governing myelin
// RFC for a wire-implementing path (src/bus/**). Non-blocking by contract: it
// prints additional context and always exits 0. It NEVER calls the bus, the
// network, or blocks the edit (CLAUDE.md: hooks must stay non-blocking).
//
// Standard: compass/standards/domain-grounding.md §4. The dir-scoped
// src/bus/CLAUDE.md loads when a file is opened; this hook fires when it is
// edited — the last cheap moment to name the RFC before a wire change lands.
// Routing table of record: repo-root CLAUDE.md `wire_grounding` slot
// (docs/agents-md/wire-grounding.md).
const RULES: Array<{ glob: RegExp; rfc: string }> = [
  {
    // Subject grammar / envelope / signing are the highest-churn bus surfaces.
    glob: /(^|\/)src\/bus\/myelin\//,
    rfc: "the-metafactory/myelin specs/rfc/rfc-0002-subject-namespace.md, rfc-0003-envelope.md, rfc-0004-envelope-signing.md — the vendored myelin schema is normative; import from @the-metafactory/myelin, don't hand-copy (cortex#2034)",
  },
  {
    glob: /(^|\/)src\/bus\//,
    rfc: "the-metafactory/myelin specs/rfc/ — rfc-0001 (identity/signed_by), rfc-0002 (subjects/deriveNatsSubject), rfc-0003/0004 (envelope + signing), rfc-0005 (sovereignty/federated.*), rfc-0006 (admission), rfc-0007 (transport), rfc-0008 (capability discovery), rfc-0010 (refusal). The grammar is normative for this tree",
  },
];

const input = JSON.parse(await Bun.stdin.text());
const path: string = input?.tool_input?.file_path ?? "";
const hit = RULES.find((r) => r.glob.test(path));
if (hit) {
  // Surface as additional context on the tool call; do not block.
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `Wire-grounding: editing ${path} — governed by ${hit.rfc}. Read the RFC before changing wire behavior.`,
      },
    }),
  );
}
process.exit(0); // always non-blocking
