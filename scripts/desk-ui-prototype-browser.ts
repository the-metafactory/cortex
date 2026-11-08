import { chromium } from "playwright";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function openPrototypeBrowser(defaultOutput: string) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; };
  const origin = option("--origin", "http://127.0.0.1:33590");
  const executablePath = option("--browser", "/tmp/cortex-3290-browser/chrome-headless-shell");
  const output = option("--out", defaultOutput);
  await mkdir(output, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), "desk-ui-prototype-home-"));
  const browser = await chromium.launch({ executablePath, headless: true, env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TZ: "UTC" } });
  return { origin, output, browser };
}
