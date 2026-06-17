/**
 * Unit tests for the Discord attachment multipart builder.
 *
 * `buildAttachmentForm` is the pure half of the file-upload path: it turns a
 * message + in-memory files into the `multipart/form-data` body Discord v10
 * expects — a `payload_json` part (message fields + an `attachments` array that
 * references each file by index) and one `files[n]` part per attachment. Pure
 * by design (no fs, no token) so the wire format is testable in isolation; the
 * CLI owns the file read + existence check.
 */
import { describe, expect, test } from "bun:test";
import { buildAttachmentForm, type AttachmentInput } from "../lib/discord";

function file(name: string, body: string): AttachmentInput {
  return { filename: name, bytes: new TextEncoder().encode(body) };
}

async function payloadOf(form: FormData): Promise<Record<string, unknown>> {
  return JSON.parse(form.get("payload_json") as string) as Record<string, unknown>;
}

describe("buildAttachmentForm", () => {
  test("payload_json carries content + an attachments array indexed to files[n]", async () => {
    const form = buildAttachmentForm("here you go", [file("a.md", "alpha"), file("b.json", "{}")]);
    const payload = await payloadOf(form);
    expect(payload.content).toBe("here you go");
    expect(payload.attachments).toEqual([
      { id: 0, filename: "a.md" },
      { id: 1, filename: "b.json" },
    ]);
  });

  test("one files[n] part per attachment, carrying the bytes + filename", async () => {
    const form = buildAttachmentForm("", [file("note.md", "the body")]);
    const part = form.get("files[0]");
    expect(part).toBeInstanceOf(Blob);
    const blob = part as Blob;
    expect((blob as File).name).toBe("note.md");
    expect(await blob.text()).toBe("the body");
    // No second file part.
    expect(form.get("files[1]")).toBeNull();
  });

  test("empty content is allowed (file-only message)", async () => {
    const form = buildAttachmentForm("", [file("only.txt", "x")]);
    const payload = await payloadOf(form);
    expect(payload.content).toBe("");
    expect(payload.attachments).toHaveLength(1);
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
  });

  test("no files → empty attachments array, no file parts", async () => {
    const form = buildAttachmentForm("just text", []);
    const payload = await payloadOf(form);
    expect(payload.attachments).toEqual([]);
    expect(form.get("files[0]")).toBeNull();
  });

  test("byte content round-trips exactly (binary-safe)", async () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const form = buildAttachmentForm("", [{ filename: "raw.bin", bytes }]);
    const blob = form.get("files[0]") as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});
