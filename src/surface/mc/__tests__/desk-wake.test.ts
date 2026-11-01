import { describe, expect, it } from "bun:test";
import { DeskWakeSchema, WAKE_BPE_SHA, wakeConfigurationError } from "../../../common/types/desk-wake";
import { WakeBuffer, CommandEndpoint, withoutWakePhrase } from "../dashboard-v2/lib/desk-wake-buffer";
import { wakeAssetResponse } from "../desk/wake-assets";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

describe("Desk local wake", () => {
  it("is opt-in and refuses a label without provisioned matched tokens", () => {
    expect(DeskWakeSchema.parse({}).enabled).toBe(false);
    expect(wakeConfigurationError(DeskWakeSchema.parse({ phrase: "Hey Ivy" }))).toContain("Provision");
    expect(wakeConfigurationError(DeskWakeSchema.parse({ phrase: "Hey Ivy", tokens: ["▁HE", "Y", "▁I", "V", "Y"], tokenizerSha256: WAKE_BPE_SHA }))).toBeNull();
    expect(wakeConfigurationError(DeskWakeSchema.parse({ phrase: "Hey Ivy", tokens: ["▁OTHER"], tokenizerSha256: WAKE_BPE_SHA }))).toContain("differ");
    expect(DeskWakeSchema.safeParse({ preRollMs: 999999 }).success).toBe(false);
  });
  it("keeps only bounded recent PCM without detaching source frames", () => {
    const ring = new WakeBuffer(5);
    const first = Float32Array.of(1, 2, 3);
    ring.push(first); first[0] = 99;
    ring.push(Float32Array.of(4, 5, 6, 7));
    expect([...ring.take()]).toEqual([3, 4, 5, 6, 7]);
    ring.clear(); expect(ring.take().length).toBe(0);
  });
  it("bounds worklet messages while the page is suspended and reports lost audio on resume", () => {
    const messages: unknown[] = [];
    class Processor {
      port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (message: unknown) => messages.push(message) };
    }
    type Capture = Processor & { process(inputs: Float32Array[][]): boolean };
    const factories: (new () => Capture)[] = [];
    runInNewContext(readFileSync(join(import.meta.dir, "../../../../scripts/desk-wake/capture.js"), "utf8"), {
      AudioWorkletProcessor: Processor,
      Float32Array,
      registerProcessor: (_name: string, factory: new () => Capture) => factories.push(factory),
    });
    const Factory = factories[0];
    if (!Factory) throw new Error("Capture processor was not registered");
    const processor = new Factory();
    for (let i = 0; i < 20; i++) processor.process([[new Float32Array(2048)]]);
    expect(messages.length).toBe(8);
    processor.port.onmessage?.({ data: "ack" });
    processor.process([[new Float32Array(2048)]]);
    expect(messages.length).toBe(9);
    expect(messages.at(-1)).toMatchObject({ dropped: 12 * 2048 });
  });
  it("endpoints on silence and maximum duration and discards no speech", () => {
    const options = { silenceMs: 500, maxCommandMs: 3000, speechThreshold: 0.01 };
    const speech = new Float32Array(1000).fill(0.1);
    const quiet = new Float32Array(1000);
    const end = new CommandEndpoint(options);
    expect(end.push(speech, 1000)).toBe("continue");
    expect(end.push(quiet, 1000)).toBe("complete");
    const long = new CommandEndpoint(options);
    expect(long.push(speech, 1000)).toBe("continue");
    expect(long.push(speech, 1000)).toBe("continue");
    expect(long.push(speech, 1000)).toBe("complete");
    const empty = new CommandEndpoint(options);
    empty.push(quiet, 1000); empty.push(quiet, 1000);
    expect(empty.push(quiet, 1000)).toBe("empty");
  });
  it("strips only the configured leading wake phrase", () => {
    expect(withoutWakePhrase("Hey, Ivy! what needs me?", "Hey Ivy")).toBe("what needs me?");
    expect(withoutWakePhrase("hey ivy", "Hey Ivy")).toBe("");
    expect(withoutWakePhrase("Who said Hey Ivy?", "Hey Ivy")).toBe("Who said Hey Ivy?");
  });
  it("does not serve arbitrary files or configuration through wake assets", async () => {
    for (const path of ["/wake/../desk.yaml", "/wake/.env", "/wake/vendor/unknown.js"]) expect((await wakeAssetResponse(path, "/unreadable")).status).toBe(404);
    expect((await wakeAssetResponse("/wake/runtime.wasm", "/unreadable")).status).toBe(503);
  });
});
