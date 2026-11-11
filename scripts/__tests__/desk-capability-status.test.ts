import { describe, expect, it } from "bun:test";
import { parseNodeRef, readStatus, readWorkerReport, statusFromJournal, type JournalRunner } from "../desk-capability-status";

const worker = (fields: Record<string, unknown>) => ({ nodeId: "21", repo: "example/maps", generation: 1, startedAt: "2026-11-03T08:00:00.000Z", phase: "implement", prNumber: null, outcome: null, ...fields });
const journal = (...workers: Record<string, unknown>[]) => ({ journalPath: "/x", workers, escalations: [], events: [] });

describe("mapping the journal to a build state", () => {
  it("is filed while no worker has claimed the node", () => {
    expect(statusFromJournal(journal())).toEqual({ state: "filed" });
  });

  it("is building for a claimed or running worker without a pull request", () => {
    expect(statusFromJournal(journal(worker({ status: "claimed" })))).toEqual({ state: "building" });
    expect(statusFromJournal(journal(worker({ status: "running" })))).toEqual({ state: "building" });
  });

  it("is in review once a pull request is open or the merge desk holds it", () => {
    expect(statusFromJournal(journal(worker({ status: "running", prNumber: 3200 })))).toEqual({ state: "in-review", pr: 3200 });
    expect(statusFromJournal(journal(worker({ status: "running", phase: "review" })))).toEqual({ state: "in-review" });
    expect(statusFromJournal(journal(worker({ status: "awaiting-merge", phase: "awaiting-merge", prNumber: 3201 })))).toEqual({ state: "in-review", pr: 3201 });
  });

  it("is merged when the close phase succeeded, taking the pull request from the outcome", () => {
    expect(statusFromJournal(journal(worker({ status: "success", phase: "close", outcome: "merged: PR #3163 merged" })))).toEqual({ state: "merged", pr: 3163 });
  });

  it("is merged when the node was closed outside the walker after a merged pull request", () => {
    const closed = worker({ status: "success", phase: "close", outcome: "closed outside ranger by someone; receipt: https://example.test/1; PR #3163 merged" });
    expect(statusFromJournal(journal(closed))).toEqual({ state: "merged", pr: 3163 });
  });

  it("never reads merged from the outcome text of a released worker", () => {
    const released = worker({ status: "released", phase: "close", outcome: "closed outside ranger by someone; PR #3163 not merged" });
    expect(statusFromJournal(journal(released))).toEqual({ state: "failed", reason: "closed outside ranger by someone; PR #3163 not merged", pr: 3163 });
  });

  it("is failed with the reason for a failed, parked or released-without-merge worker", () => {
    expect(statusFromJournal(journal(worker({ status: "failed", outcome: "tests failed after the worker" })))).toEqual({ state: "failed", reason: "tests failed after the worker" });
    expect(statusFromJournal(journal(worker({ status: "parked", outcome: "blocked: needs a decision" })))).toEqual({ state: "failed", reason: "blocked: needs a decision" });
    expect(statusFromJournal(journal(worker({ status: "released", phase: "close", outcome: "closed outside ranger by someone; receipt: https://example.test/1; PR #3163 closed" })))).toEqual({ state: "failed", reason: "closed outside ranger by someone; receipt: https://example.test/1; PR #3163 closed", pr: 3163 });
  });

  it("reads the newest worker when a node has run more than once", () => {
    const earlier = worker({ status: "failed", generation: 1, outcome: "first try failed" });
    const later = worker({ status: "running", generation: 2 });
    expect(statusFromJournal(journal(earlier, later))).toEqual({ state: "building" });
  });

  it("refuses a worker status it does not map instead of guessing", () => {
    expect(() => statusFromJournal(journal(worker({ status: "unsupported" })))).toThrow("does not map");
    expect(() => statusFromJournal(journal(worker({ status: "success", phase: "implement" })))).toThrow("does not mean merged");
  });
});

describe("reading a node's status", () => {
  const run = (stdout: string, code = 0, stderr = ""): { run: JournalRunner; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, run: (argv) => { calls.push(argv); return Promise.resolve({ code, stdout, stderr }); } };
  };

  it("asks the journal for the node in its repository", async () => {
    const fake = run(JSON.stringify(journal(worker({ status: "running" }))));
    expect(await readStatus("example/maps#21", fake.run)).toEqual({ state: "building" });
    expect(fake.calls).toEqual([["journal", "--node", "21", "--repo", "example/maps"]]);
  });

  it("fails with the journal's error", async () => {
    await expect(readStatus("example/maps#21", run("", 1, "no journal\n").run)).rejects.toThrow("no journal");
  });

  it("fails when the journal does not print JSON", async () => {
    await expect(readStatus("example/maps#21", run("<html>").run)).rejects.toThrow("did not print JSON");
  });

  it("reports the worker generation with the build state so an exact worker can be stopped", async () => {
    const fake = run(JSON.stringify(journal(worker({ status: "running", generation: 4, prNumber: 3200 }))));
    expect(await readWorkerReport("example/maps#21", fake.run)).toEqual({ state: "in-review", pr: 3200, generation: 4 });
    expect((await readWorkerReport("example/maps#21", run(JSON.stringify(journal())).run)).generation).toBeNull();
  });

  it("distinguishes an unsettled stop from a settled stop", async () => {
    for (const fields of [{ pid: 12, workerPgid: null }, { pid: null, workerPgid: 13 }, {}]) {
      const fake = run(JSON.stringify(journal(worker({ status: "stop-requested", ...fields }))));
      expect(await readWorkerReport("example/maps#21", fake.run)).toMatchObject({ state: "stopping", generation: 1 });
    }
    const fake = run(JSON.stringify(journal(worker({ status: "stop-requested", pid: null, workerPgid: null }))));
    expect(await readWorkerReport("example/maps#21", fake.run)).toMatchObject({ state: "cancelled", generation: 1 });
  });

  it("refuses another node's journal row", async () => {
    const fake = run(JSON.stringify(journal(worker({ status: "running", nodeId: "99" }))));
    await expect(readWorkerReport("example/maps#21", fake.run)).rejects.toThrow("another node");
  });

  it("rejects a reference that is not a node", () => {
    for (const ref of ["21", "example/maps", "example/maps#0", "#21", "example/maps#x"]) expect(() => parseNodeRef(ref)).toThrow("not a node reference");
  });
});
