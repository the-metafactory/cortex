/**
 * cortex#1792 (S6) — deliberately throws at module top-level, simulating a
 * broken bundle. The loader's per-plugin fail-isolation must catch this at
 * the "import" stage and continue to the next bundle.
 */
throw new Error("fixture-induced top-level import failure");
