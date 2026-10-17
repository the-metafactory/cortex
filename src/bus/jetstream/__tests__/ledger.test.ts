// glossary-ignore: run
import { describe, expect, mock, test } from "bun:test";
import { executionRunFinishedPattern, vigilAttentionResolvedPattern } from "@the-metafactory/myelin";
import { DeliverPolicy, RetentionPolicy, StorageType } from "nats";
import { DEFAULT_STREAM_MAX_BYTES } from "../../../common/types/cortex-config";
import { LEDGER_MAX_AGE_NS, LEDGER_STREAM, provisionLedgerStream, provisionStream } from "../provision";
import { createFakeJetStream } from "./fake-jetstream";

describe("LEDGER provisioning", () => {
  test("creates the bounded file ledger and is idempotent", async () => {
    const { jsm, publish } = createFakeJetStream();
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    expect(await provisionLedgerStream({ jsm, principal: "jc", log })).toBe("created");
    expect((await jsm.streams.info(LEDGER_STREAM)).config).toMatchObject({
      name: LEDGER_STREAM, subjects: [executionRunFinishedPattern("jc"), vigilAttentionResolvedPattern("jc")],
      retention: RetentionPolicy.Limits, storage: StorageType.File,
      max_age: 90 * 24 * 3600 * 1e9, max_bytes: DEFAULT_STREAM_MAX_BYTES,
    });
    expect(publish("local.jc.default.execution.run.finished")).toBe(LEDGER_STREAM);
    expect(await provisionLedgerStream({ jsm, principal: "jc", log })).toBe("exists");
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("adds missing subjects through the existing additive union", async () => {
    const fake = createFakeJetStream();
    await fake.jsm.streams.add({ name: LEDGER_STREAM, subjects: ["local.other.*.execution.run.finished"],
      retention: RetentionPolicy.Limits, max_age: LEDGER_MAX_AGE_NS });
    expect(await provisionLedgerStream({ jsm: fake.jsm, principal: "jc" })).toBe("subjects-extended");
    expect(fake.streamUpdates).toEqual([{ name: LEDGER_STREAM, subjects: [
      "local.other.*.execution.run.finished", executionRunFinishedPattern("jc"), vigilAttentionResolvedPattern("jc"),
    ] }]);
  });

  test("widens an existing run-only LEDGER in place without losing stored runs or its consumer", async () => {
    const fake = createFakeJetStream();
    const run = "local.example.default.execution.run.finished";
    await fake.jsm.streams.add({ name: LEDGER_STREAM, subjects: [executionRunFinishedPattern("example")], retention: RetentionPolicy.Limits, max_age: LEDGER_MAX_AGE_NS });
    fake.publish(run);
    await fake.jsm.consumers.add(LEDGER_STREAM, { durable_name: "existing", deliver_policy: DeliverPolicy.All });
    expect(await provisionLedgerStream({ jsm: fake.jsm, principal: "example" })).toBe("subjects-extended");
    const resolution = "local.example.default.vigil.attention.resolved";
    expect(fake.publish(resolution)).toBe(LEDGER_STREAM);
    expect(fake.pull(LEDGER_STREAM, "existing")).toEqual([run, resolution]);
    expect(fake.consumerDeletes).toEqual([]);
    expect(fake.streamUpdates).toHaveLength(1);
  });

  test.each(["max_age", "retention"] as const)("warns on %s drift without changing it", async (field) => {
    const fake = createFakeJetStream();
    await fake.jsm.streams.add({ name: LEDGER_STREAM, subjects: [executionRunFinishedPattern("jc"), vigilAttentionResolvedPattern("jc")],
      retention: field === "retention" ? RetentionPolicy.Interest : RetentionPolicy.Limits,
      max_age: field === "max_age" ? 100 : LEDGER_MAX_AGE_NS });
    const prior = (await fake.jsm.streams.info(LEDGER_STREAM)).config;
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    expect(await provisionLedgerStream({ jsm: fake.jsm, principal: "jc", log })).toBe("config-drift-warning");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain(field);
    expect((await fake.jsm.streams.info(LEDGER_STREAM)).config).toEqual(prior);
    expect(fake.streamUpdates).toEqual([]);
  });

  test("subject overlap and manager failures propagate", async () => {
    const fake = createFakeJetStream();
    await fake.jsm.streams.add({ name: "OTHER", subjects: [executionRunFinishedPattern("jc"), vigilAttentionResolvedPattern("jc")] });
    await expect(provisionLedgerStream({ jsm: fake.jsm, principal: "jc" })).rejects.toThrow("overlap");
    fake.jsm.streams.info = async () => { throw new Error("permission denied"); };
    await expect(provisionLedgerStream({ jsm: fake.jsm, principal: "jc" })).rejects.toThrow("permission denied");
  });
});

describe("provisionStream retention option", () => {
  test("a stream provisioned without an explicit retention is not retention-drift-checked", async () => {
    const fake = createFakeJetStream();
    await fake.jsm.streams.add({ name: "CODE_REVIEW", subjects: ["local.jc.default.tasks.code-review.*"],
      retention: RetentionPolicy.Limits, max_age: 24 * 3600 * 1e9 });
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    expect(await provisionStream({ jsm: fake.jsm, name: "CODE_REVIEW", subjects: ["local.jc.default.tasks.code-review.*"], log })).toBe("exists");
    expect(log.warn).not.toHaveBeenCalled();
    expect(await provisionStream({ jsm: fake.jsm, name: "NEW", subjects: ["x.>"], log })).toBe("created");
    expect((await fake.jsm.streams.info("NEW")).config.retention).toBe(RetentionPolicy.Interest);
  });
});
