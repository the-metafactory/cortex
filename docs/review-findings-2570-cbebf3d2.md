# Result route review dispositions

This record covers all 18 findings from Sage round 1 on [PR #2668](https://github.com/the-metafactory/cortex/pull/2668), reviewed at `cbebf3d2da376b784c44cbd94e7d12e5e71704fd`, for [Review findings left open by node #2570](https://github.com/the-metafactory/cortex/issues/2670). Locations below refer to that reviewed commit. The checkpoint is `review-findings-2570-cbebf3d2`.

The supervisor owns publication, review, merge and the close receipt. This record supplies each disposition; it does not attest that this branch has merged.

## Dispositions

| ID | Reviewed location and finding | Disposition and reason |
| --- | --- | --- |
| F1 | `src/vigil/result-render.ts:11`, dead `firstBodyLine` | Declined: `somaGoalWording` calls this helper, both at the reviewed commit and now. Its filesystem and containment imports are used. Removing it would break local goal wording. The results and stack-scope suites exercise the caller. |
| F2 | `src/surface/mc/server.ts:212`, cross-site GET resolves attention | Corrected here: after the existing loopback, method and rebind checks, the result/proposal route rejects a present `Sec-Fetch-Site` other than `same-origin` or `none`. Rejected requests cannot read the file or resolve attention. Requests without Fetch Metadata retain compatibility with existing clients. HTTP tests cover cross-site images/navigation, same-site requests, unknown/empty values, allowed values and existing headerless access. |
| F3 | `src/vigil/result-read.ts:7`, Mission Control persistence dependency | Declined: [PR #2673](https://github.com/the-metafactory/cortex/pull/2673), commit `c0d9aaf7`, replaced direct attention writes and result-specific replay with the shared Vigil resolution module. That module still uses Mission Control persistence, as do the other Vigil attention lifecycle operations. Injecting a callback for this one caller adds an interface with one implementation while retaining the shared module's schema dependency. Moving persistence into a neutral module would require a broader lifecycle/replay refactor. Retain the existing atomic attention/outbox transaction for this result-route change. |
| F4 | `src/surface/mc/results.ts:50`, publication blocks the page | Corrected here: `readResult` commits the attention/outbox transaction synchronously and starts the existing serialized publisher without awaiting it. HTTP responses do not wait for publication. Publication errors retain the existing logged retry behavior. A stalled-publisher HTTP test proves the first open, repeat open and an output without attention all return while the receipt remains unpublished, then publication finishes once without duplication. Existing failure/retry and replay tests remain covered. |
| F5 | `src/vigil/result-render.ts:11`, dead helper and duplicated title parsing | The deletion is declined for F1's live-caller reason. The duplicate parsing was already corrected in merged [PR #2676](https://github.com/the-metafactory/cortex/pull/2676), commit `ef0161b9`: `firstBodyLine` and `resultPresentation` both call `somaFileTitle`. No further change is needed. |
| F6 | `src/surface/mc/results.ts:12`, inconsistent literal helpers | Corrected here for the inconsistent 404s: both malformed references and unavailable files use `notFound`. Decline inlining `unsafeLink` and `unavailableOutput`: their names explain the safe fallback in their catch clauses, as required by the repository's caught-error rule. Existing malformed-link, missing-file and containment tests pin those fallbacks. |
| F7 | `src/surface/mc/__tests__/results-route.test.ts:3–6`, `node` | Declined: `node:fs/promises`, `node:fs`, `node:os` and `node:path` are literal Node.js builtin module specifiers, not names for a Stack or Cortex runtime. Renaming them would break imports. |
| F8 | `src/surface/mc/__tests__/results-route.test.ts:6`, `path` | Declined: `node:path` is a filesystem utility module, not a bus Subject. |
| F9 | `src/surface/mc/__tests__/results-route.test.ts:17`, `server` | Declined: `../server` names the actual imported module. Replacing a module filename with a glossary term would break resolution. |
| F10 | `src/surface/mc/__tests__/results-route.test.ts:54`, `listener` | Declined: the test describes an HTTP network listener bound to loopback, not a bus Render target. The canonical replacement would misdescribe what the test exercises. |
| F11 | `src/surface/mc/__tests__/results-route.test.ts:146`, `data` | Declined: the hostile Markdown fixture deliberately exercises the `data:` URL scheme. Its label and URL are test input, not vocabulary for a bus Payload. Renaming the scheme would remove the security case. |
| F12 | `src/surface/mc/__tests__/results-route.test.ts:230,234`, `host` | Declined: `Host` names the HTTP header tested by the rebind guard. A Cortex runtime is not an HTTP header; keeping the actual protocol term makes the assertion accurate. |
| F13 | `src/surface/mc/results.ts:51`, `body` | Already removed in merged [PR #2676](https://github.com/the-metafactory/cortex/pull/2676), commit `ef0161b9`: the generated Markdown string is named `html`. The remaining HTML `<body>` tag is a protocol element, not a bus Payload alias. |
| F14 | `src/surface/mc/server.ts:213`, `server` | Declined: `server.port` reads the bound port from Bun's HTTP server object for the rebind guard. It is a networking object, not an invented domain name for a Cortex runtime. The callback parameter and property remain accurate technical terms. |
| F15 | `src/vigil/result-read.ts:41`, `instance` | The occurrence was removed from this file by merged PR #2673. Decline renaming the corresponding `SystemEventSource.instance` field now used in `resolution.ts`: it is an existing constructor contract field carrying the stack slug. Changing its name here would change the input shape. |
| F16 | `src/vigil/result-read.ts:41`, `agent` | The occurrence was removed from this file by merged PR #2673. Decline renaming the corresponding `SystemEventSource.agent` field now used in `resolution.ts`: it identifies the publishing runtime identity, not a Session. |
| F17 | `src/vigil/soma-output.ts:1–4`, `node` | Declined: these are literal `node:` builtin module specifiers, for the same reason as F7. |
| F18 | `src/vigil/soma-output.ts:4–5`, `path` | Declined: `node:path` and the path-containment import operate on filesystem paths, not bus Subjects. Replacing them with Subject terminology would conflate distinct concepts. |

## Contract evidence

- Cortex [CONTEXT.md](../CONTEXT.md) defines Stack, Cortex runtime, Render target, Subject and Payload in their respective contexts. Its Desk Studio language also explicitly distinguishes filesystem paths from bus Subjects.
- [SystemEventSource](../src/bus/system-events.ts) declares the `agent` and `instance` fields preserved by F15–F16.
- [result-render.ts](../src/vigil/result-render.ts) contains the live `somaGoalWording` caller and shared `somaFileTitle` parsing.
- [resolution.ts](../src/vigil/resolution.ts) owns the atomic attention/outbox transaction, serialized publication, logged retry and replay. This change retains that implementation.

## Verification

Before the fix, `bun run test src/surface/mc/__tests__/results-route.test.ts` reported 49 passes and five failures: four Fetch Metadata cases returned 200 instead of 403, and the stalled-publisher case timed out. The reproduction tests were committed before the implementation.

After the fix, the route, resolution, results and stack-scope suites reported 90 passes and zero failures. They cover the HTTP response, pending and failed publication, receipt identity, concurrent reads, sanitization, containment, replay and local goal wording.

The required full `bun run check` ran once on the host. Its test gate reported 15,635 passes, 72 skips, 201 todos and zero failures across 956 files. Every gate except duplication passed, including branch ancestry. Duplication detected repeated assertions in the new security test; those assertions now use a shared helper. The full suite ran after that extraction and passed. A final `bun scripts/check.ts lint duplication typecheck` passed all three gates on the resulting code. A disposition audit confirmed F1–F18 appear exactly once and all local source links resolve.

## Settled by

[What is the Vigil contract: run-ledger envelope, tick, routing and attention budget?](https://github.com/the-metafactory/soma/issues/787) defines the result-read receipt and local content boundaries preserved here.
