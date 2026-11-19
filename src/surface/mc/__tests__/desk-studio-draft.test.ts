import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DraftSchema, openStudioDraftRig } from "../testing/studio-draft-rig";
import { DESK_API_VERSION } from "../../../desk-api/api-version";
import { getStudioDraft } from "../desk/studio/draft";
import { spawnGit, type GitRunner } from "../desk/studio/git";

let rig: Awaited<ReturnType<typeof openStudioDraftRig>>;
beforeEach(async () => { rig = await openStudioDraftRig(); });
afterEach(async () => { await rig.close(); });
const markdown = "\ufeff \r\n# A draft 🦊\r\n\r\n---\r\n## Heading\n\n  Body\t\n\n ";
const save = async (text: string, thread = "question") => {
  const previous = await rig.read(thread);
  const body = { text, revision: previous.revision, requestId: randomUUID() };
  const response = await rig.put(body, thread);
  expect(response.status).toBe(200);
  return { body, saved: DraftSchema.parse(await response.json()) };
};

describe("Studio thread drafts over HTTP", () => {
  it("reads legacy empty drafts for every type and preserves complete Markdown outside the thread records", async () => {
    const before = rig.git("ls-tree", "-r", "HEAD", "threads");
    for (const type of ["question", "making", "topic"]) {
      const empty = await rig.read(type);
      expect(empty).toMatchObject({ text: "", editable: true });
      const { saved } = await save(markdown, type);
      expect(saved).toMatchObject({ text: markdown, editable: true });
      expect(saved.revision).not.toBe(empty.revision);
      expect(await rig.read(type)).toEqual(saved);
      expect(await readFile(join(rig.studioDir, `drafts/${type}.md`), "utf8")).toBe(markdown);
    }
    expect(rig.git("ls-tree", "-r", "HEAD", "threads")).toBe(before);
    const listing = await (await fetch(`${rig.baseUrl()}/api/desk/studio`)).json();
    expect(listing.studio.active.map((thread: { slug: string }) => thread.slug).sort()).toEqual(["making", "question", "topic"]);
    expect(listing.studio.inbox).toEqual([]);
    const search = await (await fetch(`${rig.baseUrl()}/api/desk/search?q=A%20draft`)).json();
    expect(search.hits).toEqual([]);
  });

  it("persists independent revisions across restarts, metadata edits, notes and an edit back to earlier text", async () => {
    const legacy = await rig.read();
    await rig.reopen();
    expect(await rig.read()).toEqual(legacy);
    const first = await save("First");
    const other = await rig.read("topic");
    const changed = await save("Second");
    const back = await save("First");
    expect(new Set([first.saved.revision, changed.saved.revision, back.saved.revision]).size).toBe(3);
    await rig.reopen();
    expect(await rig.read()).toEqual(back.saved);
    expect(await rig.read("topic")).toEqual(other);
    const threadPath = join(rig.studioDir, "threads/question.md");
    const thread = await readFile(threadPath, "utf8");
    await writeFile(threadPath, thread.replace("A separate note.", "An unrelated changed note.").replace("A fixture question?", "Renamed question?"));
    rig.git("add", "threads/question.md");
    rig.git("commit", "-qm", "Unrelated note and metadata edit");
    expect(await rig.read()).toEqual(back.saved);
  });

  it("keeps an older empty draft revision stable when only its notes change", async () => {
    const before = await rig.read();
    const path = join(rig.studioDir, "threads/question.md");
    await writeFile(path, (await readFile(path, "utf8")).replace("A separate note.", "A new note."));
    rig.git("add", "threads/question.md");
    rig.git("commit", "-qm", "Update notes before a draft exists");
    await rig.reopen();
    expect(await rig.read()).toEqual(before);
  });

  it("reuses legacy history reads without hiding a subsequently saved and missing draft", async () => {
    const historyReads: string[][] = [];
    const git: GitRunner = async (args, dir) => {
      if (args[0] === "log") historyReads.push(args);
      return spawnGit(args, dir);
    };
    const input = { options: { dir: rig.studioDir, maxActive: 5 }, areas: [], assistantName: "Assistant", thread: "question", git };
    const initial = await getStudioDraft(input);
    expect(initial).toMatchObject({ ok: true, draft: { text: "" } });
    expect(historyReads.length).toBeGreaterThan(0);
    const before = historyReads.length;
    expect(await getStudioDraft(input)).toEqual(initial);
    expect(historyReads).toHaveLength(before);
    await save(markdown);
    await rm(join(rig.studioDir, "drafts/question.md"));
    await rm(join(rig.studioDir, "drafts/question.json"));
    await expect(getStudioDraft(input)).rejects.toThrow("previously saved Studio draft is missing");
  });

  it("keeps a saved draft unchanged after parking, including a retry of its successful request", async () => {
    const { body, saved } = await save(markdown);
    const parked = await fetch(`${rig.baseUrl()}/api/desk/studio/act`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ act: "park", thread: "question", requestId: randomUUID() }),
    });
    expect(parked.status).toBe(200);
    await parked.arrayBuffer();
    const current = { ...saved, editable: false };
    expect(await rig.read()).toEqual(current);
    const before = rig.git("rev-parse", "HEAD");
    const replay = await rig.put(body);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject(current);
    expect(rig.git("rev-parse", "HEAD")).toBe(before);
  });

  it("serializes two clients sharing a revision and returns current text on the losing save", async () => {
    const other = await rig.anotherClient();
    const initial = await rig.read();
    const responses = await Promise.all([
      rig.put({ text: "Client one", revision: initial.revision, requestId: randomUUID() }),
      rig.put({ text: "Client two", revision: initial.revision, requestId: randomUUID() }, "question", other),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const current = await rig.read();
    for (const response of responses) expect(await response.json()).toMatchObject(current);
    expect(rig.git("rev-list", "--count", "HEAD")).toBe("2");
  });

  it("waits for a live writer beyond the lock grace period and includes the current draft in its conflict", async () => {
    const other = await rig.anotherClient();
    const initial = await rig.read();
    const hook = join(rig.studioDir, ".git/hooks/pre-commit");
    const marker = join(rig.studioDir, ".git/draft-hook-started");
    await writeFile(hook, "#!/bin/sh\ntouch .git/draft-hook-started\nsleep 6\n", { mode: 0o755 });
    const first = rig.put({ text: "Slow winner", revision: initial.revision, requestId: randomUUID() });
    const deadline = Date.now() + 5000;
    while (!await access(marker).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error("The slow draft commit did not start.");
      await Bun.sleep(10);
    }
    const second = rig.put({ text: "Slow loser", revision: initial.revision, requestId: randomUUID() }, "question", other);
    const [winner, loser] = await Promise.all([first, second]);
    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
    expect(await loser.json()).toMatchObject(DraftSchema.parse(await winner.json()));
    expect(rig.git("rev-list", "--count", "HEAD")).toBe("2");
  });

  it("retries a successful request after restart and later edits without another write or revision", async () => {
    const first = await save(markdown);
    const current = await save("Later text");
    await rig.reopen();
    const before = rig.git("rev-parse", "HEAD");
    const replay = await rig.put(first.body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(current.saved);
    expect(rig.git("rev-parse", "HEAD")).toBe(before);
    expect(await rig.read()).toEqual(current.saved);
  });

  it("accepts exactly one MiB of UTF-8 and JSON unicode escapes, rejecting one byte more without mutation", async () => {
    const text = "é".repeat(524288);
    const { saved } = await save(text);
    const head = rig.git("rev-parse", "HEAD");
    const tooLarge = await rig.put({ text: text + "x", revision: saved.revision, requestId: randomUUID() });
    expect(tooLarge.status).toBe(413);
    expect(await rig.read()).toEqual(saved);
    expect(rig.git("rev-parse", "HEAD")).toBe(head);
    const encoded = `{"text":"${"\\u0061".repeat(1048576)}","revision":"${saved.revision}","requestId":"${randomUUID()}"}`;
    const accepted = await fetch(`${rig.baseUrl()}/api/desk/studio/question/draft`, { method: "PUT", body: encoded, headers: { "content-type": "application/json" } });
    expect(accepted.status).toBe(200);
    expect(DraftSchema.parse(await accepted.json()).text).toBe("a".repeat(1048576));
  });

  it("refuses parked and closed saves with the current immutable draft", async () => {
    for (const thread of ["parked", "closed"]) {
      const current = await rig.read(thread);
      expect(current.editable).toBe(false);
      const result = await rig.put({ text: "Forbidden", revision: current.revision, requestId: randomUUID() }, thread);
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject(current);
    }
    expect(rig.git("rev-list", "--count", "HEAD")).toBe("1");
  });

  it("validates slugs, unknown threads and input, preserving the version header on errors", async () => {
    for (const thread of ["INVALID", "%2e%2e%2fquestion", "%ZZ"]) {
      const response = await rig.get(thread);
      expect(response.status).toBe(400);
      expect(response.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
    }
    expect((await rig.get("unknown")).status).toBe(404);
    expect((await rig.put({ text: "unknown", revision: "unknown", requestId: randomUUID() }, "unknown")).status).toBe(404);
    const path = `${rig.baseUrl()}/api/desk/studio/question/draft`;
    for (const body of ["not json", "{}", '{"text":1}', JSON.stringify({ text: "text", revision: "old", requestId: "bad" }), JSON.stringify({ text: "\ud800", revision: "old", requestId: randomUUID() })]) {
      expect((await fetch(path, { method: "PUT", body })).status).toBe(400);
    }
    expect((await fetch(path, { method: "POST" })).status).toBe(405);
    const response = await rig.get();
    expect(response.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("denies unauthorized reads and writes and foreign Host or Origin without mutation", async () => {
    const path = `${rig.baseUrl()}/api/desk/studio/question/draft`;
    for (const method of ["GET", "PUT"]) {
      const deniedHeaders: HeadersInit[] = [{ origin: "http://evil.example.org" }, { host: "evil.example.org" }, { "cf-access-authenticated-user-email": "other@example.org" }];
      for (const headers of deniedHeaders) {
        expect((await fetch(path, { method, headers })).status).toBe(403);
      }
    }
    expect(rig.git("rev-list", "--count", "HEAD")).toBe("1");
  });

  it("never treats missing saved files, invalid metadata or unreadable thread files as empty drafts", async () => {
    await save(markdown);
    await rm(join(rig.studioDir, "drafts/question.md"));
    expect((await rig.get()).status).toBe(500);
    await rm(join(rig.studioDir, "drafts/question.json"));
    expect((await rig.get()).status).toBe(500);
    await writeFile(join(rig.studioDir, "drafts/question.md"), markdown);
    await writeFile(join(rig.studioDir, "drafts/question.json"), "not json");
    expect((await rig.get()).status).toBe(500);
    await writeFile(join(rig.studioDir, "threads/topic.md"), "not a thread");
    expect((await rig.get("topic")).status).toBe(500);
  });

  it("refuses a symlinked draft directory and returns read errors as failures", async () => {
    const outside = join(rig.dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "question.md"), "Must stay outside");
    await symlink(outside, join(rig.studioDir, "drafts"));
    expect((await rig.get()).status).toBe(500);
    expect(await readFile(join(outside, "question.md"), "utf8")).toBe("Must stay outside");
  });

  it("rolls back both draft files when committing fails, then permits the same request to retry", async () => {
    await writeFile(join(rig.studioDir, ".gitattributes"), "drafts/*.md text eol=lf\n");
    rig.git("add", ".gitattributes");
    rig.git("commit", "-qm", "Normalize draft text in Git");
    const initial = await save("# Initial\r\n\r\nExact CRLF\r\n");
    const hook = join(rig.studioDir, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const body = { text: markdown, revision: initial.saved.revision, requestId: randomUUID() };
    const head = rig.git("rev-parse", "HEAD");
    expect((await rig.put(body)).status).toBe(500);
    expect(await rig.read()).toEqual(initial.saved);
    expect(rig.git("status", "--porcelain")).toBe("");
    expect(rig.git("rev-parse", "HEAD")).toBe(head);
    await rm(hook);
    expect((await rig.put(body)).status).toBe(200);
    expect((await rig.read()).text).toBe(markdown);
  });
});
