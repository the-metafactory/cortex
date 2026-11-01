import { homedir, tmpdir } from "node:os";
import { checkTestHome, checkTestTmp } from "./lib/test-home";

for (const verdict of [checkTestHome(process.env, homedir()), checkTestTmp(process.env, tmpdir())]) {
  if (!verdict.ok) {
    console.error(verdict.reason);
    process.exit(2);
  }
}
