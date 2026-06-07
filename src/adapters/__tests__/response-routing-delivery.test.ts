import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  deliverRoutedResponse,
  readLogicalRouting,
  readResponseRouting,
} from "../response-routing-delivery";
import type { ResponseTarget } from "../types";

function envelope(
  type: string,
  payload: Record<string, unknown>,
  correlationId = "corr-1",
): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    source: "metafactory.runner.local",
    type,
    timestamp: "2026-05-09T12:00:00Z",
    correlation_id: correlationId,
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload,
  };
}

describe("response-routing-delivery", () => {
  test("parses snowflake and logical response routing shapes", () => {
    expect(
      readResponseRouting(
        envelope("dispatch.task.completed", {
          response_routing: {
            adapter_instance: "discord-pai",
            channel_id: "C123",
            thread_id: "T456",
          },
        }),
      ),
    ).toEqual({
      adapter_instance: "discord-pai",
      channel_id: "C123",
      thread_id: "T456",
    });

    expect(
      readLogicalRouting(
        envelope("review.verdict.approved", {
          response_routing: {
            surface: "discord",
            channel: "cortex",
            thread: "cortex/pr/57",
          },
        }),
      ),
    ).toEqual({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/pr/57",
    });

    expect(
      readResponseRouting(
        envelope("dispatch.task.completed", {
          response_routing: { surface: "discord", channel: "cortex" },
        }),
      ),
    ).toBeNull();
    expect(
      readLogicalRouting(
        envelope("review.verdict.approved", {
          response_routing: { adapter_instance: "discord-pai", channel_id: "C123" },
        }),
      ),
    ).toBeNull();
  });

  test("started sends progress with correlation key, terminal clears then posts", async () => {
    const calls: string[] = [];
    const adapter = {
      sendProgress: async (target: ResponseTarget, text: string): Promise<void> => {
        calls.push(`progress:${target.sessionId ?? ""}:${text}`);
      },
      clearProgress: async (target: ResponseTarget): Promise<void> => {
        calls.push(`clear:${target.sessionId ?? ""}`);
      },
      postResponse: async (target: ResponseTarget, text: string): Promise<void> => {
        calls.push(`post:${target.sessionId ?? ""}:${text}`);
      },
    };
    const target: ResponseTarget = {
      instanceId: "discord-pai",
      channelId: "C123",
      threadId: "T456",
    };
    const errors: unknown[] = [];

    await deliverRoutedResponse({
      envelope: envelope("dispatch.task.started", {}, "task-A"),
      adapter,
      target,
      text: "Luna is working...",
      onError: (err) => { errors.push(err); },
    });
    await deliverRoutedResponse({
      envelope: envelope("dispatch.task.completed", {}, "task-A"),
      adapter,
      target,
      text: "done",
      onError: (err) => { errors.push(err); },
    });

    expect(calls).toEqual([
      "progress:task-A:Luna is working...",
      "clear:task-A",
      "post::done",
    ]);
    expect(errors).toHaveLength(0);
  });

  test("delivery failures are reported through onError without throwing", async () => {
    const err = new Error("rate limited");
    const adapter = {
      sendProgress: async (): Promise<void> => {},
      clearProgress: async (): Promise<void> => {},
      postResponse: async (): Promise<void> => {
        throw err;
      },
    };
    const errors: unknown[] = [];

    await expect(
      deliverRoutedResponse({
        envelope: envelope("dispatch.task.completed", {}),
        adapter,
        target: { instanceId: "discord-pai", channelId: "C123" },
        text: "done",
        onError: (seen) => { errors.push(seen); },
      }),
    ).resolves.toBeUndefined();
    expect(errors).toEqual([err]);
  });
});
