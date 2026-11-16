## Architecture

cortex is the **M7 application** of the metafactory Myelin layer model: the principal's collaboration surface. It consumes the bus (M2–M6), owns no part of M1–M6, and presents activity to humans. The runtime is one entrypoint, `src/cortex.ts`, plus the relay and CLIs; daemons are launchd plists. No platform adapter lives in-tree: `web`, `slack`, `mattermost` and `discord` are first-party arc adapter bundles (ADR-0024).

cortex inherits its source from `the-metafactory/grove-v2`. The migration runs in phases MIG-0 to MIG-8, planned in `docs/plan-cortex-migration.md`.

### Task guides

Read the guide when your task touches its area. These are not loaded by default.

| When the task involves | Read |
|---|---|
| Finding your way around `src/`, or the layer model | `docs/agent-guide/architecture.md`, then `docs/architecture.md` |
| Stack configuration, `system.yaml`, `inference`, pointer files | `docs/agent-guide/config-files.md` |
| Picking up a MIG item or feature, branch and PR naming, ticking plans | `docs/agent-guide/implementation-workflow.md` |
| `cortex stack` or `cortex network` commands, federation | `docs/agent-guide/platform-management.md` |
| Building or deploying the dashboard or worker | `docs/agent-guide/dashboard-deployment.md` |
| Discord channels and threads, `async:` and `team:` messages | `docs/agent-guide/discord-routing.md`, `docs/agent-guide/message-keywords.md` |
| Session instrumentation (`CORTEX_*` env vars), the `discord` CLI | `docs/agent-guide/pai-integration.md` |
| Editing CLAUDE.md, shippable-path gates, third-party code, diagrams | `docs/agent-guide/repo-conventions.md` |
| Wire contracts in `src/bus/**` | `src/bus/CLAUDE.md` and `docs/agents-md/wire-grounding.md` |
