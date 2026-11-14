import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { McSchema } from "../../../common/types/config";
import { initDatabase } from "../db/init";
import { handleGetDesk } from "../api/desk";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions } from "../desk/compose";
import { voiceView } from "../desk/voice";

const DESK: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [] };
const WAKE = { enabled: true, detector: "sherpa-2.0.1", model: "gigaspeech-3.3m-2024-01-01", phrase: "Hey Mira", threshold: 0.25, score: 3, preRollMs: 2000, silenceMs: 900, maxCommandMs: 15000, speechThreshold: 0.015 } as const;

describe("mc.desk.assistantName", () => {
  it("defaults to Assistant and keeps a configured name", () => {
    expect(McSchema.parse(undefined).desk.assistantName).toBe("Assistant");
    expect(McSchema.parse({ desk: { assistantName: "  Mira " } }).desk.assistantName).toBe("Mira");
  });

  it("refuses an empty, an over-long and a multi-line name", () => {
    for (const assistantName of ["", "   ", "x".repeat(61), "Mira\nIvy"]) {
      const result = McSchema.safeParse({ desk: { assistantName } });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["desk", "assistantName"]);
    }
  });

  it("gives the wake word the Desk name unless the wake config names its own", () => {
    expect(voiceView({ enabled: true, input: "browser", output: "browser", wake: WAKE }, "Mira").wake?.assistantName).toBe("Mira");
    expect(voiceView({ enabled: true, input: "browser", output: "browser", wake: { ...WAKE, assistantName: "Echo" } }, "Mira").wake?.assistantName).toBe("Echo");
  });
});

describe("GET /api/desk", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const read = async (options: DeskOptions): Promise<Record<string, unknown>> =>
    (await (await handleGetDesk(db, { options, ledger: new HandledLedger() }, undefined)).json()) as Record<string, unknown>;

  it("returns the configured name, and Assistant when none is set", async () => {
    expect((await read({ ...DESK, assistantName: "Mira" })).assistantName).toBe("Mira");
    expect((await read(DESK)).assistantName).toBe("Assistant");
  });
});

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SCOPE = ["src/surface/mc/api", "src/surface/mc/desk", "src/surface/mc/dashboard-v2", "src/conversations/host.ts", "src/conversations/pi.ts"];
const LEGACY_KEYS = ["Ivy's notes", "Ivy’s notes", "ivy's notes", "ivy’s notes", "trigger: Ivy conversation", "`Ivy conversation: "];

function sources(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true, encoding: "utf8" })
    .map((name) => join(full, name))
    .filter((file) => /\.tsx?$/.test(file) && !/(__tests__|\.test\.|\/fixtures\/)/.test(file));
}

describe("the assistant's name in Desk sources", () => {
  it("is never the literal Ivy outside the legacy Studio keys", () => {
    const found = SCOPE.flatMap(sources).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, i) => {
        const rest = LEGACY_KEYS.reduce((l, key) => l.replaceAll(key, ""), line);
        return /\bIvy\b/.test(rest) ? [`${relative(ROOT, file)}:${i + 1}`] : [];
      }));
    expect(found).toEqual([]);
  });
});
