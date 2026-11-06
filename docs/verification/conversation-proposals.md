# Conversation proposal tools: node #3159

The isolated-stack probe passed on 2026-11-06 with Bun 1.4.4, installed Pi,
a synthetic model provider, Chromium and the real Balance conversation writer.
The stack used a temporary conversation store and an in-memory Mission Control
database. No deployment credentials were needed. This evidence covers the local
build; the default stack was not deployed.

The browser used the real `ConversationWorkspace` and proposal API:

1. Entered “Prepare a synthetic task in the Lab area for me to review.” Pi
   dispatched `creation_capabilities` and `creation_propose`. Balance contained
   no task before confirmation.
2. Changed the title and saved the edit. The proposal became revision 2.
3. Confirmed once, then repeated the confirmation request. Balance contained
   one task with the edited title and the owner's canonical ID.
4. Checked the card's Balance object link and originating-entry link. The
   originating entry existed in the durable conversation record.
5. Asked Pi to repeat delivery and read the result. The saved proposal was
   reused, and Balance still contained one task.
6. Removed the task through the owning My day API using `outline-remove`.
   Readback confirmed that the canonical ID was absent. Browser errors: zero.

[Created card from the browser probe](conversation-proposals-created.png).

The repeatable dispatch tests are in
`src/conversations/__tests__/tools-proposals.test.tsx`. Run them with
`bun run test src/conversations/__tests__/tools-proposals.test.tsx`.
They cover preview, editing, confirmation, duplicate delivery, scoped grants,
revocation, identity refusal, timeout, restart and uncertain owner readback.
The installed-Pi test uses a synthetic provider and skips when Pi is absent.
