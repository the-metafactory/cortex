import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildMessages,
  chatClassifier,
  commandClassifier,
  MailClassifier,
  readClassifications,
  saveClassification,
  UNIMPORTANT_MODEL,
  UNIMPORTANT_REASON,
  type ClassifierMail,
  type ClassifierRequest,
  type ClassifyInput,
  type CommandConfig,
  type CommandRunner,
  type EndpointConfig,
} from "../desk/classify";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { openMailRoundRig, roundAt, roundMail } from "./fixtures/mail-round-rig";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const COMMAND: CommandConfig = { command: ["capture-classifier"], timeoutSeconds: 5, maxPerPass: 1 };
const ENDPOINT: EndpointConfig = { baseUrl: "https://classifier.example/v1", model: "fixture", timeoutSeconds: 5, maxPerPass: 1 };
const ANSWER = { category: "reply", commitment: "none", reason: "The sender expects an answer." } as const;
const quiet = (): void => undefined;
const mail = (id: string, address = "sender@example.org"): ClassifierMail => ({
  kind: "mail", id, sourceId: "work-mail", account: "work", from: { name: "Sender", address },
  subject: "Review", firstParagraph: "Could you review this?", receivedAt: new Date(NOW).toISOString(), unread: true,
});
const input = (items: ClassifierMail[]): ClassifyInput => ({ now: NOW, mail: items, events: [], vips: [], localSources: new Set<string>() });
const recorded = (db: Database, id: string) => db.query<{ category: string; reason: string; model: string }, [string]>("SELECT category, reason, model FROM desk_mail_classes WHERE message_id = ?").get(id);

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

