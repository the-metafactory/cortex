import { join } from "node:path";

export const WAKE_ASSET_NAMES = new Set([
  "manifest.json", "worker.js", "capture.js", "runtime.js", "runtime.wasm", "kws.js", "path.js", "path.LICENSE", "LICENSE", "README.md", "bpe.model", "tokens.txt",
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", "decoder-epoch-12-avg-2-chunk-16-left-64.onnx", "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
]);

export async function wakeAssetResponse(pathname: string, dashboardDist: string): Promise<Response> {
  const name = pathname.slice("/wake/".length);
  if (!WAKE_ASSET_NAMES.has(name)) return new Response("Not Found", { status: 404 });
  const file = Bun.file(join(dashboardDist, "wake", name));
  if (!(await file.exists())) return new Response("Wake assets are missing. Rebuild the dashboard.", { status: 503 });
  return new Response(file, { headers: { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Type": name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".json") ? "application/json" : "application/octet-stream" } });
}
