#!/usr/bin/env bun
import { runSdkDts } from "./lib/sdk-dts";

const HEADER = `// ============================================================================
// glossary-ignore: host, run, message, body
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Types-only artifact for the Desk API. An external UI resolves it via
//   import type { DeskView, … } from "@the-metafactory/cortex/desk-api";
// (package.json exports["./desk-api"].types points here).
//
// Regenerate after ANY change to src/desk-api/index.ts or the wire types it
// re-exports:
//   bun run desk-api:dts
//
// CI fails on drift between this committed file and a fresh regeneration, and
// scripts/check-desk-api-types.ts requires a DESK_API_VERSION bump whenever
// the published shape changes.
// ============================================================================
`;

runSdkDts({ entry: "src/desk-api/index.ts", artifact: "src/desk-api/generated/desk-api.d.ts", label: "desk-api", header: HEADER });
