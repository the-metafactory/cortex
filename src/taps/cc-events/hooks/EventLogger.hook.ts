#!/usr/bin/env bun
// #1749 compat shim — arc installs created before v6.3.9 symlink
// ~/.claude/hooks/CortexEventLogger.hook.ts at this legacy filename (#1739
// renamed the source to kebab-case, and serving-tree upgrades never re-read
// arc-manifest.yaml). The hook body executes top-level on import, so this
// shim IS the hook. Remove once an arc relink/repair verb exists (#1749).
import "./event-logger.hook";
