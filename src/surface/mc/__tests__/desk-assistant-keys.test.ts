import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { ASSISTANT_ROW_MIGRATIONS } from "../desk/assistant-rows";
import { migrateThreadKeys } from "../desk/studio/assistant-keys";
import { appendEntry, mergeNotesSections, setNoteStatus } from "../desk/studio/edit";
import { parseThreadFile } from "../desk/studio/format";
import { migrateStudioKeys } from "../desk/studio/migrate-keys";
import type { StudioArea } from "../desk/studio/view";
import { gitAt } from "./studio-conversation-rig";

const AREAS: StudioArea[] = [{ id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" }];
const FRONT = "---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-10-01\n---\n\n## Question\n\nWhat about alpha?\n\n";
const NOTE = (at: string, trigger = "Stale thread"): string => `### ${at}\ntrigger: ${trigger}\nmodel: cloud\n\nA thought at ${at}.`;

const OLD = `${FRONT}## Ivy's notes

${NOTE("2026-10-31T03:12:00+01:00")}

${NOTE("2026-10-31T03:14:00+01:00", "Ivy conversation")}

## Material

- Ivy conversation: [Talk](?desk=conversation&conversation=c-1)
- file: [Brief](https://example.org/brief)

## Log

- 2026-10-01: Opened
`;

const parsed = (text: string) => {
  const p = parseThreadFile("threads/alpha.md", text);
  if (!p.ok) throw new Error(p.reason);
  return p.value;
};

describe("the old Studio keys", () => {
  it("still parse, and a file with both notes headings reads every note", () => {
    expect(parsed(OLD).notes.map((n) => n.at)).toEqual(["2026-10-31T03:12:00+01:00", "2026-10-31T03:14:00+01:00"]);
    const both = OLD.replace("## Material", `## Assistant's notes\n\n${NOTE("2026-11-01T03:00:00+01:00")}\n\n## Material`);
    expect(parsed(both).notes).toHaveLength(3);
  });

  it("are renamed in place: one notes section, the conversation trigger and the material line", () => {
    const migrated = migrateThreadKeys(OLD);
    expect(migrated).toContain("## Assistant's notes\n");
    expect(migrated).toContain("trigger: Conversation\n");
    expect(migrated).toContain("- Conversation: [Talk](?desk=conversation&conversation=c-1)");
    expect(migrated).not.toContain("Ivy");
    expect(migrateThreadKeys(migrated)).toBe(migrated);
    expect(parsed(migrated).notes.map((n) => n.trigger)).toEqual(["Stale thread", "Conversation"]);
  });

  it("merges a notes section that an old writer appended after the rename", () => {
    const appended = `${migrateThreadKeys(OLD)}\n## Ivy's notes\n\n${NOTE("2026-11-02T03:00:00+01:00")}\n`;
    const merged = mergeNotesSections(appended);
    expect(merged.match(/^## .*notes$/gm)).toEqual(["## Assistant's notes"]);
    expect(parsed(merged).notes).toHaveLength(3);
    expect(merged.indexOf("## Log")).toBeGreaterThan(merged.indexOf("2026-11-02T03:00:00+01:00"));
    const kept = setNoteStatus(appended, "2026-11-02T03:00:00+01:00", "kept");
    expect(kept && parsed(kept).notes.find((n) => n.at === "2026-11-02T03:00:00+01:00")?.status).toBe("kept");
    const added = appendEntry(appended, "notes", "Assistant's notes", [NOTE("2026-11-03T03:00:00+01:00")]);
    expect(added?.match(/^## .*notes$/gm)).toEqual(["## Assistant's notes"]);
  });
});

describe("the Studio key migration", () => {
  let dir: string;
  const git = (...args: string[]): string => gitAt(dir)(...args);
  const run = () => migrateStudioKeys({ options: { dir, maxActive: 5 }, areas: AREAS, assistantName: "Mira", now: new Date("2026-11-14T09:00:00+01:00") });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "studio-keys-"));
    mkdirSync(join(dir, "threads"));
    writeFileSync(join(dir, "threads/alpha.md"), OLD);
    writeFileSync(join(dir, "threads/beta.md"), migrateThreadKeys(OLD).replace("alpha", "beta"));
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.org");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rewrites the files that carry old keys in one commit, and a second run commits nothing", async () => {
    const first = await run();
    expect(first).toMatchObject({ kind: "migrated", files: ["threads/alpha.md"] });
    expect(git("log", "-1", "--format=%s").trim()).toBe("Studio: Rename the old assistant keys to neutral names: ## Assistant's notes, trigger: Conversation, Conversation: material");
    expect(readFileSync(join(dir, "threads/alpha.md"), "utf8")).toBe(migrateThreadKeys(OLD));
    expect(git("status", "--porcelain")).toBe("");
    expect(await run()).toEqual({ kind: "current" });
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
    git("revert", "--no-edit", "HEAD");
    expect(readFileSync(join(dir, "threads/alpha.md"), "utf8")).toBe(OLD);
  });

  it("writes nothing while the Studio has uncommitted changes", async () => {
    writeFileSync(join(dir, "threads/gamma.md"), "draft");
    expect((await run()).kind).toBe("refused");
    expect(readFileSync(join(dir, "threads/alpha.md"), "utf8")).toBe(OLD);
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  });
});

describe("stored rows with the old ids", () => {
  it("read as the new ids after the database opens, and a second pass changes nothing", () => {
    const db = initDatabase(":memory:");
    db.run("INSERT INTO desk_mail_log (message_id, sender, sender_domain, action, origin, created_at) VALUES ('m1', 'a@x.org', 'x.org', 'ivy', 'desk', 1)");
    db.run("INSERT INTO desk_done (attempt_key, action, item_key, title, status, created_at, updated_at) VALUES ('a1', 'ivy.approve', 'ivy:h1', 't', 'done', 1, 1)");
    db.run("INSERT INTO desk_grants (action, granted_at) VALUES ('mail.ivy', 1)");
    for (const sql of ASSISTANT_ROW_MIGRATIONS) db.run(sql);
    expect(db.query("SELECT action FROM desk_mail_log").all()).toEqual([{ action: "assistant" }]);
    expect(db.query("SELECT action, item_key FROM desk_done").all()).toEqual([{ action: "assistant.approve", item_key: "assistant:h1" }]);
    expect(db.query("SELECT action FROM desk_grants").all()).toEqual([{ action: "mail.assistant" }]);
    for (const sql of ASSISTANT_ROW_MIGRATIONS) db.run(sql);
    expect(db.query("SELECT action, item_key FROM desk_done").all()).toEqual([{ action: "assistant.approve", item_key: "assistant:h1" }]);
    db.close();
  });
});
