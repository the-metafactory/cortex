import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { declaration, draftingBindings, readBindings, setup } from "./definition.mjs";

const dir = import.meta.dir;
const built = await Bun.build({ entrypoints: [`${dir}/adapter.mjs`], target: "bun", format: "esm", minify: true });
if (!built.success) throw new AggregateError(built.logs, "Kiln studio adapter build failed");
await writeFile(`${dir}/backend.mjs`, await built.outputs[0].text());
const sha256 = createHash("sha256").update(await readFile(`${dir}/backend.mjs`)).digest("hex");
await writeFile(`${dir}/desk-adapter.json`, `${JSON.stringify({
  format: "desk-adapter-package/1", packageId: "fictional.kiln-studio", packageVersion: "1.0.0", deskSdkRange: "^1.2.0", domainContractVersion: "1.0.0",
  backend: { entry: "backend.mjs", sha256 }, declaration, draftingBindings, readBindings, setup,
}, null, 2)}\n`);
