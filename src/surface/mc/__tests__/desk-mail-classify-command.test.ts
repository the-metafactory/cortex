import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import type { SourceMail } from "../desk/sources/command";
import { runCommand } from "../desk/spawn";
import {
  CLASSIFIER_KEY_ENV,
  commandClassifier,
  MailClassifier,
  MAX_SUMMARY,
  readClassifications,
  validateAnswer,
  type ClassifierConfig,
  type ClassifierRequest,
  type CommandRunner,
  type MailClassification,
  type MailEvidence,
} from "../desk/classify";
import { McSchema } from "../../../common/types/config";

const NOW = new Date("2026-10-31T09:00:00").getTime();
const KUNDEN_KEY = "cal:work-calendar:k1";
const KUNDEN = { id: "k1", title: "Switch-Kundenmeeting 2026", start: new Date(NOW + 2 * 86_400_000).toISOString(), sourceId: "work-calendar" };
const COMMAND: ClassifierConfig = { command: ["/opt/desk/bin/desk-classify-mail.ts", "--flow", "/opt/desk/flows/desk-mail-triage.yaml"], timeoutSeconds: 75, maxPerPass: 10 };
const quiet = (): void => undefined;

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail & { sourceId: string } => ({
  kind: "mail", id, from: { name: "Ada", address: "ada@example.org" }, subject: "Agenda for Monday", receivedAt: new Date(NOW - 3_600_000).toISOString(),
  unread: true, firstParagraph: "Here is the agenda.", account: "work", sourceId: "work-mail", ...over,
});

const REQUEST: ClassifierRequest = {
  mail: { id: "m1", from: { address: "ada@example.org" }, subject: "Agenda", firstParagraph: "", receivedAt: new Date(NOW).toISOString() },
  meetings: [],
  vips: [],
  unimportant: [],
  corrections: [],
};

const EVIDENCE: MailEvidence[] = [{ kind: "event", ref: KUNDEN_KEY, title: "Switch-Kundenmeeting 2026" }, { kind: "mail", ref: "<prev@example.org>", title: "Re: Agenda" }];

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

describe("the classifier config", () => {
  const parse = (classifier: Record<string, unknown>) => McSchema.safeParse({ desk: { mail: { classifier } } }).success;

  it("takes either a command or an endpoint, never both and never neither", () => {
    expect(parse({ command: ["desk-classify-mail"] })).toBe(true);
    expect(parse({ baseUrl: "https://api.example/v1", model: "m" })).toBe(true);
    expect(parse({ command: ["desk-classify-mail"], baseUrl: "https://api.example/v1", model: "m" })).toBe(false);
    expect(parse({ command: ["desk-classify-mail"], model: "m" })).toBe(false);
    expect(parse({ baseUrl: "https://api.example/v1" })).toBe(false);
    expect(parse({ command: [] })).toBe(false);
    expect(parse({})).toBe(false);
  });

  it("keeps the CA file to the endpoint form", () => {
    expect(parse({ command: ["desk-classify-mail"], caFile: "/ca.pem" })).toBe(false);
    expect(parse({ command: ["desk-classify-mail"], apiKeyFile: "~/.key", timeoutSeconds: 75 })).toBe(true);
  });
});

