import { join } from "node:path";
import { DEFAULT_SETTINGS, type AppState } from "../../../../balance";
import { HandledLedger } from "../../desk/actions";
import type { DeskOptions, DeskRuntime } from "../../desk/compose";
import { SourceCache } from "../../desk/sources/command";

export const NOW = new Date(2026, 10, 4, 10).getTime();
export const EVENT = "cal:cal:standup";
export const PRINCIPAL = "principal@example.com";
export const SECRET_TITLE = "Saved title that must never be quoted as content";

const task = (id: string, title: string) => ({ id, title, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const });
export const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [task("kickoff", "Kickoff prep")] }] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});

export interface Fixture { events: unknown[]; items: unknown[] }
export const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  events: [{ id: "standup", title: "Weekly sync", start: new Date(NOW + 3_600_000).toISOString(), end: new Date(NOW + 7_200_000).toISOString() }],
  items: [{ kind: "mail", id: "m1", from: { name: "Ada Lovelace", address: "ada@example.org" }, subject: "Venue quote", firstParagraph: "The venue costs 900.", receivedAt: new Date(NOW - 3_600_000).toISOString(), unread: true, account: "work", url: "https://mail.example.test/m1" }],
  ...over,
});


export const briefOptions = (dir: string): DeskOptions => ({ enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }], sources: [{ id: "cal", command: ["cat", join(dir, "source.json")], everySeconds: 300, timeoutSeconds: 5 }] });

export const briefRuntime = async (options: DeskOptions, data: Fixture): Promise<DeskRuntime> => {
  const cache = new SourceCache(async () => JSON.stringify(data));
  await cache.read(options.sources, NOW);
  return { options, ledger: new HandledLedger(), sourceCache: cache };
};

export const briefPost = (url: string, body: unknown): Request => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
