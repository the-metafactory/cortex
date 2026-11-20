import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DraftSchema, openStudioDraftRig } from "../testing/studio-draft-rig";
import { DESK_API_VERSION } from "../../../desk-api/api-version";

let rig: Awaited<ReturnType<typeof openStudioDraftRig>>;
beforeEach(async () => { rig = await openStudioDraftRig(); });
afterEach(async () => { await rig.close(); });
const Metadata = z.object({ id: z.uuid(), revision: z.string(), transition: z.enum(["park", "close"]), at: z.iso.datetime() }).strict();
const Snapshot = Metadata.extend({ text: z.string() });
const Listing = z.object({ snapshots: z.array(Metadata) }).strict();
const exact = "\ufeff \r\n# Full answer 🦊\r\n\r\n---\n\nReasoning\t\n\n$Id$\n ";
const save = async (text: string, thread = "question") => {
  const before = await rig.read(thread);
  const response = await rig.put({ text, revision: before.revision, requestId: randomUUID() }, thread);
  expect(response.status).toBe(200);
  return DraftSchema.parse(await response.json());
};
const list = async (thread = "question") => {
  const response = await rig.snapshots(thread);
  expect(response.status).toBe(200);
  return Listing.parse(await response.json()).snapshots;
};
const act = (body: object) => rig.act({ requestId: randomUUID(), thread: "question", ...body });
const close = { act: "close", outcome: "dropped", text: "A short summary" };
const waitForCommit = async () => {
  const marker = join(rig.studioDir, ".git/snapshot-started");
  const deadline = Date.now() + 5000;
  while (!await access(marker).then(() => true, () => false)) {
    if (Date.now() > deadline) throw new Error("The slow commit did not start.");
    await Bun.sleep(10);
  }
};

