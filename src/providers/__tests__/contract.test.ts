/**
 * API-P1.5 (issue #2065) — Bun test entrypoint for the shared provider contract
 * suite (THE GUARD / epic progress meter).
 *
 * Bun's test runner only discovers files whose name contains `.test` / `.spec`.
 * The actual enumeration — one `describe` per gated slice, every design
 * §"Verification strategy" case as a `test.todo` — lives in `./contract.ts`,
 * which registers its `describe`/`test.todo` blocks as an import side-effect.
 * This file exists solely to make `bun test src/providers/__tests__` load it.
 *
 * Wave 1: importing this file prints the pending todos grouped per slice and
 * performs ZERO network I/O (todos never execute). Each gated slice
 * (#2061 anthropic / #2062 openai-compatible / #2063 harness) later flips its
 * own todos in `./contract.ts` to live `test(...)` bodies; no change is needed
 * here.
 */

import "./contract";
