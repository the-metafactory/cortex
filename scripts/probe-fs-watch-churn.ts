// glossary-ignore: node
import { probeFsWatchChurn } from "../src/common/fs-watch-churn-probe";

const result = await probeFsWatchChurn();
console.log(JSON.stringify({ bun: Bun.version, platform: process.platform, ...result }));
process.exitCode = result.usable ? 0 : 1;
