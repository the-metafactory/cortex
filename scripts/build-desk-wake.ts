import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist/dashboard-v2/wake");
const cache = join(root, "node_modules/.cache/desk-wake");
const sources = [
  { name: "runtime", url: "https://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-2.0.1.tgz", sha: "031b235001fb41cc20ad405abe48e07891094047d6f462c9bdbb5a57434d2d54", dir: "package" },
  { name: "path", url: "https://registry.npmjs.org/path-browserify/-/path-browserify-1.0.1.tgz", sha: "74ad6965c6f8cb61d17b1798d48095c3238eca5707b517640a12150f17b8f93d", dir: "package" },
  { name: "model", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2", sha: "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a", dir: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01" },
];
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
await mkdir(cache, { recursive: true });
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "cortex-wake-"));
const manifest: Record<string, string> = {};
const emit = async (name: string, bytes: Uint8Array | string): Promise<void> => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  manifest[name] = sha(data);
  await Bun.write(join(out, name), data);
};
const replaceOnce = (source: string, from: string, to: string): string => {
  if (source.split(from).length !== 2) throw new Error("Pinned Sherpa loader no longer matches its browser adaptation");
  return source.replace(from, to);
};
try {
  for (const source of sources) {
    const archive = join(cache, source.sha);
    if (!(await Bun.file(archive).exists())) {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`Wake asset download failed: ${source.name} HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (sha(bytes) !== source.sha) throw new Error(`Wake archive integrity failed: ${source.name}`);
      await Bun.write(archive, bytes);
    }
    if (sha(new Uint8Array(await Bun.file(archive).arrayBuffer())) !== source.sha) throw new Error(`Wake cache integrity failed: ${source.name}`);
    const dir = join(temp, source.name);
    await mkdir(dir);
    const proc = Bun.spawn(["tar", "xf", archive, "-C", dir], { stderr: "pipe" });
    if (await proc.exited) throw new Error(`Wake archive extraction failed: ${source.name}`);
    const from = join(dir, source.dir);
    const copy = async (input: string, output: string): Promise<void> => emit(output, new Uint8Array(await Bun.file(join(from, input)).arrayBuffer()));
    if (source.name === "runtime") {
      let js = await Bun.file(join(from, "sherpa-onnx-wasm-nodejs.js")).text();
      js = replaceOnce(js, 'if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}', "");
      js = replaceOnce(js, 'for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}', 'if(ENVIRONMENT_IS_NODE){for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}}');
      js = replaceOnce(js, 'var nodePath=require("path");', 'var nodePath=ENVIRONMENT_IS_NODE?require("path"):Module["browserPath"];');
      await emit("runtime.js", js);
      await copy("sherpa-onnx-wasm-nodejs.wasm", "runtime.wasm");
      await copy("sherpa-onnx-kws.js", "kws.js");
    } else if (source.name === "path") {
      await copy("index.js", "path.js");
      await copy("LICENSE", "path.LICENSE");
    } else {
      for (const name of ["encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", "decoder-epoch-12-avg-2-chunk-16-left-64.onnx", "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx", "tokens.txt", "bpe.model", "README.md"]) await copy(name, name);
    }
  }
  for (const name of ["worker.js", "capture.js", "LICENSE"]) await emit(name, new Uint8Array(await Bun.file(join(root, "scripts/desk-wake", name)).arrayBuffer()));
  await Bun.write(join(out, "manifest.json"), JSON.stringify({ version: 1, sources, files: manifest }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
