import { expect, test } from "bun:test";
import { compare, median, type TimingBaseline } from "../probe-desk-adapter-timing";

const here = { machine: "lab/darwin-arm64", bun: "1.3.0" };
const baseline: TimingBaseline = { ...here, medianMs: 10, runs: 20 };

test("the median of an odd and an even sample set", () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("no baseline asks to record one", () => {
  expect(compare(undefined, { ...here, medianMs: 12 })).toEqual({ kind: "no-baseline" });
});

test("a median above twice the baseline is a notify-level over-baseline result", () => {
  expect(compare(baseline, { ...here, medianMs: 20.1 })).toEqual({ kind: "over-baseline", level: "notify", ratio: 20.1 / 10 });
  expect(compare(baseline, { ...here, medianMs: 20 }).kind).toBe("within-baseline");
});

test("a baseline from another machine or Bun version is refused", () => {
  expect(compare(baseline, { ...here, machine: "other/linux-x64", medianMs: 1 })).toEqual({ kind: "refused", reason: "machine" });
  expect(compare(baseline, { ...here, bun: "1.4.0", medianMs: 100 })).toEqual({ kind: "refused", reason: "bun" });
});
