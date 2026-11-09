import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CredentialSetupError } from "../src/common/config/desk-credential-broker";
import { brokerRig, SYNTHETIC_TOKEN } from "../src/common/config/desk-credential-broker-fixtures";

const priorHome = process.env.HOME;
const lines: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
const rig = await brokerRig();
process.env.HOME = rig.dir;
const setup = { packageId: "example-package", setupSchemaId: "example-setup", version: "1.0.0" };
const inputs = { primary: { token: SYNTHETIC_TOKEN }, backup: { token: `${SYNTHETIC_TOKEN}-backup` } };
try {
  const owner = await rig.session("owner");
  const other = await rig.session("other");
  const begun = await rig.broker().begin(owner, setup);
  rig.hooks.publish = () => Promise.reject(new Error("synthetic interruption before connection publication"));
  const interrupted = await rig.broker().provision(owner, begun.requestId, inputs);
  assert.equal(interrupted.status, "incomplete");
  assert.equal(rig.published.length, 0);
  assert.equal((await rig.broker().status(owner, begun.connectionId))?.status, "incomplete");
  delete rig.hooks.publish;
  await rig.reopen();
  const reopened = await rig.session("owner");
  const resumed = await rig.broker().provision(reopened, begun.requestId);
  assert.equal(resumed.status, "active");
  assert.deepEqual(await rig.broker().provision(reopened, begun.requestId), resumed);
  assert.equal(rig.published.length, 1);
  assert.equal(readdirSync(join(rig.configRoot, "secrets/cortex")).length, 2);
  const fresh = await rig.broker().begin(reopened, setup);
  for (const attempt of [
    () => rig.broker().provision(other, begun.requestId, inputs),
    () => rig.broker().begin(other, setup, begun.connectionId),
    () => rig.broker().provision(reopened, fresh.requestId, { primary: inputs.primary, Primary: inputs.primary }),
    () => rig.broker().provision(reopened, fresh.requestId, { unknown: { token: "x" } }),
  ]) {
    await assert.rejects(attempt, CredentialSetupError);
  }
  const seen = JSON.stringify([begun, interrupted, resumed, rig.published, lines]);
  assert.ok(!seen.includes(SYNTHETIC_TOKEN));
  await rig.host().close();
  const files = readdirSync(join(rig.dir, "host"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  assert.ok(files.every(entry => !readFileSync(join(entry.parentPath, entry.name)).toString("latin1").includes(SYNTHETIC_TOKEN)));
  await rig.reopen();
  process.stderr.write = realWrite;
  console.log("Synthetic credential setup: token stored in temp arc storage; interrupted publication left no active connection; reopen resumed the same revision once; cross-principal, cross-connection and colliding-slot writes rejected; no token in responses, logs or the host store.");
} finally {
  process.stderr.write = realWrite;
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  await rig.close();
}
