# Task receivers

An agent can receive a direct task without a chat presence. Cortex gives every locally hosted builtin agent its own canonical direct-task subscription. Headless Claude Code agents and api-agent agents participate. Standalone agents own their own bus connections, and exec brains use BrainConsumer, so neither gains a builtin task listener.

Registered agents subscribe to local.{principal}.{stack}.tasks.@{assistant}.>. The subject, envelope target, payload agent and bound receiving agent must agree before a harness runs. A stack with no registered agents retains the legacy default listener. Review capability subjects and dev capability subjects remain owned by their separate consumers.

Reflex prompt targets publish canonical assistant-addressed tasks through buildReflexDispatch. Review-kind Reflex targets publish code-review capability tasks instead. The latter must never spawn a builtin chat session. The default listener never subscribed to federated subjects; explicit custom-subject listeners remain available through their existing API.

Task receiver identity and runtime configuration are a boot snapshot. Adding, removing or changing a receiver through agents.d logs a restart requirement. Until that restart, a newly added receiver has no direct-task subscriber and its sender may time out. Review and brain consumer reload support does not imply task-listener hot reload. Restart before dispatching to an updated receiver.

The headless routing repair replaces the surface-only listener rule from issue1160. It preserves unregistered legacy stacks, headless builtin workers and exec-brain ownership while removing wildcard overlap on registered stacks.
