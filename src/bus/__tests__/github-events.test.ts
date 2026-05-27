/**
 * MIG-5.6 (C-106): tests for `github.*` envelope constructor.
 *
 * Two coverage axes, mirroring `system-events.test.ts`:
 *   1. Shape — fields go to the right place (envelope top-level vs payload),
 *      optional fields are omitted (not `undefined`-valued), action
 *      defaulting works.
 *   2. Validation — every constructed envelope passes the vendored myelin
 *      schema. Catches regressions where the `type` pattern drifts off the
 *      schema's `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$` (e.g. someone
 *      removes the `sanitizeTypeSegment` underscore-to-hyphen mapping).
 */

import { describe, expect, test } from "bun:test";
import { validateEnvelope } from "../myelin/envelope-validator";
import {
  createGithubEventEnvelope,
  sanitizeTypeSegment,
} from "../github-events";

const SRC = { org: "metafactory", agent: "cortex", instance: "local" };

describe("sanitizeTypeSegment", () => {
  test("lowercases input", () => {
    expect(sanitizeTypeSegment("PullRequest")).toBe("pullrequest");
  });

  test("replaces underscores with hyphens (GitHub `pull_request` case)", () => {
    expect(sanitizeTypeSegment("pull_request")).toBe("pull-request");
    expect(sanitizeTypeSegment("issue_comment")).toBe("issue-comment");
  });

  test("collapses runs of separator characters", () => {
    expect(sanitizeTypeSegment("a__b___c")).toBe("a-b-c");
    expect(sanitizeTypeSegment("a  b  c")).toBe("a-b-c");
  });

  test("strips leading and trailing separators", () => {
    expect(sanitizeTypeSegment("_opened_")).toBe("opened");
    expect(sanitizeTypeSegment("---x---")).toBe("x");
  });

  test("preserves already-conforming values", () => {
    expect(sanitizeTypeSegment("opened")).toBe("opened");
    expect(sanitizeTypeSegment("push")).toBe("push");
    expect(sanitizeTypeSegment("g-123")).toBe("g-123");
  });
});

describe("createGithubEventEnvelope", () => {
  test("builds 3-segment type from event + action", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "pull_request",
      action: "opened",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: { number: 42 },
    });
    expect(env.type).toBe("github.pull-request.opened");
    expect(env.source).toBe("metafactory.cortex.local");
  });

  test("synthesises `received` action when none provided", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: { ref: "refs/heads/main" },
    });
    expect(env.type).toBe("github.push.received");
    expect("action" in env.payload).toBe(false);
  });

  test("synthesises `received` action when action is empty after sanitisation", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "ping",
      action: "___",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    // After sanitisation, "___" collapses to empty → defaults to "received".
    expect(env.type).toBe("github.ping.received");
    // The original `action` value is still preserved verbatim in the
    // payload so downstream consumers can see what was passed.
    expect(env.payload).toMatchObject({ action: "___" });
  });

  test("promotes UUID-shaped delivery_id to correlation_id", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "issues",
      action: "opened",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    expect(env.correlation_id).toBe("12345678-1234-4234-8234-123456789012");
    expect(env.payload).toMatchObject({
      delivery_id: "12345678-1234-4234-8234-123456789012",
    });
  });

  test("keeps non-UUID delivery_id in payload only (no correlation_id)", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "not-a-uuid",
      payload: {},
    });
    expect(env.correlation_id).toBeUndefined();
    expect(env.payload).toMatchObject({ delivery_id: "not-a-uuid" });
  });

  test("includes optional repo and sender at payload top-level when provided", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "issues",
      action: "opened",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: { number: 7 },
      repo: "the-metafactory/cortex",
      sender: "mellanon",
    });
    expect(env.payload).toMatchObject({
      repo: "the-metafactory/cortex",
      sender: "mellanon",
    });
  });

  test("omits repo and sender from payload when not provided", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    expect("repo" in env.payload).toBe(false);
    expect("sender" in env.payload).toBe(false);
  });

  test("nests original payload under `body` so envelope wrapping fields are preserved", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "release",
      action: "published",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: { release: { tag_name: "v0.5.0" } },
    });
    expect(env.payload.body).toEqual({ release: { tag_name: "v0.5.0" } });
  });

  test("each invocation returns a fresh UUID id and ISO timestamp", () => {
    const a = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    const b = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    expect(a.id).not.toBe(b.id);
    // ISO-8601 sanity check
    expect(() => new Date(a.timestamp).toISOString()).not.toThrow();
  });

  test("sovereignty defaults are principal-only / NZ when source has no override", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
  });

  test("sovereignty data_residency follows source.dataResidency override", () => {
    const env = createGithubEventEnvelope({
      source: { ...SRC, dataResidency: "AU" },
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    expect(env.sovereignty.data_residency).toBe("AU");
  });

  test("envelope passes vendored myelin schema validation", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "pull_request",
      action: "opened",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {
        number: 42,
        pull_request: { title: "feat: new feature" },
        repository: { full_name: "the-metafactory/cortex" },
        sender: { login: "mellanon" },
      },
      repo: "the-metafactory/cortex",
      sender: "mellanon",
    });
    const validation = validateEnvelope(env);
    if (!validation.ok) {
      // Surface the actual schema errors for fast triage instead of the
      // anonymous `false`.
      throw new Error(
        `envelope failed schema validation: ${JSON.stringify(validation.errors)}`,
      );
    }
    expect(validation.ok).toBe(true);
  });

  test("envelope passes schema for action-less event (push)", () => {
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "push",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {
        ref: "refs/heads/main",
        commits: [{ id: "abc123", message: "feat: x" }],
        repository: { full_name: "the-metafactory/cortex" },
      },
      repo: "the-metafactory/cortex",
    });
    const validation = validateEnvelope(env);
    if (!validation.ok) {
      throw new Error(
        `envelope failed schema validation: ${JSON.stringify(validation.errors)}`,
      );
    }
    expect(validation.ok).toBe(true);
  });

  test("envelope passes schema for event with mixed-case action (defensive)", () => {
    // GitHub itself uses lowercase actions today, but if a future event
    // carried mixed-case (e.g. a CamelCase webhook variant), the sanitiser
    // should normalise rather than fail validation.
    const env = createGithubEventEnvelope({
      source: SRC,
      event: "Issues",
      action: "Opened",
      deliveryId: "12345678-1234-4234-8234-123456789012",
      payload: {},
    });
    expect(env.type).toBe("github.issues.opened");
    const validation = validateEnvelope(env);
    expect(validation.ok).toBe(true);
  });
});

describe("github.* — classification parameterisation (IAW A.3)", () => {
  const baseOpts = {
    source: SRC,
    event: "pull_request",
    action: "opened",
    deliveryId: "12345678-1234-4234-8234-123456789012",
    payload: { number: 42 },
  };

  test("omitting classification defaults to local (principal-private)", () => {
    const env = createGithubEventEnvelope(baseOpts);
    expect(env.sovereignty.classification).toBe("local");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("classification: 'federated' flows into envelope.sovereignty", () => {
    const env = createGithubEventEnvelope({
      ...baseOpts,
      classification: "federated",
    });
    expect(env.sovereignty.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("classification: 'public' flows into envelope.sovereignty", () => {
    const env = createGithubEventEnvelope({
      ...baseOpts,
      classification: "public",
    });
    expect(env.sovereignty.classification).toBe("public");
    expect(validateEnvelope(env).ok).toBe(true);
  });
});
