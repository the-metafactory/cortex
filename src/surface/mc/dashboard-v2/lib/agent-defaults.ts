/**
 * Operator-facing display name for the default-agent fallback.
 *
 * Surfaces in the F-19 dispatch popover ("Dispatch this task to <name>?")
 * and any other UI surface that needs to refer to the agent that will
 * receive an unscoped dispatch. Goes away once the F-19.1 operator agent
 * picker lands and the operator can pick a registered head explicitly.
 *
 * Kept frontend-only because the backend's `DEFAULT_AGENT_NAME` (used as
 * the actual `agents.name` row) is an internal identifier, not a label
 * tuned for operator readability — those two concerns can drift cleanly.
 */
export const DEFAULT_AGENT_DISPLAY_NAME = "Default Agent";
