import { homedir } from "node:os";
import { checkTestHome } from "./lib/test-home";

const verdict = checkTestHome(process.env, homedir());
if (!verdict.ok) {
  console.error(verdict.reason);
  process.exit(2);
}
