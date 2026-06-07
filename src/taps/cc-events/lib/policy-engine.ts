/**
 * T-3.2 through T-3.6: Policy Engine
 * Pure functions for event filtering, redaction, and composition.
 */

import type { RawEvent, PublishedEvent } from "../hooks/lib/event-types";
import { resolveSurfaceEnv } from "../hooks/lib/surface-env";
import type { RelayPolicy } from "./policy-schema";

// =============================================================================
// T-3.2: Allow Filter
// =============================================================================

export function isEventAllowed(event: RawEvent, policy: RelayPolicy): boolean {
  return policy.allow_events.includes(event.event_type);
}

// =============================================================================
// T-3.3: Field Filter
// =============================================================================

export function filterFields(
  event: RawEvent,
  policy: RelayPolicy
): Record<string, unknown> {
  const config = policy.fields[event.event_type];
  if (!config) return {};

  const result: Record<string, unknown> = {};
  for (const field of config.include) {
    if (field in event.payload) {
      result[field] = event.payload[field];
    }
  }
  return result;
}

// =============================================================================
// T-3.4: Redaction Engine
// =============================================================================

export function applyRedactions(
  payload: Record<string, unknown>,
  policy: RelayPolicy
): Record<string, unknown> {
  if (policy.redact.length === 0) return payload;

  const redactors = policy.redact.map((r) => ({
    regex: new RegExp(r.pattern, "g" + (r.flags ?? "")),
    replace: r.replace,
  }));

  return deepMapStrings(payload, (str) => {
    for (const { regex, replace } of redactors) {
      regex.lastIndex = 0;
      str = str.replace(regex, replace);
    }
    return str;
  });
}

function deepMapStrings(
  obj: Record<string, unknown>,
  fn: (s: string) => string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = fn(value);
    } else if (Array.isArray(value)) {
      result[key] = (value as unknown[]).map((item): unknown =>
        typeof item === "string"
          ? fn(item)
          : item && typeof item === "object"
            ? deepMapStrings(item as Record<string, unknown>, fn)
            : item
      );
    } else if (value && typeof value === "object") {
      result[key] = deepMapStrings(value as Record<string, unknown>, fn);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// =============================================================================
// T-3.5: Drop Conditions
// =============================================================================

export function shouldDrop(event: RawEvent, policy: RelayPolicy): boolean {
  for (const rule of policy.drop_if) {
    const value = getPath(event, rule.field);
    if (typeof value === "string") {
      if (rule.contains.some((c) => value.includes(c))) {
        return true;
      }
    }
  }
  return false;
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// =============================================================================
// T-3.6: Pipeline Composition
// =============================================================================

export function processEvent(
  raw: RawEvent,
  policy: RelayPolicy
): PublishedEvent | null {
  // 1. Check allow
  if (!isEventAllowed(raw, policy)) return null;

  // 2. Check drop
  if (shouldDrop(raw, policy)) return null;

  // 3. Filter fields
  const filtered = filterFields(raw, policy);

  // 4. Apply redactions
  const redacted = applyRedactions(filtered, policy);

  // 5. Build published event
  return {
    event_id: raw.event_id,
    event_type: raw.event_type,
    timestamp: raw.timestamp,
    session_id: raw.session_id,
    // cortex#774: read CORTEX_CHANNEL first, fall back to legacy GROVE_CHANNEL.
    grove_channel: raw.grove_channel ?? resolveSurfaceEnv("CHANNEL"),
    agent_id: raw.agent_id,
    agent_name: raw.agent_name,
    payload: redacted,
  };
}
