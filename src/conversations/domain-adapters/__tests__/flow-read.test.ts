import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFlowReadAdapter } from "../flow/read";
import { releasedObjects } from "./fixtures/balance-read-fixtures";
import { assertCloudReaderDenied, assertDeletedFlowAbsent, assertNoFlowLeak, assertSavedFlowMatches, directQuery, FLOW_NAME, openFlowReadRig, openWithStubPulse, type FlowReadRig } from "./fixtures/flow-read-fixtures";

const opened: FlowReadRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });
async function open(options: Parameters<typeof openFlowReadRig>[0] = {}) { const rig = await openFlowReadRig(options); opened.push(rig); return rig; }

describe("inactive saved Flow reads through the registered host query runner", () => {
  test("query matches saved Pulse listing and read matches show, with connection-qualified identity", async () => {
    const rig = await open();
    expect(Bun.which("pulse", { PATH: rig.env.PATH })).toBeNull();
    expect((await rig.save()).status).toBe("saved");
    await assertSavedFlowMatches(rig);
  });

  test("deletion confirms absence while unreadable owner data remains unavailable", async () => {
    const rig = await open();
    await rig.save();
    const shown = await rig.pulse(["show", FLOW_NAME]);
    await assertDeletedFlowAbsent(rig, shown);
    await writeFile(join(rig.flowsDir, `${FLOW_NAME}.yaml`), "name: [invalid");
    const unreadable = await rig.query();
    expect(unreadable.result.status).toBe("unavailable");
    expect(unreadable.result.noMatch).toBe(false);
    assertNoFlowLeak(unreadable);
  });

  test("local is the connection default, denied before Pulse runs for cloud readers, and policy is rechecked at release", async () => {
    const rig = await open({ conversationPolicy: "cloud" });
    await rig.save();
    expect(rig.adapter.dataPolicy).toBe("local");
    await assertCloudReaderDenied(rig);
    await rig.setPolicy("cloud");
    expect((await rig.query()).result.status).toBe("ok");
    expect((await rig.read()).result.status).toBe("ok");
    rig.rig.hooks.query = async (request, signal) => { const page = await rig.adapter.query(request, signal); await rig.setPolicy("local"); return page; };
    const withheld = await rig.query();
    expect(withheld.result.status).not.toBe("ok");
    expect(withheld.released).toBeUndefined();
  });

  test("pagination retains provider order and restarts when saved content changes", async () => {
    const rig = await open();
    await rig.save();
    await rig.save("F_SECOND_EXAMPLE");
    const first = await rig.query(1);
    expect(first.result.groups[0]?.coverage).toBe("more");
    const next = await rig.continueQuery(first);
    expect(next.result.status).toBe("ok");
    expect([first, next].flatMap(step => releasedObjects(step.released).map(object => object.ref.canonicalId))).toEqual([FLOW_NAME, "F_SECOND_EXAMPLE"]);
    const again = await rig.query(1);
    await rig.save("F_THIRD_EXAMPLE");
    const changed = await rig.continueQuery(again);
    expect(changed.result.restartRequired).toBe(true);
    expect(changed.released).toBeUndefined();
  });
});

describe("Flow registration and unavailable configuration", () => {
  test("module construction enables nothing and declares only saved query and read", async () => {
    const rig = await open();
    const before = JSON.stringify(await rig.rig.service.inspectHostRecords());
    const adapter = createFlowReadAdapter(rig.source);
    expect(adapter.declaration.capabilities.map(capability => [capability.capabilityId, capability.kind])).toEqual([["flow.saved.query", "query"], ["flow.saved.read", "query"]]);
    expect(adapter.bindings.observations).toEqual({});
    expect(JSON.stringify(await rig.rig.service.inspectHostRecords())).toBe(before);
  });
  test("unconfigured Pulse and missing executable assert no match or owner evidence", async () => {
    for (const options of [{ configured: false }, { binary: "/unavailable/pulse" }]) {
      const rig = await open(options);
      for (const result of [await rig.query(), await rig.read()]) {
        expect(result.result.status).toBe("unavailable");
        expect(result.result.noMatch).toBe(false);
        assertNoFlowLeak(result);
      }
    }
  });
  test("a saved listing followed by an arc fallback or mismatched show never releases an object", async () => {
    const listed = { name: FLOW_NAME, source: "saved", sha256: "a".repeat(64), provenance: null, path: "/example/flow.yaml", package: null };
    for (const changed of [{ source: "arc" }, { name: "F_ANOTHER_EXAMPLE" }, { sha256: "b".repeat(64) }, { yaml: { private: "F_PRIVATE" } }]) {
      const { package: _package, ...metadata } = listed;
      const shown = { ...metadata, yaml: "name: F_SAVED_EXAMPLE", ...changed };
      const broken = await openWithStubPulse(`if [ "$2" = "list" ]; then\nprintf '%s\\n' '${JSON.stringify({ status: "ok", flows: [listed] })}'\nelse\nprintf '%s\\n' '${JSON.stringify(shown)}'\nfi\n`);
      opened.push(broken);
      await expect(directQuery(broken, "flow.saved.read", { ref: { adapterId: "flow", connectionId: broken.source.connectionId, objectType: "saved", canonicalId: FLOW_NAME } }, 1)).rejects.toThrow(/^flow.source_unavailable$/);
      const result = await broken.read();
      expect(result.result.status).toBe("unavailable");
      expect(result.released).toBeUndefined();
      expect(JSON.stringify(result.result)).not.toMatch(/F_SAVED_EXAMPLE|F_ANOTHER_EXAMPLE|sha256/);
    }
  });
  test("successful exits with non-JSON or malformed JSON are unavailable", async () => {
    for (const output of ["not JSON", '{"status":"ok","flows":[{"source":"saved","name":"F_PRIVATE"}]}']) {
      const broken = await openWithStubPulse(`printf '%s\\n' '${output}'\n`);
      opened.push(broken);
      await expect(directQuery(broken, "flow.saved.query", { stack: broken.adapter.destination }, 20)).rejects.toThrow(/^flow.source_unavailable$/);
      const result = await broken.query();
      expect(result.result.status).toBe("unavailable");
      expect(result.released).toBeUndefined();
      expect(JSON.stringify(result.result)).not.toContain("F_PRIVATE");
    }
  });
  test("invalid input and handler context expose only the uniform unavailable error", async () => {
    const rig = await open();
    for (const capabilityId of ["flow.saved.query", "flow.saved.read"]) {
      await expect(directQuery(rig, capabilityId, { private: "F_PRIVATE" }, 20)).rejects.toThrow(/^flow.source_unavailable$/);
      expect(() => rig.adapter.bindings.handlers[capabilityId]?.({}, { private: "F_PRIVATE" })).toThrow(/^flow.source_unavailable$/);
    }
  });
});
