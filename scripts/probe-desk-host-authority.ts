import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityRig } from "../src/conversations/authority-fixtures";
import { resultFixture } from "../src/conversations/domain-adapters/operations/fixtures";
import type { Attempt } from "../src/conversations/domain-adapters/operations/types";

const home = await mkdtemp(join(tmpdir(), "authority-probe-home-"));
const priorHome = process.env.HOME;
process.env.HOME = home;
let rig: Awaited<ReturnType<typeof authorityRig>> | undefined;
try {
  rig = await authorityRig({ dir: join(home, "store") });
  const first = await rig.confirm();
  assert.equal(first.kind, "allowed");
  assert.deepEqual(await rig.confirm(), first);
  const request = await rig.prepare();
  await rig.reopen();
  assert.equal((await rig.service.inspectHostRecords()).confirmations.length, 1);
  await rig.revokeConnection();
  assert.equal((await rig.service.dispatch(rig.context, request, rig.lease)).kind, "denied");
  assert.equal(rig.calls.dispatch, 0);
  const evidence = resultFixture({ ...rig.approval, authority: request.authority }, { attemptId: request.attemptId } as Attempt, "succeeded");
  const reference = await rig.service.ingestLateEvidence(request.operationId, evidence);
  assert.equal((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.journal.state, "succeeded");
  const discord = await rig.service.authenticate("discord-session");
  assert.ok(discord);
  assert.equal((await rig.service.release(discord, reference, { kind: "discord", conversationId: request.snapshot.provenance.conversationId })).kind, "withheld");
  assert.equal(rig.calls.sends.length, 0);
  await rig.reopen();
  assert.ok((await rig.service.inspectHostRecords()).evidence[reference]);
  console.log("Synthetic host authority: one durable confirmation; reopen preserved records; revoked admission made zero calls; late success stayed private; Discord release withheld.");
} finally {
  await rig?.close();
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  await rm(home, { recursive: true, force: true });
}