describe("Cortex's classification messages", () => {
  const richInput = (): ClassifyInput => ({
    ...input([mail("review")]),
    events: [{ id: "planning", sourceId: "calendar", title: "Planning", start: new Date(NOW + 3_600_000).toISOString() }],
    vips: ["sender@example.org"],
    unimportant: ["@news.example.org"],
    corrections: [{ kind: "mail", source: "work-mail", mode: "less", label: "Work mail" }],
    notes: [{ sourcePolicy: "cloud", areas: ["work"], id: "note-1", name: "Review", text: "Prepare the review." }],
  });
  const expectedRequest = (): ClassifierRequest => ({
    sourcePolicy: "cloud",
    notes: richInput().notes,
    mail: { id: "review", sourceId: "work-mail", account: "work", from: { name: "Sender", address: "sender@example.org" }, subject: "Review", firstParagraph: "Could you review this?", receivedAt: new Date(NOW).toISOString() },
    meetings: [{ key: "cal:calendar:planning", title: "Planning", start: new Date(NOW + 3_600_000).toISOString(), sourceId: "calendar", sourcePolicy: "cloud" }],
    vips: ["sender@example.org"], unimportant: ["@news.example.org"],
    corrections: [{ kind: "mail", source: "work-mail", mode: "less", label: "Work mail" }],
    examples: [], examplesBasis: "sender",
  });

  it("adds buildMessages to command stdin while preserving every existing request field", async () => {
    const calls: { argv: string[]; timeout: number; body: unknown }[] = [];
    const run: CommandRunner = async (argv, timeout, stdin) => {
      calls.push({ argv, timeout, body: JSON.parse(stdin) });
      return { code: 0, signal: null, stdout: JSON.stringify(ANSWER), stderr: "" };
    };
    const result = await new MailClassifier(COMMAND, commandClassifier(COMMAND, run), quiet).kick(db, richInput());
    const request = expectedRequest();
    expect(result).toMatchObject({ classified: 1, failed: 0 });
    expect(calls).toEqual([{ argv: COMMAND.command, timeout: 5000, body: { ...request, messages: buildMessages(request) } }]);
    expect(readClassifications(db, ["review"]).get("review")).toEqual(ANSWER);
  });

  it("keeps the endpoint's messages and completion request unchanged", async () => {
    const posts: unknown[] = [];
    const fetchImpl = (async (url, options) => {
      expect(url).toBe("https://classifier.example/v1/chat/completions");
      posts.push(JSON.parse(options?.body as string));
      return Response.json({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] });
    }) as typeof fetch;
    await new MailClassifier(ENDPOINT, chatClassifier(ENDPOINT, fetchImpl), quiet).kick(db, richInput());
    expect(posts).toEqual([{ model: "fixture", messages: buildMessages(expectedRequest()), temperature: 0, max_tokens: 600 }]);
    expect(readClassifications(db, ["review"]).get("review")).toEqual(ANSWER);
  });

  it("leaves the supplied messages on disk after a Desk refresh through a real command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "classifier-messages-"));
    const capturePath = join(dir, "stdin.json");
    const scriptPath = join(dir, "classifier");
    writeFileSync(scriptPath, `#!/bin/sh\ncat > "$1"\nprintf '%s' '${JSON.stringify(ANSWER)}'\n`, { mode: 0o755 });
    const rig = await openMailRoundRig(roundAt(2, 9), {
      mailDigest: undefined, mailInvitations: undefined,
      mailClassifier: { ...COMMAND, command: [scriptPath, capturePath], sourcePolicy: "local" },
    });
    try {
      rig.setState({ mail: [roundMail("captured", roundAt(2, 8))] });
      await rig.refresh();
      const started = Date.now();
      while (!recorded(rig.database(), "captured") && Date.now() - started < 3000) await Bun.sleep(10);
      expect(readClassifications(rig.database(), ["captured"]).get("captured")).toMatchObject(ANSWER);
      const captured = await Bun.file(capturePath).json() as ClassifierRequest & { messages: ReturnType<typeof buildMessages> };
      expect(captured.mail.id).toBe("captured");
      expect(captured.messages).toHaveLength(2);
      expect(captured.messages.every((message) => message.content.length > 0)).toBe(true);
      expect(captured.messages).toEqual(buildMessages(captured));
    } finally {
      await rig.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

for (const transport of ["command", "endpoint"] as const) {
  describe(`${transport} classifier's unimportant-sender rule`, () => {
    const recorder = () => {
      const calls: unknown[] = [];
      const command: CommandRunner = async (_argv, _timeout, stdin) => {
        calls.push(JSON.parse(stdin));
        return { code: 0, signal: null, stdout: JSON.stringify(ANSWER), stderr: "" };
      };
      const endpoint = (async (_url, options) => {
        calls.push(JSON.parse(options?.body as string));
        return Response.json({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] });
      }) as typeof fetch;
      const classifier = transport === "command"
        ? new MailClassifier(COMMAND, commandClassifier(COMMAND, command), quiet)
        : new MailClassifier(ENDPOINT, chatClassifier(ENDPOINT, endpoint), quiet);
      return { calls, classifier };
    };

    it.each(["SENDER@EXAMPLE.ORG", "@EXAMPLE.ORG"])("saves bulk for %s without a model call, even over an existing verdict", async (entry) => {
      const { calls, classifier } = recorder();
      saveClassification(db, "unimportant", { category: "action", commitment: "request", reason: "Old verdict." }, "old-model", NOW);
      await classifier.kick(db, { ...input([mail("unimportant", "Sender@Example.Org")]), unimportant: [entry] });
      expect(calls).toEqual([]);
      expect(recorded(db, "unimportant")).toEqual({ category: "bulk", reason: UNIMPORTANT_REASON, model: UNIMPORTANT_MODEL });
      await classifier.kick(db, input([mail("unimportant")]));
      expect(calls).toHaveLength(1);
      expect(readClassifications(db, ["unimportant"]).get("unimportant")).toEqual(ANSWER);
    });

    it.each(["SENDER@EXAMPLE.ORG", "@EXAMPLE.ORG"])("sends a VIP matching %s to the model despite the unimportant domain", async (vip) => {
      const { calls, classifier } = recorder();
      await classifier.kick(db, { ...input([mail("vip", "Sender@Example.Org")]), vips: [vip], unimportant: ["@EXAMPLE.ORG"] });
      expect(calls).toHaveLength(1);
      expect(readClassifications(db, ["vip"]).get("vip")).toEqual(ANSWER);
    });

    it("saves every unimportant mail without consuming the model limit or matching a subdomain", async () => {
      const { calls, classifier } = recorder();
      await classifier.kick(db, { ...input([mail("one"), mail("two"), mail("subdomain", "sender@sub.example.org")]), unimportant: ["@EXAMPLE.ORG"] });
      expect(calls).toHaveLength(1);
      for (const id of ["one", "two"]) expect(recorded(db, id)).toEqual({ category: "bulk", reason: UNIMPORTANT_REASON, model: UNIMPORTANT_MODEL });
      expect(readClassifications(db, ["subdomain"]).get("subdomain")).toEqual(ANSWER);
    });
  });
}
