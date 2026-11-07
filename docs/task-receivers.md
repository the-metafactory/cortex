# Task receivers

An agent can receive a direct task without a chat presence. Cortex gives every locally hosted builtin agent its own canonical direct-task subscription. Headless Claude Code agents and api-agent agents participate. Standalone agents own their own bus connections, and exec brains use BrainConsumer, so neither gains a builtin task listener.

Registered agents subscribe to local.{principal}.{stack}.tasks.@{assistant}.>. The subject, envelope target, payload agent and bound receiving agent must agree before a harness runs. A stack with no registered agents retains the legacy default listener. Review capability subjects and dev capability subjects remain owned by their separate consumers.

Reflex prompt targets publish canonical assistant-addressed tasks through buildReflexDispatch. Review-kind Reflex targets publish code-review capability tasks instead. The latter must never spawn a builtin chat session. The default listener never subscribed to federated subjects; explicit custom-subject listeners remain available through their existing API.

Task receiver identity and runtime configuration are a boot snapshot. Adding, removing or changing a receiver through agents.d logs a restart requirement. Until that restart, a newly added receiver has no direct-task subscriber and its sender may time out. Review and brain consumer reload support does not imply task-listener hot reload. Restart before dispatching to an updated receiver.

The headless routing repair replaces the surface-only listener rule from cortex#1160. It preserves unregistered legacy stacks, headless builtin workers and exec-brain ownership while removing wildcard overlap on registered stacks.


## Producer and consumer ownership

| Producer | Task shape | Owning consumer |
|---|---|---|
| Surface chat and gateway (`bus/dispatch-source-publisher.ts`) | `local.{p}.{s}.tasks.@{assistant}.chat` | The addressed builtin task receiver |
| Reflex prompt (`bus/reflex-activation-listener.ts`) | `local.{p}.{s}.tasks.@{assistant}.{capability}` | The addressed builtin task receiver; boot passes the stack into the builder |
| Reflex review and public-offer translation | `tasks.code-review.{flavor}` under their scoped prefixes | ReviewConsumer |
| Orchestrator implementation | `local.{p}.{s}.tasks.dev.implement` | DevConsumer |
| Brain dispatch effect | `local.{p}.{s}.tasks.{capability}` | The declared capability's dedicated consumer; exec brains bind exact capabilities |
| Release request | `local.{p}.{s}.tasks.release.cut` | ReleaseConsumer; its producer is external to this source tree |
| Surface-to-exec-brain request | `local.{p}.{s}.brain.{capability}` | BrainConsumer |
| Reflex process handler | No task re-emission | Registered process runner |

Capability announcements are observability, not a generic routing service. A custom or external publisher that relied on a registered stack's broad wildcard for a non-addressed task must use the canonical direct assistant subject or a dedicated capability consumer. Configured child processes may publish dynamically; those external producers are outside the source audit. Unregistered legacy stacks retain their default wildcard, and explicit custom-subject listeners retain their API.

Each receiver inherits the configured signature, policy and admission gates. The patch does not turn a permissive signing posture or an absent legacy policy into enforcement. A configured AdmissionGate is one shared object across listeners; per-listener in-flight sets only track shutdown. When admission is absent, this seam has no concurrency bound before or after the change.
