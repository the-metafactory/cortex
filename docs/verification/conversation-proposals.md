# Conversation proposal tools: #3159

The isolated-stack probe passed on 2026-11-06 with Bun 1.4.4, installed Pi,
a synthetic model provider, Chromium and the real Balance conversation writer.
The stack used a temporary conversation store and an in-memory Mission Control
database. No stack credentials were needed. This evidence covers the local
build; the default stack was not deployed.

The browser used the real `ConversationWorkspace` and proposal API:

1. Entered “Prepare a synthetic task in the Lab area for me to review.” Pi
   dispatched `creation_capabilities` and `creation_propose`. Balance contained
   no task before confirmation.
2. Changed the title and saved the edit. The proposal became revision 2.
3. Confirmed once, then repeated the confirmation request. Balance contained
   one task with the edited title and Balance's canonical ID.
4. Checked the card's Balance object link and originating-entry link. The
   originating entry existed in the durable conversation record.
5. Asked Pi to repeat delivery and read the result. The saved proposal was
   reused, and Balance still contained one task.
6. Removed the task through the owning My day API using `outline-remove`.
   Readback confirmed that the canonical ID was absent. Browser errors: zero.

[Created card from the browser probe](conversation-proposals-created.png).

The repeatable dispatch tests are in
`src/conversations/__tests__/tools-proposals.test.tsx`. Execute them with
`bun run test src/conversations/__tests__/tools-proposals.test.tsx`.
They cover preview, editing, confirmation, duplicate delivery, scoped grants,
revocation, identity refusal, timeout, restart and uncertain creation readback.
The installed-Pi test uses a synthetic provider and skips when Pi is absent.

The repository check after merging `origin/main` passed lint, duplication,
typecheck, vocabulary, SDK, shippable hygiene, XDG and up-to-date gates. The
initial suite required updating the installed-Pi test's expected tool list.
A test-gate retry then encountered an unchanged `desk-action.test.ts` marker
read returning an empty string. The 100 focused repetitions on an untouched
`origin/main` archive do not rule out a regression on this branch. No change
was made to that test.
The final `bun scripts/check.ts test` invocation passed: 14,258 passed, 30 skipped,
201 marked todo and zero failures across 862 files.

The review regression retrieves a recorded permission claim through
`conversation_read`, then proposes a complete `graph-node` in the conversation
with a valid `balance-task` grant. The proposal stays pending with no missing
fields, no egress refusal and no additional writer call. Removing the grant's
type check makes this assertion fail because the graph object is created.
The same retrieved claim does not authorize a Balance task in another
conversation. The focused proposal, creation, API and destination suites pass
38 tests after these corrections.

The review correction's full `bun run check` passed on this branch: 14,217 tests
passed, 71 skipped, 201 marked todo and zero failures across 862 files. All
other gates passed, including up-to-date. The prior marker failure did not
recur in this invocation.

The link probe covers web cards. Conversation tools still return Mission
Control-relative links for conversations, entries and some objects. Discord
link resolution remains unverified; the tool session carries no configured
Mission Control base URL.
