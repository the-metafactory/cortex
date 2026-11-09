#!/usr/bin/env bun
import { runSdkDts } from "./lib/sdk-dts";

const HEADER = `// ============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Self-contained type artifact for the cortex plugin SDK (cortex#1950). This is
// the file out-of-tree surface-plugin bundles resolve when they
//   import type { PlatformAdapter, … } from "@the-metafactory/cortex/surface-sdk";
// (package.json exports["./surface-sdk"].types points here).
//
// Regenerate after ANY change to src/surface-sdk/index.ts or the contract types
// it re-exports:
//   bun run sdk:dts
//
// CI (.github/workflows/ci.yml → surface-sdk-dts-sync) fails on any drift between
// this committed file and a fresh regeneration, so it can never go stale.
// ============================================================================
`;

runSdkDts({ entry: "src/surface-sdk/index.ts", artifact: "src/surface-sdk/generated/surface-sdk.d.ts", label: "sdk", header: HEADER });
