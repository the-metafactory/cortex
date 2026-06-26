/**
 * cortex#338 (G-1111b) — provisioning helpers tests.
 *
 * The provisioning helpers wrap a narrow `ProvisionJsm` surface — tests
 * pass a recording stub so the idempotency, drift-detection, and
 * not-found-recovery contracts are pinned without standing up a real
 * JetStream broker. The full round-trip against a real broker is
 * #339's concern; this file owns the per-call shape.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACK_WAIT_NS,
  describeStreamDrift,
  isNotFoundError,
  provisionReviewConsumer,
  provisionReviewStream,
  type ProvisionJsm,
} from "../provision";
import type { ConsumerInfo, StreamInfo } from "nats";

// ---------------------------------------------------------------------------
// Test stubs
// ---------------------------------------------------------------------------

interface RecorderState {
  streamInfoCalls: string[];
  streamAddCalls: Partial<StreamInfo["config"]>[];
  consumerInfoCalls: { stream: string; durable: string }[];
  consumerAddCalls: { stream: string; cfg: Record<string, unknown> }[];
  consumerUpdateCalls: { stream: string; durable: string; cfg: Record<string, unknown> }[];
  consumerDeleteCalls: { stream: string; durable: string }[];
}

function makeJsm(opts: {
  existingStream?: StreamInfo | "not-found";
  existingConsumer?: ConsumerInfo | "not-found";
}): { jsm: ProvisionJsm; state: RecorderState } {
  const state: RecorderState = {
    streamInfoCalls: [],
    streamAddCalls: [],
    consumerInfoCalls: [],
    consumerAddCalls: [],
    consumerUpdateCalls: [],
    consumerDeleteCalls: [],
  };
  const jsm: ProvisionJsm = {
    streams: {
      info: async (name) => {
        state.streamInfoCalls.push(name);
        if (opts.existingStream === "not-found" || opts.existingStream === undefined) {
          // Mirror nats.js's 404 shape so isNotFoundError catches it.
          const err = new Error("stream not found");
          (err as unknown as { api_error: { err_code: number } }).api_error = {
            err_code: 10059,
          };
          throw err;
        }
        return opts.existingStream;
      },
      add: async (cfg) => {
        state.streamAddCalls.push(cfg);
        return { config: cfg } as unknown as StreamInfo;
      },
    },
    consumers: {
      info: async (stream, durable) => {
        state.consumerInfoCalls.push({ stream, durable });
        if (opts.existingConsumer === "not-found" || opts.existingConsumer === undefined) {
          const err = new Error("consumer not found");
          (err as unknown as { api_error: { err_code: number } }).api_error = {
            err_code: 10014,
          };
          throw err;
        }
        return opts.existingConsumer;
      },
      add: async (stream, cfg) => {
        state.consumerAddCalls.push({ stream, cfg });
        return { name: cfg.durable_name } as unknown as ConsumerInfo;
      },
      update: async (stream, durable, cfg) => {
        state.consumerUpdateCalls.push({ stream, durable, cfg });
        return { name: durable, config: cfg } as unknown as ConsumerInfo;
      },
      delete: async (stream, durable) => {
        state.consumerDeleteCalls.push({ stream, durable });
        return true;
      },
    },
  };
  return { jsm, state };
}

function silentLog() {
  return { info: (_: string) => {}, warn: (_: string) => {} };
}

// ---------------------------------------------------------------------------
// isNotFoundError
// ---------------------------------------------------------------------------

describe("isNotFoundError", () => {
  test("recognises nats.js api_error.err_code 10059 (stream not found)", () => {
    expect(
      isNotFoundError({
        api_error: { err_code: 10059 },
        message: "stream not found",
      }),
    ).toBe(true);
  });

  test("recognises nats.js api_error.err_code 10014 (consumer not found)", () => {
    expect(
      isNotFoundError({
        api_error: { err_code: 10014 },
        message: "consumer not found",
      }),
    ).toBe(true);
  });

  test("recognises message-string fallback `not found`", () => {
    expect(isNotFoundError(new Error("stream foo not found"))).toBe(true);
  });

  test("does NOT match transient errors that should propagate", () => {
    expect(isNotFoundError(new Error("connection refused"))).toBe(false);
    expect(isNotFoundError(new Error("auth failed"))).toBe(false);
  });

  test("returns false on non-error values (defensive)", () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError("string")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeStreamDrift
// ---------------------------------------------------------------------------

describe("describeStreamDrift", () => {
  function streamInfo(subjects: string[], maxAgeNs: number): StreamInfo {
    return {
      config: {
        subjects,
        max_age: maxAgeNs,
      },
    } as unknown as StreamInfo;
  }

  test("null when subjects and max_age match", () => {
    expect(
      describeStreamDrift(
        streamInfo(["a.b.>"], 24 * 3600 * 1e9),
        ["a.b.>"],
        24 * 3600 * 1e9,
      ),
    ).toBeNull();
  });

  test("null when subjects match as a set (order doesn't matter)", () => {
    // JetStream stream subjects are semantically a set — order is
    // implementation-detail on the wire. A live config that returns
    // the same set in a different order MUST NOT false-warn.
    expect(
      describeStreamDrift(
        streamInfo(["b.>", "a.>"], 24 * 3600 * 1e9),
        ["a.>", "b.>"],
        24 * 3600 * 1e9,
      ),
    ).toBeNull();
  });

  test("non-null when subjects differ", () => {
    expect(
      describeStreamDrift(
        streamInfo(["a.>"], 24 * 3600 * 1e9),
        ["b.>"],
        24 * 3600 * 1e9,
      ),
    ).toContain("subjects differ");
  });

  test("non-null when max_age drifts beyond 1s slack", () => {
    expect(
      describeStreamDrift(
        streamInfo(["a.>"], 24 * 3600 * 1e9),
        ["a.>"],
        12 * 3600 * 1e9, // half — drift far exceeds 1s slack
      ),
    ).toContain("max_age differs");
  });

  test("null when max_age drift is within 1s slack (wire-JSON rounding)", () => {
    // 500ms drift — should NOT trigger a warning, otherwise every
    // boot would warn on the same config.
    expect(
      describeStreamDrift(
        streamInfo(["a.>"], 24 * 3600 * 1e9 + 5e8),
        ["a.>"],
        24 * 3600 * 1e9,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// provisionReviewStream
// ---------------------------------------------------------------------------

describe("provisionReviewStream", () => {
  test("creates the stream when absent (returns 'created')", async () => {
    const { jsm, state } = makeJsm({ existingStream: "not-found" });
    const outcome = await provisionReviewStream({
      jsm,
      name: "CODE_REVIEW",
      subjects: ["local.jc.default.tasks.code-review.>"],
      log: silentLog(),
    });
    expect(outcome).toBe("created");
    expect(state.streamInfoCalls).toEqual(["CODE_REVIEW"]);
    expect(state.streamAddCalls.length).toBe(1);
    const cfg = state.streamAddCalls[0]!;
    expect(cfg.name).toBe("CODE_REVIEW");
    expect(cfg.subjects).toEqual(["local.jc.default.tasks.code-review.>"]);
    expect(String(cfg.retention)).toBe("interest");
    expect(String(cfg.storage)).toBe("file");
    expect(cfg.max_age).toBe(24 * 3600 * 1e9);
    // Finite max_bytes default — live deployment surfaced that NATS
    // accounts with storage-reservation caps reject max_bytes=-1
    // (unlimited) with "insufficient storage resources available".
    // cortex#1197: 64 MiB (was 512 MiB) so >2 control-plane streams fit
    // under the common `max_file: 1gb` JetStream cap (DEV_IMPLEMENT + release).
    expect(cfg.max_bytes).toBe(64 * 1024 * 1024);
  });

  test("honors maxBytes override", async () => {
    const { jsm, state } = makeJsm({ existingStream: "not-found" });
    await provisionReviewStream({
      jsm,
      name: "CODE_REVIEW",
      subjects: ["x.>"],
      maxBytes: 128 * 1024 * 1024,
      log: silentLog(),
    });
    expect(state.streamAddCalls[0]!.max_bytes).toBe(128 * 1024 * 1024);
  });

  test("idempotent — exists path returns 'exists' without calling add", async () => {
    const existing = {
      config: {
        name: "CODE_REVIEW",
        subjects: ["local.jc.default.tasks.code-review.>"],
        max_age: 24 * 3600 * 1e9,
      },
    } as unknown as StreamInfo;
    const { jsm, state } = makeJsm({ existingStream: existing });
    const outcome = await provisionReviewStream({
      jsm,
      name: "CODE_REVIEW",
      subjects: ["local.jc.default.tasks.code-review.>"],
      log: silentLog(),
    });
    expect(outcome).toBe("exists");
    expect(state.streamAddCalls.length).toBe(0);
  });

  test("config drift warns + leaves alone (v1 no-auto-update policy)", async () => {
    const existing = {
      config: {
        name: "CODE_REVIEW",
        subjects: ["local.OLD.default.tasks.code-review.>"], // diverged
        max_age: 24 * 3600 * 1e9,
      },
    } as unknown as StreamInfo;
    const warns: string[] = [];
    const { jsm, state } = makeJsm({ existingStream: existing });
    const outcome = await provisionReviewStream({
      jsm,
      name: "CODE_REVIEW",
      subjects: ["local.jc.default.tasks.code-review.>"],
      log: {
        info: () => {},
        warn: (msg) => {
          warns.push(msg);
        },
      },
    });
    expect(outcome).toBe("config-drift-warning");
    expect(state.streamAddCalls.length).toBe(0);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("config drifts");
    expect(warns[0]).toContain("nats stream edit"); // actionable hint
  });

  test("propagates non-404 errors (auth / network)", async () => {
    const { jsm } = makeJsm({});
    jsm.streams.info = async () => {
      throw new Error("auth required");
    };
    await expect(
      provisionReviewStream({
        jsm,
        name: "CODE_REVIEW",
        subjects: ["x.>"],
        log: silentLog(),
      }),
    ).rejects.toThrow(/auth required/);
  });
});

// ---------------------------------------------------------------------------
// provisionReviewConsumer
// ---------------------------------------------------------------------------

describe("provisionReviewConsumer", () => {
  test("creates the durable when absent (returns 'created')", async () => {
    const { jsm, state } = makeJsm({ existingConsumer: "not-found" });
    const outcome = await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      log: silentLog(),
    });
    expect(outcome).toBe("created");
    expect(state.consumerInfoCalls).toEqual([
      { stream: "CODE_REVIEW", durable: "cortex-review-consumer-jc-sage" },
    ]);
    expect(state.consumerAddCalls.length).toBe(1);
    const cfg = state.consumerAddCalls[0]!.cfg;
    expect(cfg.durable_name).toBe("cortex-review-consumer-jc-sage");
    expect(cfg.ack_policy).toBe("explicit");
    expect(cfg.deliver_policy).toBe("all");
    expect(cfg.max_deliver).toBe(5);
    // cortex#422 — ack_wait must be set on create (else JetStream's 30s
    // default redelivers mid-review → duplicate review + post).
    expect(cfg.ack_wait).toBe(DEFAULT_ACK_WAIT_NS);
    // No filter subject when not requested.
    expect("filter_subject" in cfg).toBe(false);
  });

  test("cortex#1186 — filterSubject is applied to the durable config on create", async () => {
    const { jsm, state } = makeJsm({ existingConsumer: "not-found" });
    const outcome = await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      filterSubject: "local.jc.clawbox.tasks.code-review.>",
      log: silentLog(),
    });
    expect(outcome).toBe("created");
    expect(state.consumerAddCalls[0]!.cfg.filter_subject).toBe(
      "local.jc.clawbox.tasks.code-review.>",
    );
  });

  test("cortex#1186 — filter drift (durable created without filter) → delete + recreate with the filter", async () => {
    // Pre-fix durable: created with no filter_subject (claims every message).
    const existing = {
      name: "cortex-review-consumer-jc-sage",
      config: { ack_wait: DEFAULT_ACK_WAIT_NS, filter_subject: "" },
    } as unknown as ConsumerInfo;
    const { jsm, state } = makeJsm({ existingConsumer: existing });
    const outcome = await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      filterSubject: "local.jc.clawbox.tasks.code-review.>",
      log: silentLog(),
    });
    // filter_subject is immutable → delete + recreate, not an in-place update.
    expect(outcome).toBe("created");
    expect(state.consumerDeleteCalls).toEqual([
      { stream: "CODE_REVIEW", durable: "cortex-review-consumer-jc-sage" },
    ]);
    expect(state.consumerUpdateCalls.length).toBe(0);
    expect(state.consumerAddCalls.length).toBe(1);
    expect(state.consumerAddCalls[0]!.cfg.filter_subject).toBe(
      "local.jc.clawbox.tasks.code-review.>",
    );
    // The recreated durable must start from `New`, NOT replay the backlog —
    // a migration must not re-review + re-post every historical PR (cortex#1186).
    expect(state.consumerAddCalls[0]!.cfg.deliver_policy).toBe("new");
  });

  test("cortex#1186 — matching filter + drifted ack_wait → update in place, NO delete/recreate", async () => {
    const existing = {
      name: "cortex-review-consumer-jc-sage",
      config: { ack_wait: 30_000_000_000, filter_subject: "local.jc.clawbox.tasks.code-review.>" },
    } as unknown as ConsumerInfo;
    const { jsm, state } = makeJsm({ existingConsumer: existing });
    const outcome = await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      filterSubject: "local.jc.clawbox.tasks.code-review.>",
      log: silentLog(),
    });
    expect(outcome).toBe("updated");
    expect(state.consumerDeleteCalls.length).toBe(0);
    expect(state.consumerAddCalls.length).toBe(0);
    expect(state.consumerUpdateCalls.length).toBe(1);
  });

  test("idempotent — exists path with matching ack_wait returns 'exists' without add/update", async () => {
    const existing = {
      name: "cortex-review-consumer-jc-sage",
      config: { ack_wait: DEFAULT_ACK_WAIT_NS },
    } as unknown as ConsumerInfo;
    const { jsm, state } = makeJsm({ existingConsumer: existing });
    const outcome = await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      log: silentLog(),
    });
    expect(outcome).toBe("exists");
    expect(state.consumerAddCalls.length).toBe(0);
    expect(state.consumerUpdateCalls.length).toBe(0);
  });

  test("cortex#422 — exists with drifted ack_wait returns 'updated' and reconciles in place", async () => {
    // Simulate the pre-fix durable: created without ack_wait → JetStream's
    // 30s default (30_000_000_000 ns).
    const existing = {
      name: "cortex-review-consumer-jc-sage",
      config: { ack_wait: 30_000_000_000, max_deliver: 5 },
    } as unknown as ConsumerInfo;
    const { jsm, state } = makeJsm({ existingConsumer: existing });
    const outcome = await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      log: silentLog(),
    });
    expect(outcome).toBe("updated");
    expect(state.consumerAddCalls.length).toBe(0);
    expect(state.consumerUpdateCalls.length).toBe(1);
    const upd = state.consumerUpdateCalls[0]!;
    expect(upd.stream).toBe("CODE_REVIEW");
    expect(upd.durable).toBe("cortex-review-consumer-jc-sage");
    expect(upd.cfg.ack_wait).toBe(DEFAULT_ACK_WAIT_NS);
    // Existing config fields are preserved through the update spread.
    expect(upd.cfg.max_deliver).toBe(5);
  });

  test("cortex#422 — custom ackWaitNs is honored on create", async () => {
    const { jsm, state } = makeJsm({ existingConsumer: "not-found" });
    await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "x",
      ackWaitNs: 90_000_000_000,
      log: silentLog(),
    });
    expect(state.consumerAddCalls[0]!.cfg.ack_wait).toBe(90_000_000_000);
  });

  test("filter_subject is set when supplied", async () => {
    const { jsm, state } = makeJsm({ existingConsumer: "not-found" });
    await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-jc-sage",
      filterSubject: "local.jc.default.tasks.code-review.typescript",
      log: silentLog(),
    });
    const cfg = state.consumerAddCalls[0]!.cfg;
    expect(cfg.filter_subject).toBe(
      "local.jc.default.tasks.code-review.typescript",
    );
  });

  test("maxDeliver override is honored", async () => {
    const { jsm, state } = makeJsm({ existingConsumer: "not-found" });
    await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "x",
      maxDeliver: 10,
      log: silentLog(),
    });
    expect(state.consumerAddCalls[0]!.cfg.max_deliver).toBe(10);
  });

  test("propagates non-404 errors", async () => {
    const { jsm } = makeJsm({});
    jsm.consumers.info = async () => {
      throw new Error("network down");
    };
    await expect(
      provisionReviewConsumer({
        jsm,
        stream: "CODE_REVIEW",
        durable: "x",
        log: silentLog(),
      }),
    ).rejects.toThrow(/network down/);
  });
});
