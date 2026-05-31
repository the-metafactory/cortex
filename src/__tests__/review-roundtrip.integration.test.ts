/**
 * cortex#339 / G-1111c — live JetStream smoke.
 *
 * Starts an isolated `nats-server -js`, provisions the CODE_REVIEW stream and
 * durable, binds a real MyelinRuntime pull subscriber, publishes one
 * sage-shaped `tasks.code-review.typescript` request, and observes the
 * lifecycle + verdict envelopes on the broker.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createServer } from "net";
import {
  connect,
  StringCodec,
  type ConsumerInfo,
  type NatsConnection,
  type Subscription,
} from "nats";
import type { AgentConfig } from "../common/types/config";
import type { Envelope } from "../bus/myelin/envelope-validator";
import {
  startMyelinRuntime,
  type MyelinRuntime,
} from "../bus/myelin/runtime";
import {
  provisionReviewConsumer,
  provisionReviewStream,
} from "../bus/jetstream/provision";
import { ReviewConsumer, type ReviewConsumerAgent } from "../bus/review-consumer";
import {
  createReviewRequestEvent,
  createReviewVerdictEvent,
  type ReviewEventSource,
  type ReviewRequestPayload,
} from "../bus/review-events";
import type {
  ReviewPipelineOpts,
  ReviewPipelineResult,
} from "../runner/review-pipeline";
import type { CCSessionFactory } from "../substrates/claude-code/harness";

const NATS_SERVER = Bun.which("nats-server");
const maybeDescribe = NATS_SERVER ? describe : describe.skip;
const sc = StringCodec();

interface NatsServerHandle {
  url: string;
  proc: ChildProcessWithoutNullStreams;
  storeDir: string;
  logs: string[];
  stop: () => Promise<void>;
}

const SOURCE: ReviewEventSource = {
  principal: "test-op",
  agent: "cortex",
  instance: "integration",
};

const VALID_PAYLOAD: ReviewRequestPayload = {
  repo: "the-metafactory/cortex",
  pr: 339,
  reviewer: "echo",
  feature: "G-1111c",
  title: "test: review roundtrip integration",
  cycle: 1,
};

function makeConfig(url: string): AgentConfig {
  return {
    agent: {
      name: "cortex",
      displayName: "Cortex",
      dataResidency: "NZ",
    },
    nats: {
      url,
      name: "cortex-review-roundtrip-test",
      subjects: [],
    },
  } as unknown as AgentConfig;
}

const stubCcFactory: CCSessionFactory = () => {
  throw new Error("integration test pipelineRunner should not spawn Claude Code");
};

function buildVerdictEnvelope(request: Envelope): Envelope {
  return createReviewVerdictEvent({
    source: SOURCE,
    kind: "approved",
    correlationId: request.id,
    payload: {
      repo: VALID_PAYLOAD.repo,
      pr: VALID_PAYLOAD.pr,
      reviewer: "echo",
      verdict: "approved",
      summary: "integration smoke approved",
      github_review_id: 1,
      github_review_url: "https://github.com/example/repo/pull/1#pullrequestreview-1",
      commit_id: "0000000000000000000000000000000000000000",
      findings: { blockers: 0, majors: 0, nits: 0 },
      inline_comments: 0,
      submitted_at: "2026-05-19T00:00:00Z",
    },
  });
}

async function getOpenPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function startNatsServer(): Promise<NatsServerHandle> {
  if (!NATS_SERVER) {
    throw new Error("nats-server not found on PATH");
  }
  const port = await getOpenPort();
  const storeDir = join(tmpdir(), `cortex-nats-${crypto.randomUUID()}`);
  mkdirSync(storeDir, { recursive: true });
  const logs: string[] = [];
  const proc = spawn(NATS_SERVER, [
    "-js",
    "-p",
    String(port),
    "-sd",
    storeDir,
  ]);
  proc.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const url = `nats://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 80; attempt++) {
    if (proc.exitCode !== null) {
      throw new Error(`nats-server exited early:\n${logs.join("")}`);
    }
    try {
      const nc = await connect({
        servers: url,
        name: "cortex-review-roundtrip-readiness",
        reconnect: false,
        timeout: 500,
      });
      await nc.close();
      return {
        url,
        proc,
        storeDir,
        logs,
        stop: () => stopNatsServer(proc, storeDir),
      };
    } catch {
      await sleep(50);
    }
  }
  proc.kill("SIGTERM");
  throw new Error(`nats-server did not become ready:\n${logs.join("")}`);
}

async function stopNatsServer(
  proc: ChildProcessWithoutNullStreams,
  storeDir: string,
): Promise<void> {
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => proc.once("exit", () => resolve())),
      sleep(2_000).then(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }),
    ]);
  }
  if (existsSync(storeDir)) {
    rmSync(storeDir, { recursive: true, force: true });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  describeFailure: () => string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(describeFailure());
}

function collectEnvelopes(sub: Subscription, sink: Envelope[]): Promise<void> {
  return (async () => {
    for await (const msg of sub) {
      sink.push(JSON.parse(sc.decode(msg.data)) as Envelope);
    }
  })();
}

function consumerAckFloor(info: ConsumerInfo): number {
  return info.ack_floor?.consumer_seq ?? 0;
}

maybeDescribe("cortex#339 — live JetStream review round-trip", () => {
  let server: NatsServerHandle;
  let nc: NatsConnection;
  let runtime: MyelinRuntime;
  let consumer: ReviewConsumer;
  let observedSub: Subscription;
  let observedLoop: Promise<void>;
  const observed: Envelope[] = [];

  beforeAll(async () => {
    server = await startNatsServer();
    nc = await connect({
      servers: server.url,
      name: "cortex-review-roundtrip-observer",
      reconnect: false,
    });
    observedSub = nc.subscribe("local.test-op.default.>");
    observedLoop = collectEnvelopes(observedSub, observed);

    runtime = await startMyelinRuntime(makeConfig(server.url), {
      stack: "default",
    });
    expect(runtime.enabled).toBe(true);

    const jsm = await runtime.jetstreamManager?.();
    expect(jsm).not.toBeNull();
    expect(jsm).not.toBeUndefined();
    if (!jsm) throw new Error("JetStream manager unavailable");

    await provisionReviewStream({
      jsm,
      name: "CODE_REVIEW",
      subjects: ["local.test-op.default.tasks.code-review.>"],
    });
    await provisionReviewConsumer({
      jsm,
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-test-op-echo",
    });

    const agent: ReviewConsumerAgent = {
      id: "echo",
      capabilities: ["code-review.typescript"],
    };
    consumer = new ReviewConsumer({
      agent,
      source: SOURCE,
      runtime,
      ccSessionFactory: stubCcFactory,
      promptBuilder: ({ payload }) => `/review ${payload.repo}#${payload.pr}`,
      pipelineRunner: async (
        opts: ReviewPipelineOpts,
      ): Promise<ReviewPipelineResult> => ({
        kind: "verdict",
        envelope: buildVerdictEnvelope(opts.requestEnvelope),
      }),
    });
    const started = await consumer.start({
      pattern: "local.test-op.default.tasks.code-review.>",
      stream: "CODE_REVIEW",
      durable: "cortex-review-consumer-test-op-echo",
    });
    expect(started.subscribed).toBe(true);
    await nc.flush();
  });

  afterAll(async () => {
    await consumer?.stop();
    await runtime?.stop();
    observedSub?.drain();
    await observedLoop?.catch(() => undefined);
    await nc?.close();
    await server?.stop();
  });

  test("sage-shaped task is claimed and produces started, completed, and verdict envelopes", async () => {
    const jsm = await runtime.jetstreamManager?.();
    if (!jsm) throw new Error("JetStream manager unavailable");

    const before = await jsm.consumers.info(
      "CODE_REVIEW",
      "cortex-review-consumer-test-op-echo",
    );
    const request = createReviewRequestEvent({
      source: { principal: "test-op", agent: "sage", instance: "dispatch" },
      flavor: "typescript",
      payload: VALID_PAYLOAD,
    });
    nc.publish(
      "local.test-op.default.tasks.code-review.typescript",
      sc.encode(JSON.stringify(request)),
    );
    await nc.flush();

    await waitFor(
      () => {
        const types = observed
          .filter((e) => e.correlation_id === request.id)
          .map((e) => e.type);
        return (
          types.includes("dispatch.task.started") &&
          types.includes("dispatch.task.completed") &&
          types.includes("review.verdict.approved")
        );
      },
      () =>
        `timed out waiting for round-trip envelopes; observed=${JSON.stringify(
          observed.map((e) => ({
            type: e.type,
            correlation_id: e.correlation_id,
          })),
        )}\nnats-server logs:\n${server.logs.join("")}`,
    );

    const emitted = observed.filter((e) => e.correlation_id === request.id);
    expect(emitted.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
    for (const envelope of emitted) {
      expect(envelope.correlation_id).toBe(request.id);
    }
    const verdict = emitted.find((e) => e.type === "review.verdict.approved");
    expect(verdict?.payload).toMatchObject({
      repo: "the-metafactory/cortex",
      pr: 339,
      reviewer: "echo",
      verdict: "approved",
    });

    await waitFor(
      async () => {
        const after = await jsm.consumers.info(
          "CODE_REVIEW",
          "cortex-review-consumer-test-op-echo",
        );
        return consumerAckFloor(after) > consumerAckFloor(before);
      },
      () => "consumer ack floor did not advance after review task",
    );
    const after = await jsm.consumers.info(
      "CODE_REVIEW",
      "cortex-review-consumer-test-op-echo",
    );
    expect(consumerAckFloor(after)).toBeGreaterThan(consumerAckFloor(before));
    expect(after.num_ack_pending).toBe(0);
  });
});
