const module = { exports: {} };
let detector;
let stream;
let through = 0;
let epoch = 0;
const checked = async (name, manifest) => {
  const res = await fetch(`${name}?sha256=${manifest.files[name]}`);
  if (!res.ok) throw new Error(`Missing wake asset: ${name}. Rebuild the dashboard.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), x => x.toString(16).padStart(2, "0")).join("");
  if (manifest.files[name] !== hash) throw new Error(`Wake asset integrity failed: ${name}. Rebuild the dashboard.`);
  return bytes;
};
onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      const res = await fetch("manifest.json");
      if (!res.ok) throw new Error("Wake manifest missing. Rebuild the dashboard.");
      const manifest = await res.json();
      const modelFiles = [manifest.model.encoder, manifest.model.decoder, manifest.model.joiner, manifest.model.tokens];
      for (const name of ["path.js", "runtime.js", "kws.js"]) await checked(name, manifest);
      importScripts(`path.js?sha256=${manifest.files["path.js"]}`);
      const browserPath = module.exports;
      importScripts(`runtime.js?sha256=${manifest.files["runtime.js"]}`, `kws.js?sha256=${manifest.files["kws.js"]}`);
      const bytes = await checked("runtime.wasm", manifest);
      const runtime = await Module({ wasmBinary: bytes, browserPath, print: () => {}, printErr: () => {} });
      for (const file of modelFiles) runtime.FS.writeFile(`/${file}`, await checked(file, manifest));
      const vocabulary = new Set(runtime.FS.readFile("/tokens.txt", { encoding: "utf8" }).trim().split(/\r?\n/).map(line => line.split(" ")[0]));
      if (!data.options.tokens?.every(token => vocabulary.has(token) && !token.startsWith("<"))) throw new Error("Wake tokens are unsupported. Provision the phrase again.");
      const keyword = data.options.tokens.join(" ") + " @" + data.options.phrase.trim().replaceAll(" ", "_");
      detector = createKws(runtime, {
        featConfig: { samplingRate: 16000, featureDim: 80 },
        modelConfig: { transducer: { encoder: "/" + modelFiles[0], decoder: "/" + modelFiles[1], joiner: "/" + modelFiles[2] }, tokens: "/tokens.txt", numThreads: 1, provider: "cpu", debug: 0, modelingUnit: "bpe", bpeVocab: "" },
        maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: data.options.score, keywordsThreshold: data.options.threshold,
        keywords: "", keywordsBuf: keyword, keywordsBufSize: new TextEncoder().encode(keyword).length,
      });
      if (!detector.handle) throw new Error("Sherpa rejected the model and phrase.");
      stream = detector.createStream();
      postMessage({ type: "ready" });
    } else if (data.type === "reset") {
      stream.free();
      stream = detector.createStream();
      epoch = data.epoch;
    } else if (data.type === "audio" && stream) {
      stream.acceptWaveform(data.rate, data.samples);
      through = data.through;
      while (detector.isReady(stream)) {
        detector.decode(stream);
        const result = detector.getResult(stream);
        if (result.keyword) {
          const start = result.start_time + result.timestamps?.[0];
          if (!Number.isFinite(start) || start < 0) throw new Error("Sherpa did not report a valid keyword timestamp.");
          postMessage({ type: "wake", through, epoch, startFrame: Math.floor(start * data.rate) });
          detector.reset(stream);
        }
      }
      postMessage({ type: "processed", through, epoch });
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error) });
  }
};
