# PR #2733 round 2 finding dispositions

Prepared for node #2735, checkpoint `review-findings-2729-0ed9dcf8`. <!-- glossary-ignore: node -->
The source review covered commit `0ed9dcf8c9129fd9252716a65ff30f0ccb5029ad`;
locations below refer to that revision. Merge and graph closure remain with the
supervisor and principal.

| Finding | Reviewed location | Disposition | Evidence or reason |
| --- | --- | --- | --- |
| F1: Admission peek retries outside the shared boot budget | `src/bus/admission/provision.ts:79` | Implemented | `ProvisionAdmissionKvOpts.bootRetry` is optional. The peek reuses `withProvisionRetry`, which performs one attempt without opt-in and preserves the supplied shared budget when enabled. `startCortex` supplies its boot options. Regression tests cover opt-out, recovery, exhausted and expired budgets, exhaustion propagation, and the Cortex boot call. |
| F2: Misindented CODE_REVIEW `bootRetry` | `src/cortex.ts:2304` | Implemented | Aligned `bootRetry` with `jsm` in the CODE_REVIEW provisioning call. |
| F3: Avoid `node` | `src/bus/__tests__/boot-jetstream-retry.test.ts:2–4` | Declined | `node:fs`, `node:os` and `node:path` are Node built-in module specifiers. They identify neither a Stack nor a Cortex runtime; renaming them to domain terms would break imports. | <!-- glossary-ignore: node -->
| F4: Avoid `path` | `src/bus/__tests__/boot-jetstream-retry.test.ts:4` | Declined | `node:path` provides filesystem operations. It does not name a bus Subject. | <!-- glossary-ignore: node -->
| F5: Avoid `subscriber` | `src/bus/__tests__/boot-jetstream-retry.test.ts:20` | Declined | `MyelinSubscriber` is the existing pull-subscription handle type imported from `myelin/subscriber`. It represents readiness and stop operations, not a Render target. |
| F6: Avoid `listener` | `src/bus/__tests__/boot-jetstream-retry.test.ts:21` | Declined | `ReflexActivationListener` and its module name identify an existing activation bridge, not a Render target. Renaming that interface is outside this review fix. |
| F7: Avoid `agent` in retry tests | `src/bus/__tests__/boot-jetstream-retry.test.ts:62,90,287` | Declined | The first two uses are the existing `AgentConfigSchema` configuration key; the third is an existing source field. They are schema identifiers, not prose describing a Session. Changing them would stop testing the real interfaces. | <!-- glossary-ignore: agent -->
| F8: Avoid `persona` | `src/bus/__tests__/boot-jetstream-retry.test.ts:96` | Declined | `persona` is the existing agent configuration field for a persona file. CONTEXT.md explicitly allows persona filenames; this does not introduce a Persona domain entity. | <!-- glossary-ignore: agent, persona -->
| F9: Avoid `instance` | `src/bus/__tests__/boot-jetstream-retry.test.ts:287` | Declined | `instance` is a required field of the existing runtime source input used by the Reflex bridge. This fixture exercises that interface; it is not a new name for a Stack or Session. |
| F10: Avoid `agent` in boot loops | `src/cortex.ts:2729,2734,2876` | Declined | These loops start durable consumers for configured, persistent Cortex Agents. CONTEXT.md defines Agent as the long-lived identity with a JetStream consumer and distinguishes it from the Sessions it runs. Substituting Session would misstate the behavior. | <!-- glossary-ignore: agent -->
| F11: Avoid `listener` in boot log | `src/cortex.ts:4165` | Declined | `reflex-activation-listener` identifies the mounted Reflex activation bridge in its diagnostic log. It is the existing module name, not a Render target alias. |
| F12: Avoid `agent` in brain consumer boot | `src/runner/brain-consumer-boot.ts:296,394` | Declined | `BrainBootAgent` and `startForAgent` describe configured Cortex Agents whose durable consumers are wired before any Session starts. Agent is canonical here. | <!-- glossary-ignore: agent -->
| F13: Avoid `agent` in release consumer boot | `src/runner/release-consumer-boot.ts:111,125` | Declined | `ReleaseBootAgent` and `startForAgent` describe configured Cortex Agents with release capabilities and durable consumers. These are not substrate Sessions. | <!-- glossary-ignore: agent -->
| F14: Avoid `agent` in review consumer boot | `src/runner/review-consumer-boot.ts:176,190` | Declined | `ReviewBootAgent` and `startForAgent` describe configured Cortex Agents with review capabilities and durable consumers. These are not substrate Sessions. | <!-- glossary-ignore: agent -->

The glossary dispositions follow CONTEXT.md's definitions of Agent, Session,
Subject and Render target. Glossary directives mark intentional quotations and
existing identifiers; no domain-wide interface renames are needed.
