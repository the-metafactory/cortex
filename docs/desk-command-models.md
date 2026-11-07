# Desk command models

Digest, waiting, Studio, and ruling helpers support a command that returns one JSON document on stdout. The native Codex helper runs with existing authentication and disables independent tools, user configuration, skills instructions, project documents, and global instruction reads. It uses a private working directory and explicit deadlines. Its environment excludes unrelated service secrets and provider routing variables.

Native one-shot commands require `sourcePolicy: cloud` in the command configuration. Cortex passes a versioned message envelope to `desk-codex-json`. A `.local` model slot cannot declare cloud access. Without a local model, local-policy content stays with deterministic fallback behaviour. Unknown source areas are local for cloud dispatch.

Ruling commands retain their existing raw stdin contract. Set `commandFormat: messages` to opt a native ruling helper into the message envelope. A cloud ruling helper receives nodes only from repositories whose configured areas all permit cloud access. Nodes without an area stay with the existing fallback explanation.

Mail classification defaults to `sourcePolicy: cloud`. Existing local-only deployments must explicitly set `sourcePolicy: local` to classify local or unassigned sources. Settings reports mail held by the cloud boundary. No local generation service is started automatically.

The native classifier retains the Pulse research loop. Its explicit mail-account, source, and Studio-area allowlists must match the cloud-approved Desk configuration. Mail research binds the account in the host. Calendar and notes tools search only the supplied cloud-approved Desk calendar and Studio snapshot, and report their coverage. Work calendars and the global Tana index are not queried by these scoped tools.

Cortex filters mail, calendar, sender lists, corrections, similarity examples, Studio notes, Balance focus topics, and goal wording before cloud dispatch. The adapter validates the explicit source provenance again. A model cannot override a host-bound account or snapshot path. Publishing and message delivery remain governed by their existing controls.

## The source boundary

`src/surface/mc/desk/source-boundary.ts` holds the one check every Desk model call crosses. `chatJson`, `commandJson` and the mail hand-off owner take a `PromptContent` and call `assertRoute` before they read a key, send a request or spawn a process. `routeOf` decides where a configuration sends its prompts: a command is local only when it declares `sourcePolicy: local` and names no known cloud client, and an endpoint is local when it declares so or sits on loopback with no declaration. A non-loopback endpoint or a command in a `.local` slot must now set `sourcePolicy: local`; nothing defaults to it.

`sourceBoundary` reads `areas` and `sources` from configuration. A source is cloud-approved only when it names an area whose policy is `cloud`. A source it does not know is local. A prompt with no named source is local too. Local content on a cloud route throws `CloudRouteRefused`, with no model call.

Set `mc.desk.mail.classifier.local` to classify local-policy mail on a local model, one mail at a time and without research tools. The main classifier keeps the cloud-approved sources. Without the slot, local-policy mail stays with the rules and Settings reports how much.

Work mail is not handed to Ivy, because a hand-off files a task on a shared map. It may go only to a local-policy Studio thread, not to a cloud thread and not to the Studio inbox.

Pulse's `A_MAIL_READ` and `A_MAIL_SEARCH` accept only accounts listed in `PULSE_MAIL_ACCOUNTS`. Keep that list empty for routines, or list only cloud-approved accounts for a routine that uses a cloud model. The Desk classifier sets it from `--mail-accounts`.