describe("Studio draft snapshots through HTTP", () => {
  it("rejects missing and stale preconditions for close and park without any mutation", async () => {
    const initial = await rig.read();
    const saved = await save(exact);
    const head = rig.git("rev-parse", "HEAD");
    for (const body of [{ act: "park" }, close]) {
      for (const precondition of [{}, { draftRevision: initial.revision }]) {
        const response = await act({ ...body, ...precondition });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject(saved);
        expect(await list()).toEqual([]);
        expect(rig.git("rev-parse", "HEAD")).toBe(head);
        expect(await rig.read()).toEqual(saved);
      }
    }
  });

  it("freezes exact text atomically, preserves earlier files through unpark/edit/close, and replays without duplicates", async () => {
    const gitWrapper = join(rig.dir, "bin/git");
    await writeFile(gitWrapper, (await readFile(gitWrapper, "utf8")).replace(' "$@"', ' -c "filter.snapshot-test.clean=sed s/Reasoning/Changed/g" "$@"'));
    await writeFile(join(rig.studioDir, ".gitattributes"), "*.json text eol=lf ident filter=snapshot-test\n");
    rig.git("add", ".gitattributes");
    rig.git("commit", "-qm", "Inherited attributes");
    const saved = await save(exact);
    const park = { act: "park", thread: "question", draftRevision: saved.revision, requestId: randomUUID() };
    expect((await rig.act(park)).status).toBe(200);
    expect(await rig.read()).toEqual({ ...saved, editable: false });
    const first = (await list())[0];
    if (!first) throw new Error("Missing park snapshot");
    expect(first).toMatchObject({ revision: saved.revision, transition: "park" });
    const firstResponse = await rig.snapshots("question", first.id);
    expect(firstResponse.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    const snapshot = Snapshot.parse(await firstResponse.json());
    expect(snapshot).toEqual({ ...first, text: exact });
    const path = `draft-snapshots/question/${first.id}.json`;
    const bytes = await readFile(join(rig.studioDir, path));
    expect(rig.gitRaw("show", `HEAD:${path}`)).toBe(bytes.toString());
    expect((await act({ act: "unpark" })).status).toBe(200);
    expect((await rig.read()).editable).toBe(true);
    const later = await save("[Deliverable](https://example.org/result) and its description");
    expect((await act({ ...close, outcome: "shipped", draftRevision: later.revision })).status).toBe(200);
    const entries = await list();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(2);
    expect(entries.find(entry => entry.transition === "close")).toMatchObject({ revision: later.revision });
    expect(await readFile(join(rig.studioDir, path))).toEqual(bytes);
    const head = rig.git("rev-parse", "HEAD");
    await rig.reopen();
    expect((await rig.act(park)).status).toBe(200);
    expect(rig.git("rev-parse", "HEAD")).toBe(head);
    expect(await list()).toEqual(entries);
    expect(Snapshot.parse(await (await rig.snapshots("question", first.id)).json())).toEqual(snapshot);
    await rm(join(rig.studioDir, "drafts/question.md"));
    expect(Snapshot.parse(await (await rig.snapshots("question", first.id)).json())).toEqual(snapshot);
  });

  it("keeps legacy empty closure compatibility and existing decision validation with full draft reasoning separate", async () => {
    const initial = await rig.read("making");
    expect((await act({ ...close, outcome: "decided" })).status).toBe(400);
    expect(await list()).toEqual([]);
    expect((await act({ ...close, thread: "making" })).status).toBe(200);
    const first = (await list("making"))[0];
    if (!first) throw new Error("Missing legacy closure snapshot");
    expect(Snapshot.parse(await (await rig.snapshots("making", first.id)).json())).toMatchObject({ text: "", revision: initial.revision, transition: "close" });
    expect((await act({ act: "park", thread: "topic" })).status).toBe(200);
    expect(await list("topic")).toHaveLength(1);
    const saved = await save(exact);
    expect((await act({ ...close, outcome: "decided", expect: "An observable change", reviewOn: "2099-12-15", draftRevision: saved.revision })).status).toBe(200);
    const source = await readFile(join(rig.studioDir, "threads/question.md"), "utf8");
    expect(source).toContain("A short summary");
    expect(source).toContain("An observable change");
    expect(source).toContain("2099-12-15");
    expect(source).not.toContain(exact);
    const decided = (await list())[0];
    if (!decided) throw new Error("Missing decided snapshot");
    expect(Snapshot.parse(await (await rig.snapshots("question", decided.id)).json()).text).toBe(exact);
  });

  it("refuses blank shipped drafts, including a saved empty draft, but permits empty park/drop with a revision", async () => {
    expect((await act({ ...close, outcome: "shipped" })).status).toBe(400);
    for (const text of ["", " \r\n\t "]) {
      const saved = await save(text);
      const head = rig.git("rev-parse", "HEAD");
      const response = await act({ ...close, outcome: "shipped", draftRevision: saved.revision });
      expect(response.status).toBe(400);
      expect(rig.git("rev-parse", "HEAD")).toBe(head);
      expect(await rig.read()).toEqual(saved);
      expect(await list()).toEqual([]);
    }
    const empty = await save("");
    expect((await act({ act: "park" })).status).toBe(409);
    expect((await act({ act: "park", draftRevision: empty.revision })).status).toBe(200);
    expect((await act({ ...close, draftRevision: empty.revision })).status).toBe(200);
    expect(await list()).toHaveLength(2);
  });

  it("guards implicit parking of edited drafts and snapshots legacy make-room transitions", async () => {
    const saved = await save(exact);
    for (const question of ["One more place", "Last place"]) {
      expect((await act({ act: "open", from: "conversation", question, area: "lab", link: "https://example.org/conversation" })).status).toBe(200);
    }
    const head = rig.git("rev-parse", "HEAD");
    const refused = await act({ act: "unpark", thread: "parked", park: "question" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject(saved);
    expect(await list()).toEqual([]);
    expect(rig.git("rev-parse", "HEAD")).toBe(head);
    expect((await act({ act: "unpark", thread: "parked", park: "topic" })).status).toBe(200);
    expect(await list("topic")).toHaveLength(1);
    expect((await rig.read("topic")).editable).toBe(false);
  });

  it("rolls back thread and snapshot on failed commits and retries the same request once", async () => {
    const saved = await save(exact);
    const head = rig.git("rev-parse", "HEAD");
    const hook = join(rig.studioDir, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const body = { ...close, thread: "question", draftRevision: saved.revision, requestId: randomUUID() };
    expect((await rig.act(body)).status).toBe(500);
    expect(rig.git("rev-parse", "HEAD")).toBe(head);
    expect(rig.git("status", "--porcelain")).toBe("");
    expect(await rig.read()).toEqual(saved);
    expect(await list()).toEqual([]);
    await rm(hook);
    expect((await rig.act(body)).status).toBe(200);
    expect((await rig.act(body)).status).toBe(200);
    expect(await list()).toHaveLength(1);
  });

  it("serializes a close winner against a concurrent PUT from another process", async () => {
    const other = await rig.anotherClient();
    const saved = await save(exact);
    await writeFile(join(rig.studioDir, ".git/hooks/pre-commit"), "#!/bin/sh\ntouch .git/snapshot-started\nsleep 1\n", { mode: 0o755 });
    const closing = act({ ...close, draftRevision: saved.revision });
    await waitForCommit();
    const putting = rig.put({ text: "Concurrent overwrite", revision: saved.revision, requestId: randomUUID() }, "question", other);
    const [closed, put] = await Promise.all([closing, putting]);
    expect(closed.status).toBe(200);
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ ...saved, editable: false });
    const entry = (await list())[0];
    if (!entry) throw new Error("Missing race snapshot");
    expect(Snapshot.parse(await (await rig.snapshots("question", entry.id)).json()).text).toBe(exact);
  });

  it("refuses a close racing a PUT winner and returns the committed revision on retry", async () => {
    const other = await rig.anotherClient();
    const saved = await save(exact);
    const hook = join(rig.studioDir, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\ntouch .git/snapshot-started\nsleep 1\n", { mode: 0o755 });
    const putting = rig.put({ text: "New winner", revision: saved.revision, requestId: randomUUID() }, "question", other);
    await waitForCommit();
    const body = { ...close, thread: "question", draftRevision: saved.revision, requestId: randomUUID() };
    const racingClose = await rig.act(body);
    expect(racingClose.status).toBe(409);
    expect(await racingClose.json()).toMatchObject({ text: "New winner", editable: true });
    expect((await putting).status).toBe(200);
    await rm(hook);
    const current = await rig.read();
    const stale = await rig.act(body);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject(current);
    expect(await list()).toEqual([]);
  });

  it("validates both ids, handles unknowns and enforces read authority and rebind gates", async () => {
    const saved = await save(exact);
    expect((await act({ act: "park", draftRevision: saved.revision })).status).toBe(200);
    const entry = (await list())[0];
    if (!entry) throw new Error("Missing authority fixture");
    for (const thread of ["INVALID", "%2e%2e%2fquestion", "%ZZ", "question%0a"]) expect((await rig.snapshots(thread)).status).toBe(400);
    for (const id of ["INVALID", "%2e%2e%2fquestion", "%ZZ", `${entry.id}%0a`]) expect((await rig.snapshots("question", id)).status).toBe(400);
    expect((await rig.snapshots("unknown")).status).toBe(404);
    expect((await rig.snapshots("unknown", entry.id)).status).toBe(404);
    expect((await rig.snapshots("question", randomUUID())).status).toBe(404);
    for (const suffix of ["", `/${entry.id}`]) {
      const url = `${rig.baseUrl()}/api/desk/studio/question/draft/snapshots${suffix}`;
      expect((await fetch(url, { method: "PUT" })).status).toBe(405);
      const denials: HeadersInit[] = [{ origin: "http://evil.example.org" }, { host: "evil.example.org" }, { "cf-access-authenticated-user-email": "other@example.org" }];
      for (const headers of denials) {
        const response = await fetch(url, { headers });
        expect(response.status).toBe(403);
        expect(response.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
      }
    }
    const path = join(rig.studioDir, `draft-snapshots/question/${entry.id}.json`);
    await rm(path);
    await symlink(join(rig.studioDir, "drafts/question.md"), path);
    expect((await rig.snapshots("question", entry.id)).status).toBe(500);
  });
});
