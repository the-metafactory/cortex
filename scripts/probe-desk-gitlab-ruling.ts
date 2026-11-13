import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GITLAB_BLOCKED, GITLAB_BODY, GITLAB_EXPLAINED } from "../src/surface/mc/__tests__/fixtures/gitlab-ruling";
import { initDatabase } from "../src/surface/mc/db/init";
import { composeDesk, type DeskOptions } from "../src/surface/mc/desk/compose";
import { readNodeBody, RULING_FALLBACK, RulingExplainLoop } from "../src/surface/mc/desk/ruling";
import { newRuling, RulingBox } from "../src/surface/mc/dashboard-v2/components/desk-ruling";

const now = Date.parse("2026-10-31T09:00:00Z");
const options: DeskOptions = {
  enabled: true, displayName: "Example", topN: 5, rangerUrl: "http://127.0.0.1:7311",
  rangerCli: { bin: "/example/ranger", config: "" }, somaBin: "/example/soma", areas: [], sources: [],
};
const key = `ranger:${GITLAB_BLOCKED.repo}#${GITLAB_BLOCKED.nodeId}`;
const expectedArgs = ["api", "--hostname", "gitlab.example.org", "--method", "GET", "projects/group%2Fsubgroup%2Fapp/issues/12"];
const issue = JSON.stringify({ iid: 12, description: GITLAB_BODY });

async function compose() {
  const db = initDatabase(":memory:");
  let explained = 0;
  const loop = new RulingExplainLoop(async (prompt) => {
    assert.equal(JSON.parse(prompt).body, GITLAB_BODY.trim());
    explained++;
    return GITLAB_EXPLAINED;
  });
  await loop.warm([GITLAB_BLOCKED]);
  const view = await composeDesk(db, options, undefined, {
    now, rulingExplain: loop,
    fetchImpl: async () => Response.json({ current: [], needsYou: [GITLAB_BLOCKED], maps: [] }),
  });
  db.close();
  const item = view.items.find(item => item.key === key);
  assert.ok(item, "GitLab blocked entry must reach the Desk");
  const html = renderToStaticMarkup(createElement(RulingBox, {
    item, draft: newRuling(key, "probe-ruling"), sending: false,
    onChange: () => {}, onConfirm: () => {}, onCancel: () => {},
  }));
  return { item, html, explained };
}

async function probeReadable(argvFile: string) {
  assert.equal(await readNodeBody(GITLAB_BLOCKED.repo, GITLAB_BLOCKED.nodeId), GITLAB_BODY);
  assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), expectedArgs);
  const readable = await compose();
  assert.deepEqual(readable.item.explanation, GITLAB_EXPLAINED);
  assert.equal(readable.explained, 1);
  assert.ok(readable.html.includes(GITLAB_EXPLAINED.sentence));
  for (const choice of GITLAB_EXPLAINED.choices) assert.ok(readable.html.includes(choice.label));
  assert.ok(!readable.html.includes(RULING_FALLBACK));
  assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), expectedArgs);

  return readable;
}

async function probeMissing() {
  assert.equal(await readNodeBody(GITLAB_BLOCKED.repo, GITLAB_BLOCKED.nodeId), null);
  const missing = await compose();
  assert.equal(missing.explained, 0);
  assert.equal(missing.item.explanation, undefined);
  assert.ok(missing.html.includes(RULING_FALLBACK));
  assert.ok(missing.html.includes("Ranger&#x27;s report"));
  assert.ok(missing.html.includes(missing.item.question?.reason ?? "missing report"));
  assert.equal(missing.item.question?.reason, "Blocked: the spec names both formats.");
  assert.equal(missing.item.actions[0]?.id, "ranger.rule");
}

if (process.argv[2] === "--readable") {
  await probeReadable(process.argv[3] ?? "");
} else if (process.argv[2] === "--missing") {
  await probeMissing();
} else {
  const dir = mkdtempSync(join(tmpdir(), "desk-gitlab-ruling-"));
  const argvFile = join(dir, "argv.json");
  const stub = join(dir, "glab");
  try {
    writeFileSync(stub, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(issue)});\n`);
    chmodSync(stub, 0o700);
    for (const mode of ["--readable", "--missing"]) {
      if (mode === "--missing") rmSync(stub);
      const child = Bun.spawnSync([process.execPath, import.meta.path, mode, argvFile], { env: { ...process.env, PATH: dir }, stdout: "pipe", stderr: "pipe" });
      assert.equal(child.exitCode, 0, child.stderr.toString());
    }
    console.log("PASS: GitLab ruling sentence and choices, validated host/project argv, and missing-glab fallback with Ranger report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
