// Loaded before every test file via bunfig.toml `[test] preload`.
//
// Per-test timeout of 20s (cortex#771; see bunfig.toml for why). Bun 1.3's
// bunfig `[test]` table has no `timeout` key — `timeout = 20000` there is
// silently ignored and every test ran under the 5s default (node #2576) —
// so the ceiling is set here. A test's own timeout argument still wins.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(20_000);
