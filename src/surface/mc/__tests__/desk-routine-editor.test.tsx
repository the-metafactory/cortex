import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { handleDeskRoutineEditor } from "../api/desk-routine-editor";
import { parameterError, type RoutineDetail } from "../desk/routine-editor-contract";
import type { RoutineRunner } from "../desk/routine-command";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { DeskRoutineEditor } from "../dashboard-v2/components/desk-routine-editor";

const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "Test", topN: 5, rangerUrl: "", areas: [], sources: [], routines: { reflex: ["reflex"], composer: ["compose"], target: "@test/pulse-flow", timeZone: "UTC", timeoutSeconds: 10, readTimeoutSeconds: 1 } } };
const path = ["actions", 0, "retry", "attempts"];
function fixture() {
  let detail: RoutineDetail = { id: "example", revision: "a".repeat(64), writable: true, reason: "", flow: { name: "F_EXAMPLE", steps: [{ path: ["actions", 0], action: "retry", purpose: "Sequence", parameters: [{ name: "attempts", kind: "literal", value: 2 }], editable: [{ name: "attempts", type: "number", minimum: 1 }], reason: "Retry contract" }] } };
  let writes = 0;
  let refuse = false;
  let unavailable = false;
  let modelView = "";
  const run: RoutineRunner = async (argv) => {
    const answer = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: "" });
    if (unavailable) throw new Error("Owner unavailable");
    if (argv[0] === "compose") {
      modelView = argv[argv.indexOf("--routine-edit") + 1] ?? "";
      return answer({ status: "edit", patches: [{ path, value: 4 }] });
    }
    if (argv[2] === "list") return answer([{ id: "external", name: "External routine", schedule: "0 9 * * *", timezone: "Europe/Zurich", target: "@other/pulse-flow", policy: "disabled", readOnly: true }]);
    if (argv[2] === "inspect") return answer(detail);
    if (argv[2] === "update") {
      if (refuse) return answer({ error: { code: "invalid-input", message: "Owner validation refused attempts" } }, 1);
      writes++;
      detail = { ...detail, revision: "b".repeat(64), flow: detail.flow ? { ...detail.flow, steps: detail.flow.steps.map((step) => ({ ...step, parameters: [{ name: "attempts", kind: "literal", value: 4 }] })) } : null };
      return answer(detail);
    }
    throw new Error("Unexpected owner command");
  };
  const request = (body: unknown) => handleDeskRoutineEditor(new Request("http://localhost/api/desk/routine-editor", { method: "POST", body: JSON.stringify(body) }), runtime, run);
  return { run, request, detail, writes: () => writes, modelView: () => modelView, refuse: () => { refuse = true; }, unavailable: () => { unavailable = true; } };
}

describe("routine editor owner seam", () => {
  it("returns all-owner inventory with schedule, timezone, policy and authoritative name, including external routines", async () => {
    const f = fixture();
    const response = await handleDeskRoutineEditor(new Request("http://localhost/api/desk/routine-editor"), runtime, f.run);
    expect(await response.json()).toMatchObject([{ id: "external", name: "External routine", policy: "disabled", timezone: "Europe/Zurich" }]);
    f.unavailable();
    expect((await handleDeskRoutineEditor(new Request("http://localhost/api/desk/routine-editor"), runtime, f.run)).status).toBe(409);
  });
  it("AI proposals do not write, and only explicit update writes and reads back", async () => {
    const f = fixture();
    const base = { id: "example", revision: f.detail.revision };
    const proposal = await f.request({ ...base, action: "propose", text: "use four attempts" });
    expect(proposal.status).toBe(200);
    expect(f.writes()).toBe(0);
    expect(f.modelView()).toContain('"attempts"');
    const response = await f.request({ ...base, action: "update", patches: [{ path, value: 4 }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: "b".repeat(64) });
    expect(f.writes()).toBe(1);
    expect((await f.request({ ...base, action: "update", patches: [{ path, value: 6 }] })).status).toBe(409);
    expect(f.writes()).toBe(1);
  });
  it("invalid fields and owner refusal retain installed state with a field-specific reason", async () => {
    const f = fixture();
    const base = { id: "example", revision: f.detail.revision, action: "update" };
    const response = await f.request({ ...base, patches: [{ path, value: 0 }] });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("attempts");
    expect(f.writes()).toBe(0);
    expect((await f.request({ ...base, patches: [{ path: ["input", "token"], value: "bad" }] })).status).toBe(409);
    f.refuse();
    expect((await f.request({ ...base, patches: [{ path, value: 4 }] })).status).toBe(409);
    expect(f.writes()).toBe(0);
  });
  it("renders the real page loading surface and validates field types/ranges", () => {
    expect(renderToStaticMarkup(<DeskRoutineEditor onBack={() => {}} />)).toContain("Reading installed routines");
    expect(parameterError({ name: "attempts", type: "number", minimum: 1 }, NaN)).toContain("whole number");
    expect(parameterError({ name: "backoff", type: "string", enum: ["constant"] }, "invalid")).toContain("allowed");
  });
});
