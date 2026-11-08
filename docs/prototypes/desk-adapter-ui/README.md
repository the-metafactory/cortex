# Conversation → Balance task

Refs #3290. This disposable prototype follows the principal’s correction: stay in the conversation, propose one Balance card, and offer **Approve** or **Edit**. The earlier technical workspace is not the user experience. This branch stays out of main; the revised interaction still needs principal review.

Run `bun run prototype:desk-adapter-ui` and open http://127.0.0.1:33590/?desk=adapter-ui-prototype . Existing `variant=B` links open the same simplified flow.

1. Discuss the release checklist with Ivy, then type “turn this into a task” or use that suggested phrase.
2. Ivy proposes one Balance task with a useful title and note. Approve it or edit its ordinary task fields inline.
3. Saving edits changes the proposal. Approve adds it once and shows the saved card with “View task”. Revisiting or repeating the request does not add another task.

The normal flow contains no adapter picker, query/schema controls, renderer selector, stage tabs, JSON inspector, counters, protocol labels or variant switcher. A small “Sample data” badge identifies the example. The conversation, response and save are synthetic; no real Balance object exists. State stays in memory while navigating the prototype; reloading starts a fresh example.

## Screenshots

| Conversation | Proposed task | Edit | Saved task |
| --- | --- | --- | --- |
| [Desktop](desktop-conversation.png) | [Desktop](desktop-proposal.png) · [Mobile](mobile-proposal.png) | [Desktop](desktop-edit.png) | [Desktop](desktop-saved.png) · [Mobile](mobile-saved.png) |

## Browser verification

`probe.json` records the normal conversation-to-card-to-edit-to-approve path, missing-title validation, cancelled edits, retained unsaved changes across conversation navigation, double-click/repeat protection, mobile overflow and zero external requests/effects. It asserts that the normal page has no visible technical plumbing. It fails on the rejected `bab7490` normal page, which exposed “Renderer”.

With a staged Playwright Chromium bundle in a temporary directory:

```sh
bun --no-env-file scripts/probe-desk-adapter-ui.ts --browser /tmp/cortex-3290-browser/chrome-headless-shell
```

The former technical comparison is retained only at `?desk=adapter-ui-prototype&lab=1&variant=A` for development evidence. It is not linked from the normal experience. Its isolated-frame checks are separately runnable with `scripts/probe-desk-adapter-ui-lab.ts`; the shared browser setup uses a temporary HOME/profile. The lab remains a local Chromium candidate demonstration, not production hosted authentication or general browser isolation proof. The simpler normal flow makes no such claim.
