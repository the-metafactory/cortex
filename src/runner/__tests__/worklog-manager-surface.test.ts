/**
 * MIG-4.7 — tests for the WorklogManager bus-driven `surfaceConfig` getter.
 *
 * Coverage:
 *   1. surfaceConfig shape — id, subjects (org-substituted), render is a
 *      function bound to the WorklogManager instance.
 *   2. Started envelope → channel.send + startThread + thread.send invocations.
 *   3. Completed envelope (after started) → thread.send + thread.setArchived,
 *      plus channel.send for the channel-level summary line.
 *   4. Failed envelope → analogous to completed but with the error_summary.
 *   5. Aborted envelope → analogous; reason rendered.
 *   6. Malformed envelope (missing task_id) → no Discord API calls.
 *   7. Backwards compatibility — the existing direct-call API still works
 *      after surfaceConfig is wired (additive contract).
 *
 * Discord client is faked — no real Discord traffic. The fake records
 * every call so tests assert on the sequence.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import type { Client, TextChannel, ThreadChannel } from "discord.js";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import { WorklogManager } from "../worklog-manager";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
} from "../../bus/dispatch-events";

// ---------------------------------------------------------------------------
// Fake Discord client
// ---------------------------------------------------------------------------

interface FakeThread {
  id: string;
  name: string;
  sent: string[];
  archived: boolean;
}

interface FakeCalls {
  channelSent: string[];
  threadsCreated: FakeThread[];
}

function makeFakeClient(channelId: string): { client: Client; calls: FakeCalls } {
  const calls: FakeCalls = { channelSent: [], threadsCreated: [] };
  const threadsById = new Map<string, FakeThread>();

  const fakeChannel = {
    id: channelId,
    send: async (content: string) => {
      calls.channelSent.push(content);
      // The direct-call path expects startMsg.startThread() to be available.
      const startMsg: {
        startThread: (opts: { name: string; autoArchiveDuration?: number }) => Promise<FakeThread>;
      } = {
        startThread: async (opts) => {
          const thread: FakeThread = {
            id: `thread-${threadsById.size + 1}`,
            name: opts.name,
            sent: [],
            archived: false,
            // ThreadChannel API surface used by worklog-manager:
            send: async (msg: string) => { thread.sent.push(msg); },
            setArchived: async (val: boolean) => { thread.archived = val; },
          } as FakeThread & {
            send: (msg: string) => Promise<void>;
            setArchived: (val: boolean) => Promise<void>;
          };
          threadsById.set(thread.id, thread);
          calls.threadsCreated.push(thread);
          return thread;
        },
      };
      return startMsg;
    },
  } as unknown as TextChannel;

  const client = {
    channels: {
      fetch: async (id: string) => {
        if (id === channelId) return fakeChannel;
        const thread = threadsById.get(id);
        if (thread) return thread as unknown as ThreadChannel;
        return null;
      },
    },
  } as unknown as Client;

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCE = { org: "metafactory", agent: "cortex", instance: "local" };
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = new Date("2026-05-09T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-05-09T12:00:30.000Z");

function makeStarted(): Envelope {
  return createDispatchTaskStartedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
  });
}

function makeCompleted(): Envelope {
  return createDispatchTaskCompletedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    resultSummary: "Built the thing",
  });
}

function makeFailed(): Envelope {
  return createDispatchTaskFailedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
    failedAt: COMPLETED_AT,
    errorSummary: "exit 1",
  });
}

function makeAborted(): Envelope {
  return createDispatchTaskAbortedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
    abortedAt: COMPLETED_AT,
    reason: "timeout",
  });
}

// ---------------------------------------------------------------------------
// surfaceConfig shape
// ---------------------------------------------------------------------------

describe("WorklogManager.surfaceConfig — shape", () => {
  test("default subject pattern uses org placeholder substitution", () => {
    const { client } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });
    expect(cfg.subjects).toEqual(["local.metafactory.dispatch.task.>"]);
    expect(cfg.id).toBe("worklog-manager");
  });

  test("custom adapter id honored", () => {
    const { client } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory", adapterId: "worklog-test" });
    expect(cfg.id).toBe("worklog-test");
  });

  test("render function exists and returns a Promise", () => {
    const { client } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });
    expect(typeof cfg.render).toBe("function");
    const result = cfg.render(makeStarted());
    expect(result).toBeInstanceOf(Promise);
    return result; // settle the promise so test framework doesn't warn
  });
});

// ---------------------------------------------------------------------------
// Lifecycle rendering
// ---------------------------------------------------------------------------

describe("WorklogManager.surfaceConfig — started envelope", () => {
  test("creates a thread and posts opening line", async () => {
    const { client, calls } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });

    await cfg.render(makeStarted());

    // Channel got the start message
    expect(calls.channelSent).toHaveLength(1);
    expect(calls.channelSent[0]).toContain("started task");
    expect(calls.channelSent[0]).toContain(TASK_ID.slice(0, 8));
    // A thread was created
    expect(calls.threadsCreated).toHaveLength(1);
    const thread = calls.threadsCreated[0]!;
    expect(thread.name).toContain(TASK_ID.slice(0, 8));
    // Thread got an opening message
    expect(thread.sent).toHaveLength(1);
    expect(thread.sent[0]).toContain("started");
  });
});

describe("WorklogManager.surfaceConfig — completed envelope", () => {
  test("after started, posts completion to thread + channel summary", async () => {
    const { client, calls } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });

    await cfg.render(makeStarted());
    const initialChannelLen = calls.channelSent.length;
    await cfg.render(makeCompleted());

    // Thread received a completion line
    const thread = calls.threadsCreated[0]!;
    expect(thread.sent.length).toBeGreaterThanOrEqual(2);
    expect(thread.sent[thread.sent.length - 1]).toContain("completed");
    expect(thread.sent[thread.sent.length - 1]).toContain("Built the thing");
    // Thread is archived
    expect(thread.archived).toBe(true);
    // Channel got a summary line
    expect(calls.channelSent.length).toBeGreaterThan(initialChannelLen);
    const lastChannelMsg = calls.channelSent[calls.channelSent.length - 1]!;
    expect(lastChannelMsg).toContain("completed");
    // Channel summary is one line — does NOT include the multi-line result_summary
    expect(lastChannelMsg).not.toContain("Built the thing");
  });
});

describe("WorklogManager.surfaceConfig — failed envelope", () => {
  test("after started, posts failure with error_summary", async () => {
    const { client, calls } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });

    await cfg.render(makeStarted());
    await cfg.render(makeFailed());

    const thread = calls.threadsCreated[0]!;
    expect(thread.sent[thread.sent.length - 1]).toContain("failed");
    expect(thread.sent[thread.sent.length - 1]).toContain("exit 1");
    expect(thread.archived).toBe(true);
  });
});

describe("WorklogManager.surfaceConfig — aborted envelope", () => {
  test("after started, posts abort with reason", async () => {
    const { client, calls } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });

    await cfg.render(makeStarted());
    await cfg.render(makeAborted());

    const thread = calls.threadsCreated[0]!;
    expect(thread.sent[thread.sent.length - 1]).toContain("aborted");
    expect(thread.sent[thread.sent.length - 1]).toContain("timeout");
    expect(thread.archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("WorklogManager.surfaceConfig — malformed envelope", () => {
  test("envelope with no payload.task_id → no Discord API calls", async () => {
    const { client, calls } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });

    const malformed: Envelope = {
      id: "00000000-0000-4000-8000-000000000000",
      source: "metafactory.cortex.local",
      type: "dispatch.task.started",
      timestamp: "2026-05-09T12:00:00Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: { agent_id: "cortex" }, // no task_id
    };
    await cfg.render(malformed);
    expect(calls.channelSent).toHaveLength(0);
    expect(calls.threadsCreated).toHaveLength(0);
  });

  test("unknown dispatch sub-type → silent ignore (forward compatibility)", async () => {
    const { client, calls } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    const cfg = wlm.surfaceConfig({ org: "metafactory" });

    const unknown: Envelope = {
      id: "00000000-0000-4000-8000-000000000000",
      source: "metafactory.cortex.local",
      type: "dispatch.task.future-action",
      timestamp: "2026-05-09T12:00:00Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: { task_id: TASK_ID, agent_id: "cortex" },
    };
    await cfg.render(unknown);
    // No thread created, no channel message — graceful no-op
    expect(calls.channelSent).toHaveLength(0);
    expect(calls.threadsCreated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility — the direct-call API still works
// ---------------------------------------------------------------------------

describe("WorklogManager — direct-call API still works after surfaceConfig", () => {
  test("handleEvent (PublishedEvent path) is unchanged", async () => {
    const { client } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    // Building a surfaceConfig must not break the direct-call path.
    void wlm.surfaceConfig({ org: "metafactory" });

    // The handleEvent method should still exist and accept PublishedEvent.
    expect(typeof wlm.handleEvent).toBe("function");
  });

  test("cleanupStaleSessions still functional", () => {
    const { client } = makeFakeClient("worklog-channel-id");
    const wlm = new WorklogManager(client, "worklog-channel-id");
    void wlm.surfaceConfig({ org: "metafactory" });
    // No active sessions → returns 0
    expect(wlm.cleanupStaleSessions()).toBe(0);
  });
});
