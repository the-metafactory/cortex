/**
 * cortex#1503 — provisioning when two stacks of one principal share a NATS
 * account (`$G`, or a single agents account).
 *
 * Covers the two halves of the fix against the in-memory JetStream fake:
 *  - the fixed-name stream gains each stack's subjects by additive union
 *    (previously the second stack hit the drift warning and its subjects were
 *    never stored — the 111 "config drifts" lines);
 *  - the legacy unscoped durable is migrated without replay or loss when it is
 *    provably this stack's, and left untouched otherwise.
 */

import { describe, expect, test } from "bun:test";
import { DeliverPolicy } from "nats";
import { provisionReviewConsumer, provisionReviewStream } from "../provision";
import { createFakeJetStream } from "./fake-jetstream";

const DEFAULT_PAT = "local.alice.default.tasks.code-review.*";
const WORK_PAT = "local.alice.work.tasks.code-review.*";
const LEGACY = "cortex-review-consumer-alice-sage";
const SCOPED_DEFAULT = "cortex-review-consumer-alice_default-sage";

function recordingLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    log: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) },
  };
}

describe("provisionReviewStream — shared stream across stacks (cortex#1503)", () => {
  test("the second stack's subjects join the stream by additive union", async () => {
    const js = createFakeJetStream();
    const a = recordingLog();
    const b = recordingLog();
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [DEFAULT_PAT], log: a.log }),
    ).toBe("created");
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [WORK_PAT], log: b.log }),
    ).toBe("subjects-extended");

    expect(js.streamSubjects("CODE_REVIEW").sort()).toEqual([DEFAULT_PAT, WORK_PAT].sort());
    expect(b.warn).toEqual([]);
    // Both stacks' requests are now stored.
    expect(js.publish("local.alice.default.tasks.code-review.typescript")).toBe("CODE_REVIEW");
    expect(js.publish("local.alice.work.tasks.code-review.typescript")).toBe("CODE_REVIEW");
  });

  test("re-provisioning either stack afterwards writes nothing (no boot-to-boot fight)", async () => {
    const js = createFakeJetStream();
    await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [DEFAULT_PAT], log: recordingLog().log });
    await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [WORK_PAT], log: recordingLog().log });
    const updatesBefore = js.streamUpdates.length;
    for (const pat of [DEFAULT_PAT, WORK_PAT, DEFAULT_PAT]) {
      const r = recordingLog();
      expect(
        await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [pat], log: r.log }),
      ).toBe("exists");
      expect(r.warn).toEqual([]);
    }
    expect(js.streamUpdates.length).toBe(updatesBefore);
  });

  test("single stack: unchanged — `exists`, no update", async () => {
    const js = createFakeJetStream();
    await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [DEFAULT_PAT], log: recordingLog().log });
    const r = recordingLog();
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [DEFAULT_PAT], log: r.log }),
    ).toBe("exists");
    expect(js.streamUpdates).toEqual([]);
    expect(r.warn).toEqual([]);
  });

  test("a broader live subject (arc's `local.*.*.tasks.code-review.>`) covers ours — no update, no warning", async () => {
    const js = createFakeJetStream();
    await js.jsm.streams.add({ name: "CODE_REVIEW", subjects: ["local.*.*.tasks.code-review.>"], max_age: 24 * 3600 * 1e9 });
    const r = recordingLog();
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [WORK_PAT], log: r.log }),
    ).toBe("exists");
    expect(js.streamUpdates).toEqual([]);
    expect(r.warn).toEqual([]);
  });

  test("a partially-overlapping live subject is left alone with a drift warning", async () => {
    const js = createFakeJetStream();
    await js.jsm.streams.add({
      name: "CODE_REVIEW",
      subjects: ["local.alice.*.tasks.code-review.x"],
      max_age: 24 * 3600 * 1e9,
    });
    const r = recordingLog();
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [WORK_PAT], log: r.log }),
    ).toBe("config-drift-warning");
    expect(js.streamUpdates).toEqual([]);
    expect(r.warn.join("\n")).toContain("config drifts");
  });

  test("max_age drift still warns (never auto-updated)", async () => {
    const js = createFakeJetStream();
    await js.jsm.streams.add({ name: "CODE_REVIEW", subjects: [DEFAULT_PAT], max_age: 3600 * 1e9 });
    const r = recordingLog();
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [DEFAULT_PAT], log: r.log }),
    ).toBe("config-drift-warning");
    expect(r.warn.join("\n")).toContain("max_age differs");
    expect(js.streamUpdates).toEqual([]);
  });

  test("keeps the whole live config on update (only subjects grow)", async () => {
    const js = createFakeJetStream();
    await js.jsm.streams.add({ name: "CODE_REVIEW", subjects: [DEFAULT_PAT], max_age: 24 * 3600 * 1e9, max_bytes: 123 });
    await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [WORK_PAT], log: recordingLog().log });
    const info = await js.jsm.streams.info("CODE_REVIEW");
    expect(info.config.max_bytes).toBe(123);
  });

  test("a concurrent writer that drops our subject is re-read and retried", async () => {
    const js = createFakeJetStream();
    await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [DEFAULT_PAT], log: recordingLog().log });
    // Simulate the other stack's read-modify-write landing right after ours:
    // it writes the stale subject set it read (without WORK_PAT).
    const realUpdate = js.jsm.streams.update;
    let raced = false;
    js.jsm.streams.update = async (name, cfg) => {
      const res = await realUpdate(name, cfg);
      if (!raced) {
        raced = true;
        await realUpdate(name, { ...cfg, subjects: [DEFAULT_PAT, "local.alice.lab.tasks.code-review.*"] });
      }
      return res;
    };
    expect(
      await provisionReviewStream({ jsm: js.jsm, name: "CODE_REVIEW", subjects: [WORK_PAT], log: recordingLog().log }),
    ).toBe("subjects-extended");
    expect(js.streamSubjects("CODE_REVIEW").sort()).toEqual(
      [DEFAULT_PAT, "local.alice.lab.tasks.code-review.*", WORK_PAT].sort(),
    );
  });
});

