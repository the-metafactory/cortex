import { join } from "node:path";
import { z } from "zod";

export const WAKE_MODEL_FILES = {
  encoder: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  decoder: "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
  joiner: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  tokens: "tokens.txt",
  bpe: "bpe.model",
  licenceDeclaration: "README.md",
};

export const WAKE_ASSET_NAMES = new Set([
  "manifest.json", "worker.js", "capture.js", "runtime.js", "runtime.wasm", "kws.js", "path.js", "path.LICENSE", "LICENSE",
  ...Object.values(WAKE_MODEL_FILES),
]);

const Manifest = z.object({ files: z.record(z.string(), z.string()) });

export async function wakeAssetResponse(pathname: string, dashboardDist: string, version?: string | null): Promise<Response> {
  const name = pathname.slice("/wake/".length);
  if (!WAKE_ASSET_NAMES.has(name)) return new Response("Not Found", { status: 404 });
  const file = Bun.file(join(dashboardDist, "wake", name));
  if (!(await file.exists())) return new Response("Wake assets are missing. Rebuild the dashboard.", { status: 503 });
  const manifest = version ? Manifest.safeParse(await Bun.file(join(dashboardDist, "wake/manifest.json")).json().catch(() => null)) : null;
  const immutable = manifest?.success === true && manifest.data.files[name] === version;
  return new Response(file, { headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "X-Content-Type-Options": "nosniff", "Content-Type": name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".json") ? "application/json" : "application/octet-stream" } });
}
