## Discord Channel Routing

Repos get channels. GitHub entities get threads. No `cortex.yaml` config needed.

```
#cortex (channel)                  — repo context
  └── cortex/issue/9 (thread)      — issue #9
  └── cortex/pr/54 (thread)        — PR #54
  └── cortex/c-108 (thread)        — feature C-108 (→ resolves to issue)
```

When invoked from a channel or thread, the agent should:
1. Match channel name against `github.repos` short names → scope work to that repo
2. If in a thread, parse the entity: `{repo}/issue/{N}`, `{repo}/pr/{N}`, `{repo}/{feature-id}`
3. When starting work on an entity with no existing thread, create one
4. Route worklog to the invoking thread/channel

See `docs/sop-discord-channel-routing.md` for the full SOP (lifted from grove-v2 at MIG-7.11).