describe("provisionReviewConsumer — legacy durable migration (cortex#1503)", () => {
  async function streamWithLegacy(legacyFilter: string) {
    const js = createFakeJetStream();
    await js.jsm.streams.add({ name: "CODE_REVIEW", subjects: [DEFAULT_PAT, WORK_PAT], max_age: 24 * 3600 * 1e9 });
    await js.jsm.consumers.add("CODE_REVIEW", {
      durable_name: LEGACY,
      filter_subject: legacyFilter,
      deliver_policy: DeliverPolicy.All,
    });
    return js;
  }

  test("ours + idle: new durable starts after the legacy's last delivery (no replay), legacy deleted", async () => {
    const js = await streamWithLegacy(DEFAULT_PAT);
    js.publish("local.alice.default.tasks.code-review.one");
    js.publish("local.alice.default.tasks.code-review.two");
    expect(js.pull("CODE_REVIEW", LEGACY)).toHaveLength(2); // processed pre-upgrade
    js.publish("local.alice.default.tasks.code-review.three"); // arrived while the daemon was down

    // A request that lands between the legacy read and the new durable's create
    // must still be delivered.
    const realAdd = js.jsm.consumers.add;
    js.jsm.consumers.add = async (stream, cfg) => {
      js.publish("local.alice.default.tasks.code-review.four");
      return realAdd(stream, cfg);
    };

    const r = recordingLog();
    expect(
      await provisionReviewConsumer({
        jsm: js.jsm,
        stream: "CODE_REVIEW",
        durable: SCOPED_DEFAULT,
        legacyDurable: LEGACY,
        filterSubject: DEFAULT_PAT,
        log: r.log,
      }),
    ).toBe("created");

    expect(js.pull("CODE_REVIEW", SCOPED_DEFAULT)).toEqual([
      "local.alice.default.tasks.code-review.three",
      "local.alice.default.tasks.code-review.four",
    ]);
    expect(js.consumerNames("CODE_REVIEW")).toEqual([SCOPED_DEFAULT]);
    expect(js.consumerDeletes).toEqual([{ stream: "CODE_REVIEW", durable: LEGACY }]);
    expect(r.warn).toEqual([]);
  });

  test("ours but ack-pending: legacy kept and named in a warning; retried and deleted on a later boot", async () => {
    const js = await streamWithLegacy(DEFAULT_PAT);
    js.publish("local.alice.default.tasks.code-review.inflight");
    js.pull("CODE_REVIEW", LEGACY, { ack: false }); // mid-review when the old daemon stopped

    const first = recordingLog();
    await provisionReviewConsumer({
      jsm: js.jsm,
      stream: "CODE_REVIEW",
      durable: SCOPED_DEFAULT,
      legacyDurable: LEGACY,
      filterSubject: DEFAULT_PAT,
      log: first.log,
    });
    expect(js.consumerNames("CODE_REVIEW").sort()).toEqual([LEGACY, SCOPED_DEFAULT].sort());
    expect(first.warn.join("\n")).toContain(LEGACY);
    expect(first.warn.join("\n")).toContain("ack_pending=1");
    // The already-delivered in-flight request is not replayed onto the new durable.
    expect(js.pull("CODE_REVIEW", SCOPED_DEFAULT)).toEqual([]);

    // Later boot, once the principal has dealt with it (or it was terminated
    // after max_deliver): the legacy durable is idle → cleaned up.
    js.ackAll("CODE_REVIEW", LEGACY);
    await provisionReviewConsumer({
      jsm: js.jsm,
      stream: "CODE_REVIEW",
      durable: SCOPED_DEFAULT,
      legacyDurable: LEGACY,
      filterSubject: DEFAULT_PAT,
      log: recordingLog().log,
    });
    expect(js.consumerNames("CODE_REVIEW")).toEqual([SCOPED_DEFAULT]);
  });

  test("ours but a live pull request is waiting: legacy kept, then deleted once idle", async () => {
    const js = await streamWithLegacy(DEFAULT_PAT);
    js.setWaiting("CODE_REVIEW", LEGACY, 1);
    const first = recordingLog();
    await provisionReviewConsumer({
      jsm: js.jsm,
      stream: "CODE_REVIEW",
      durable: SCOPED_DEFAULT,
      legacyDurable: LEGACY,
      filterSubject: DEFAULT_PAT,
      log: first.log,
    });
    expect(js.consumerNames("CODE_REVIEW")).toContain(LEGACY);
    expect(first.warn.join("\n")).toContain("waiting=1");

    // Next boot: the scoped durable already exists; the expired pull leaves the legacy idle.
    js.setWaiting("CODE_REVIEW", LEGACY, 0);
    const second = recordingLog();
    expect(
      await provisionReviewConsumer({
        jsm: js.jsm,
        stream: "CODE_REVIEW",
        durable: SCOPED_DEFAULT,
        legacyDurable: LEGACY,
        filterSubject: DEFAULT_PAT,
        log: second.log,
      }),
    ).toBe("exists");
    expect(js.consumerNames("CODE_REVIEW")).toEqual([SCOPED_DEFAULT]);
  });

  test("another stack's legacy durable is never touched; ours starts from New", async () => {
    const js = await streamWithLegacy(WORK_PAT); // the work stack provisioned it last
    js.publish("local.alice.default.tasks.code-review.stale"); // never reachable pre-fix
    const r = recordingLog();
    await provisionReviewConsumer({
      jsm: js.jsm,
      stream: "CODE_REVIEW",
      durable: SCOPED_DEFAULT,
      legacyDurable: LEGACY,
      filterSubject: DEFAULT_PAT,
      log: r.log,
    });
    expect(js.consumerFilter("CODE_REVIEW", LEGACY)).toBe(WORK_PAT);
    expect(js.consumerDeletes).toEqual([]);
    expect(r.info.join("\n")).toContain(LEGACY);
    expect(js.pull("CODE_REVIEW", SCOPED_DEFAULT)).toEqual([]);
    js.publish("local.alice.default.tasks.code-review.fresh");
    expect(js.pull("CODE_REVIEW", SCOPED_DEFAULT)).toEqual(["local.alice.default.tasks.code-review.fresh"]);
  });

  test("an unfiltered legacy durable (pre-cortex#1186) is not provably ours — left alone", async () => {
    const js = await streamWithLegacy("");
    await provisionReviewConsumer({
      jsm: js.jsm,
      stream: "CODE_REVIEW",
      durable: SCOPED_DEFAULT,
      legacyDurable: LEGACY,
      filterSubject: DEFAULT_PAT,
      log: recordingLog().log,
    });
    expect(js.consumerNames("CODE_REVIEW")).toContain(LEGACY);
    expect(js.consumerDeletes).toEqual([]);
  });

  test("no legacy durable: fresh stack keeps the default deliver policy", async () => {
    const js = createFakeJetStream();
    await js.jsm.streams.add({ name: "CODE_REVIEW", subjects: [DEFAULT_PAT], max_age: 24 * 3600 * 1e9 });
    js.publish("local.alice.default.tasks.code-review.queued");
    await provisionReviewConsumer({
      jsm: js.jsm,
      stream: "CODE_REVIEW",
      durable: SCOPED_DEFAULT,
      legacyDurable: LEGACY,
      filterSubject: DEFAULT_PAT,
      log: recordingLog().log,
    });
    // Same as before #1503: a first-boot durable reads the (interest-retained) backlog.
    expect(js.pull("CODE_REVIEW", SCOPED_DEFAULT)).toEqual(["local.alice.default.tasks.code-review.queued"]);
  });
});
