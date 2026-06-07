#!/usr/bin/env bun
/**
 * G-501: GroveContext Hook
 * Injects network identity and session context into Claude Code sessions.
 * Only active when CORTEX_CHANNEL (legacy GROVE_CHANNEL) env var is set
 * (session scoping).
 */

import { resolveSurfaceEnv } from "./lib/surface-env";

// =============================================================================
// Session Scoping
// =============================================================================

// cortex#774: read CORTEX_* first, fall back to legacy GROVE_* (see
// surface-env.ts).
const groveChannel = resolveSurfaceEnv("CHANNEL");
if (!groveChannel) {
  process.exit(0); // Not an instrumented session — silent exit
}

const groveNetwork = resolveSurfaceEnv("NETWORK");
const groveAgentId = resolveSurfaceEnv("AGENT_ID");
const groveAgentName = resolveSurfaceEnv("AGENT_NAME");

// =============================================================================
// Context Injection
// =============================================================================

interface HookInput {
  hook_event_name?: string;
  hook_type?: string;
  prompt?: string;
}

async function main() {
  try {
    const input = await new Response(Bun.stdin.stream()).text();
    if (!input.trim()) {
      console.log(input);
      process.exit(0);
    }

    const hookInput = JSON.parse(input) as HookInput;

    // Only inject on SessionStart
    const hookType = hookInput.hook_event_name ?? hookInput.hook_type ?? "unknown";
    if (hookType !== "SessionStart") {
      console.log(input);
      process.exit(0);
    }

    // Build context injection
    const contextLines: string[] = [];

    if (groveNetwork) {
      contextLines.push(`Network: ${groveNetwork}`);
    }

    if (groveChannel) {
      contextLines.push(`Channel: ${groveChannel}`);
    }

    if (groveAgentId) {
      contextLines.push(`Agent ID: ${groveAgentId}`);
    }

    if (groveAgentName) {
      contextLines.push(`Agent Name: ${groveAgentName}`);
    }

    if (contextLines.length === 0) {
      console.log(input);
      process.exit(0);
    }

    // Inject Grove context into system prompt
    const contextBlock = `
<system-reminder>
Grove Context:
${contextLines.map((line) => `  ${line}`).join("\n")}

This session is instrumented for Grove event tracking and dashboard visibility.
</system-reminder>
`;

    // Append context to prompt.
    // NOTE: This hook mutates hookInput.prompt. Prompt-mutating hooks should be
    // ordered intentionally in grove-hooks.json to ensure correct layering
    // (e.g., security preambles before context injection).
    if (typeof hookInput.prompt === "string") {
      hookInput.prompt = hookInput.prompt + contextBlock;
    }

    console.log(JSON.stringify(hookInput));
  } catch {
    // Never block agent work — swallow all errors
  }

  process.exit(0);
}

void main();
