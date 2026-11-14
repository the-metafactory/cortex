#!/usr/bin/env bun
// glossary-ignore: run
import { runSdkDts } from "./lib/sdk-dts";

const HEADER = `// ============================================================================
// glossary-ignore: host, run, message, body
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Self-contained type artifact for the Desk adapter SDK. Out-of-tree Desk
// adapter packages resolve it via
//   import type { AdapterDeclaration, DeskAdapterHost, … }
//     from "@the-metafactory/cortex/desk-sdk";
// (package.json exports["./desk-sdk"].types points here).
//
// Regenerate after ANY change to src/desk-sdk/index.ts or the contract types
// it re-exports:
//   bun run desk:dts
//
// CI fails on drift between this committed file and a fresh regeneration, and
// scripts/check-desk-sdk.ts requires a DESK_ADAPTER_SDK_VERSION bump whenever
// the contract shape changes.
// ============================================================================
`;

runSdkDts({ entry: "src/desk-sdk/index.ts", artifact: "src/desk-sdk/generated/desk-sdk.d.ts", label: "desk", header: HEADER });

runSdkDts({ entry: "src/desk-adapter-sdk/conformance.ts", artifact: "src/desk-adapter-sdk/generated/desk-adapter-conformance.d.ts", label: "desk", header: "" });
