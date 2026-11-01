import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommittedStudioFile, readCommittedStudioFiles } from "./committed";
import { decodeCommittedBatch, readCommittedBatch } from "./committed-batch";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function rig(format = "sha1") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "committed-studio-")));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  git("init", "-q", `--object-format=${format}`); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(dir, "threads")); await mkdir(join(dir, "inbox"));
  const commit = () => { git("add", "."); git("commit", "-qm", "Fixture content"); return git("rev-parse", "HEAD"); };
  return { dir, git, commit };
}

for (const format of ["sha1", "sha256"]) test(`committed ${format} blobs preserve UTF-8, empty bodies and trailing newlines`, async () => {
  const r = await rig(format);
  const entries = [["threads/alpha.md", "Grüezi 🌍\n\nlast line"], ["inbox/empty.md", ""], ["inbox/newlines.md", "one\n\ntwo\n"], ["inbox/other.md", "日本語\n"], ["inbox/copy.md", "日本語\n"]] satisfies [string, string][];
  for (const [path, text] of entries) await writeFile(join(r.dir, path), text);
  const head = r.commit();
  const files = await readCommittedStudioFiles(r.dir, head);
  expect([...files.threads, ...files.inbox, ...files.proposals].sort((a, b) => a.path.localeCompare(b.path))).toEqual(entries.map(([path, text]) => ({ path, text })).sort((a, b) => a.path.localeCompare(b.path)));
  expect(await readCommittedStudioFile(r.dir, head, "absent.md")).toBeNull();
});

test("committed reads reject symbolic links and exact raw-byte mismatches", async () => {
  const r = await rig();
  await writeFile(join(r.dir, "threads/alpha.md"), "committed\n");
  await symlink("alpha.md", join(r.dir, "threads/link.md"));
  const head = r.commit();
  await expect(readCommittedStudioFiles(r.dir, head)).rejects.toThrow("regular file");
  await rm(join(r.dir, "threads/link.md")); r.git("add", "."); r.git("commit", "-qm", "Remove symbolic fixture");
  r.git("update-index", "--assume-unchanged", "threads/alpha.md");
  await writeFile(join(r.dir, "threads/alpha.md"), "uncommitted\n");
  expect(r.git("status", "--porcelain")).toBe("");
  await expect(readCommittedStudioFiles(r.dir, r.git("rev-parse", "HEAD"))).rejects.toThrow("committed source");
});

test("committed reads enforce the byte limit before loading oversized bodies", async () => {
  const r = await rig();
  await writeFile(join(r.dir, "threads/alpha.md"), "é".repeat(500001));
  const head = r.commit();
  await expect(readCommittedStudioFiles(r.dir, head)).rejects.toThrow("file limit");
});

test("batch framing uses bytes and rejects missing, truncated and extra objects", () => {
  const oid = "a".repeat(40);
  const text = Buffer.from("é🌍\n\n");
  const objects = [{ oid, size: text.length }, { oid: "b".repeat(40), size: 0 }];
  const bytes = Buffer.concat([Buffer.from(`${oid} blob ${text.length}\n`), text, Buffer.from(`\n${objects[1]?.oid} blob 0\n\n`)]);
  expect(decodeCommittedBatch(bytes, objects)).toEqual([text, Buffer.alloc(0)]);
  const wrongSeparator = Buffer.from(bytes); wrongSeparator[Buffer.byteLength(`${oid} blob ${text.length}\n`) + text.length] = 0;
  const nonAsciiHeader = Buffer.from(bytes); nonAsciiHeader[0] = 0xe1;
  for (const broken of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from("extra")]), Buffer.from(`${oid} missing\n`), Buffer.from(`${oid} blob ${text.length}\nshort\n`), Buffer.from(bytes.toString().replace(oid, "c".repeat(40))), Buffer.from(bytes.toString().replace(" blob ", " tree ")), Buffer.from(bytes.toString().replace(`blob ${text.length}`, `blob ${text.length + 1}`)), wrongSeparator, nonAsciiHeader]) expect(() => decodeCommittedBatch(broken, objects)).toThrow();
});

test("a missing Git object and oversized batch descriptor fail closed", async () => {
  const r = await rig();
  await expect(readCommittedBatch(r.dir, [{ oid: "a".repeat(40), size: 0 }])).rejects.toThrow("snapshot");
  await expect(readCommittedBatch(r.dir, [{ oid: "a".repeat(40), size: 1000001 }])).rejects.toThrow("input limits");
  for (const objects of [[], Array.from({ length: 65 }, () => ({ oid: "a".repeat(40), size: 0 })), Array.from({ length: 5 }, () => ({ oid: "a".repeat(40), size: 1000000 })), [{ oid: "a".repeat(40), size: -1 }]]) await expect(readCommittedBatch(r.dir, objects)).rejects.toThrow("input limits");
});

test("batch stdout cannot exceed the declared bounded object bytes", async () => {
  const r = await rig();
  await writeFile(join(r.dir, "threads/alpha.md"), "x".repeat(1000));
  r.commit();
  const oid = r.git("rev-parse", "HEAD:threads/alpha.md");
  await expect(readCommittedBatch(r.dir, [{ oid, size: 0 }])).rejects.toThrow("output limit");
});

test("several maximum-size blobs cross the bounded batch byte limit intact", async () => {
  const r = await rig();
  for (let n = 0; n < 5; n++) await writeFile(join(r.dir, `inbox/large-${n}.md`), `${n}` + "é".repeat(499999) + "\n");
  const head = r.commit();
  const files = await readCommittedStudioFiles(r.dir, head);
  expect(files.inbox).toHaveLength(5);
  for (const file of files.inbox) expect(Buffer.byteLength(file.text)).toBe(1000000);
});

test("one hundred committed files use a bounded number of real Git processes", async () => {
  const r = await rig();
  for (let n = 0; n < 100; n++) await writeFile(join(r.dir, `inbox/capture-${n}.md`), `unique${n}\n`);
  const head = r.commit();
  const bin = join(r.dir, ".git/bin"); await mkdir(bin);
  const calls = join(r.dir, ".git/git-calls");
  const realGit = Bun.which("git"); if (!realGit) throw new Error("Git unavailable");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(join(bin, "git"), `#!/bin/sh\nprintf x >> ${quote(calls)}\nexec ${quote(realGit)} "$@"\n`, { mode: 0o700 });
  const module = join(import.meta.dir, "committed.ts");
  const p = Bun.spawn([process.execPath, "-e", `const m=await import(${JSON.stringify(module)});const v=await m.readCommittedStudioFiles(${JSON.stringify(r.dir)},${JSON.stringify(head)});if(v.inbox.length!==100)throw new Error("Missing actual blobs");console.log(JSON.stringify(v.inbox.map(x=>x.text)));`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toHaveLength(100);
  expect((await readFile(calls, "utf8")).length).toBeLessThanOrEqual(8);
}, 30000);
