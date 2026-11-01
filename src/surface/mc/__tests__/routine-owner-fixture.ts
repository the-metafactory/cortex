import type { RoutineOptions } from "../desk/routine-command";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";

export const routineTestOptions: RoutineOptions = { composer: ["compose"], reflex: ["reflex"], target: "@test/pulse-flow", timeZone: "UTC", timeoutSeconds: 2, readTimeoutSeconds: 1 };
export const routineTestRuntime: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "Test", topN: 5, rangerUrl: "", areas: [], sources: [], routines: routineTestOptions } };
export const routineAnswer = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: "" });