describe("the command form", () => {
  const ok = (stdout: string): CommandRunner => async () => ({ code: 0, signal: null, stdout, stderr: "" });

  it("writes the request to stdin, passes the key in the environment and parses one JSON answer", async () => {
    const calls: { argv: string[]; timeoutMs: number; stdin: string; env?: Record<string, string | undefined> }[] = [];
    const run: CommandRunner = async (argv, timeoutMs, stdin, env) => {
      calls.push({ argv, timeoutMs, stdin, ...(env ? { env } : {}) });
      return { code: 0, signal: null, stdout: "{\"category\":\"bulk\",\"reason\":\"A newsletter.\"}\n", stderr: "" };
    };
    const answer = await commandClassifier({ ...COMMAND, command: COMMAND.command ?? [], apiKeyFile: "/key" }, run, async () => "sk-test")(REQUEST, 75_000);
    expect(answer).toEqual({ category: "bulk", reason: "A newsletter." });
    expect(calls[0]?.argv).toEqual(COMMAND.command ?? []);
    expect(calls[0]?.timeoutMs).toBe(75_000);
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual(REQUEST);
    expect(calls[0]?.env?.[CLASSIFIER_KEY_ENV]).toBe("sk-test");
    expect(calls[0]?.argv.join(" ")).not.toContain("sk-test");
  });

  it("runs without an extra environment when no key is configured", async () => {
    let seen: Record<string, string | undefined> | undefined = { x: "y" };
    await commandClassifier({ ...COMMAND, command: COMMAND.command ?? [] }, async (_a, _t, _s, env) => { seen = env; return { code: 0, signal: null, stdout: "{}", stderr: "" }; }, async () => null)(REQUEST, 1000);
    expect(seen).toBeUndefined();
  });

  it("fails with the command's last stderr line, a kill, a timeout or a missing JSON answer", async () => {
    const cmd = { ...COMMAND, command: COMMAND.command ?? [] };
    const noKey = async () => null;
    await expect(commandClassifier(cmd, async () => ({ code: 2, signal: null, stdout: "", stderr: "debug\ndesk-classify-mail: the gateway is unreachable\n" }), noKey)(REQUEST, 1000))
      .rejects.toThrow("the classifier command desk-classify-mail.ts exited 2: desk-classify-mail: the gateway is unreachable");
    await expect(commandClassifier(cmd, async () => ({ code: 0, signal: "SIGKILL", stdout: "", stderr: "" }), noKey)(REQUEST, 1000))
      .rejects.toThrow("was killed by SIGKILL");
    await expect(commandClassifier(cmd, ok("not json"), noKey)(REQUEST, 1000)).rejects.toThrow("printed no JSON answer");
    await expect(commandClassifier({ ...cmd, apiKeyEnv: "UNSET" }, ok("{}"), noKey)(REQUEST, 1000)).rejects.toThrow("the classifier key was not found");
  });

  it("kills a command that outlives its timeout", async () => {
    const started = Date.now();
    await expect(commandClassifier({ ...COMMAND, command: ["sleep", "5"] }, runCommand, async () => null)(REQUEST, 300))
      .rejects.toThrow("the classifier command sleep timed out after 0 s");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("the extra answer fields", () => {
  const keys = new Set([KUNDEN_KEY]);
  const base: MailClassification = { category: "meeting", meetingKey: KUNDEN_KEY, reason: "It sets the agenda." };

  it("keeps a summary, a suggested action and up to five pieces of evidence", () => {
    expect(validateAnswer({ ...base, summary: "Ada sends the agenda.", suggestedAction: "link-meeting", evidence: EVIDENCE }, keys))
      .toEqual({ ...base, summary: "Ada sends the agenda.", suggestedAction: "link-meeting", evidence: EVIDENCE });
  });

  it("rejects a long summary, an unknown action and too much or malformed evidence", () => {
    expect(validateAnswer({ ...base, summary: "x".repeat(MAX_SUMMARY + 1) }, keys)).toBeNull();
    expect(validateAnswer({ ...base, suggestedAction: "forward" }, keys)).toBeNull();
    expect(validateAnswer({ ...base, evidence: Array.from({ length: 6 }, () => EVIDENCE[0]) }, keys)).toBeNull();
    expect(validateAnswer({ ...base, evidence: [{ kind: "web", ref: "x", title: "y" }] }, keys)).toBeNull();
    expect(validateAnswer({ ...base, evidence: [{ kind: "mail", ref: "x" }] }, keys)).toBeNull();
  });
});

describe("a pass through the command", () => {
  it("sends the mail's account and the mail corrections, and caches the extra fields", async () => {
    const seen: ClassifierRequest[] = [];
    const c = new MailClassifier(COMMAND, async (req) => {
      seen.push(req);
      return { category: "meeting", meetingKey: KUNDEN_KEY, reason: "It sets the agenda.", summary: "Ada sends the agenda.", suggestedAction: "link-meeting", evidence: EVIDENCE };
    }, quiet);
    const corrections = [{ kind: "mail", source: "work-mail", mode: "less", label: "Mail, from work-mail" }];
    await c.kick(db, { now: NOW, mail: [mail("m1")], events: [KUNDEN], vips: [], corrections });
    expect(seen[0]?.mail.account).toBe("work");
    expect(seen[0]?.corrections).toEqual(corrections);
    const expected: MailClassification = { category: "meeting", meetingKey: KUNDEN_KEY, reason: "It sets the agenda.", summary: "Ada sends the agenda.", suggestedAction: "link-meeting", evidence: EVIDENCE };
    expect(readClassifications(db, ["m1"]).get("m1")).toEqual(expected);
    expect(db.query<{ model: string }, []>("SELECT model FROM desk_mail_classes").get()?.model).toBe("desk-classify-mail.ts");
  });

  it("ignores a stored detail blob it cannot read", () => {
    db.query("INSERT INTO desk_mail_classes (message_id, category, meeting_key, reason, model, classified_at, details) VALUES ('m2', 'fyi', NULL, 'News.', 'x', ?, '{not json')").run(NOW);
    expect(readClassifications(db, ["m2"]).get("m2")).toEqual({ category: "fyi", reason: "News." });
  });
});
