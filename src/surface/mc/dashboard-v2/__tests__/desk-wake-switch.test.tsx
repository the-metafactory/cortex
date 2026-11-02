import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WAKE_OFF_LINE, WakeStatus, WakeSwitch, wakeSwitch } from "../components/desk-voice";
import { WAKE_NEEDS_ELEVENLABS, WAKE_NEEDS_MIC, ownsSpace, wakeBlockReason } from "../hooks/use-desk-voice";
import { DeskWakeSchema, WAKE_BPE_SHA } from "../../../../common/types/desk-wake";
import type { WakeState } from "../lib/desk-wake";

const OFF: WakeState = { phase: "off" };
const LISTENING: WakeState = { phase: "listening", line: "Listening for “Hey Ivy”" };
const render = (state: WakeState, blocked: string | null = null) => renderToStaticMarkup(<WakeSwitch state={state} blocked={blocked} onToggle={() => {}} assistantName="Ivy" />);
const provisioned = DeskWakeSchema.parse({ enabled: true, assistantName: "Ivy", phrase: "Hey Ivy", tokens: ["▁HE", "Y", "▁IVY"], tokenizerSha256: WAKE_BPE_SHA });
const env = { navigator: { mediaDevices: { getUserMedia: async () => new MediaStream() } } };

describe("WakeSwitch", () => {
  it("is a native button switch named for the assistant, so Space and Enter toggle it", () => {
    const html = render(OFF);
    expect(html).toMatch(/^<button type="button" role="switch" class="desk-wake-switch" aria-checked="false"/);
    expect(html).toContain('aria-label="Wake for Ivy"');
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain(`title="${WAKE_OFF_LINE}"`);
    expect(ownsSpace({ tagName: "BUTTON", getAttribute: () => "switch" } as unknown as EventTarget)).toBe(true);
  });

  it("is checked while wake listens and shows the state in the title and the status line", () => {
    expect(render(LISTENING)).toContain('aria-checked="true"');
    expect(render(LISTENING)).toContain("title=\"Listening for “Hey Ivy”\"");
    expect(renderToStaticMarkup(<WakeStatus state={LISTENING} blocked={null} />)).toBe('<p class="desk-wake-status" role="status" aria-live="polite">Listening for “Hey Ivy”</p>');
    expect(renderToStaticMarkup(<WakeStatus state={OFF} blocked={null} />)).toBe('<p class="desk-wake-status" role="status" aria-live="polite"></p>');
  });

  it("is disabled with its reason on hover and for assistive technology when wake cannot start", () => {
    const html = render(OFF, WAKE_NEEDS_ELEVENLABS);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(`title="${WAKE_NEEDS_ELEVENLABS}"`);
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? "missing";
    expect(html).toContain(`id="${described}" hidden="">${WAKE_NEEDS_ELEVENLABS}</span>`);
    expect(wakeSwitch(OFF, WAKE_NEEDS_MIC)).toEqual({ on: false, disabled: true, failed: false, hint: WAKE_NEEDS_MIC, status: "" });
    expect(renderToStaticMarkup(<WakeStatus state={{ phase: "unavailable", line: "Old failure." }} blocked={WAKE_NEEDS_MIC} />)).toBe('<p class="desk-wake-status" role="status" aria-live="polite"></p>');
  });

  it("keeps a running wake shown on and switchable even if a block reason appears", () => {
    expect(wakeSwitch(LISTENING, WAKE_NEEDS_MIC)).toEqual({ on: true, disabled: false, failed: false, hint: LISTENING.line, status: LISTENING.line });
  });

  it("stays switchable after a runtime failure and reports it under the bar", () => {
    const failed: WakeState = { phase: "unavailable", line: "The microphone was lost or permission was revoked. Switch wake on to try again." };
    expect(wakeSwitch(failed, null)).toEqual({ on: false, disabled: false, failed: true, hint: failed.line, status: failed.line });
    expect(renderToStaticMarkup(<WakeStatus state={failed} blocked={null} />)).toContain('class="desk-wake-status failed"');
  });
});

describe("wakeBlockReason", () => {
  it("lets a provisioned ElevenLabs wake start when the browser offers a microphone", () => {
    expect(wakeBlockReason({ enabled: true, input: "elevenlabs", output: "browser", wake: provisioned }, env)).toBeNull();
    expect(wakeBlockReason({ enabled: true, input: "elevenlabs", output: "browser", wake: provisioned }, undefined)).toBeNull();
  });

  it("names why wake cannot start: browser transcription, missing provisioning or no microphone", () => {
    expect(wakeBlockReason({ enabled: true, input: "browser", output: "browser", wake: provisioned }, env)).toBe(WAKE_NEEDS_ELEVENLABS);
    expect(wakeBlockReason({ enabled: true, input: "elevenlabs", output: "browser", wake: { ...provisioned, tokens: undefined } }, env)).toContain("Provision this phrase");
    expect(wakeBlockReason({ enabled: true, input: "elevenlabs", output: "browser", wake: provisioned }, { navigator: {} })).toBe(WAKE_NEEDS_MIC);
    expect(wakeBlockReason({ enabled: true, input: "browser", output: "browser" }, env)).toBeNull();
  });
});
