import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexReconnectView } from "../components/desk-codex-reconnect";
import type { LoginView } from "../lib/codex-auth";

const noop = (): void => undefined;
const render = (login: LoginView | null, error: string | null = null): string => renderToStaticMarkup(<CodexReconnectView login={login} error={error} busy={false} onStart={noop} onCancel={noop} onAnswer={noop} />);

describe("the Reconnect Codex panel", () => {
  it("offers Reconnect Codex before a sign-in starts", () => {
    expect(render(null)).toContain(">Reconnect Codex</button>");
  });

  it("shows the sign-in link and the paste field while waiting, with Cancel", () => {
    const html = render({ id: "1", state: "awaiting-input", url: "https://auth.example.invalid/x", prompt: { message: "Paste the redirect URL" } });
    expect(html).toContain(`href="https://auth.example.invalid/x"`);
    expect(html).toContain("Paste the redirect URL");
    expect(html).toContain("Cancel sign-in");
    expect(html).not.toContain(">Reconnect Codex</button>");
  });

  it("never links a non-https address", () => {
    expect(render({ id: "1", state: "awaiting-browser", url: "javascript:alert(1)" })).not.toContain("javascript:");
  });

  it("says to retry once signed in, and keeps the message after a cancel or failure", () => {
    expect(render({ id: "1", state: "signed-in" })).toContain("Retry your message.");
    const cancelled = render({ id: "1", state: "cancelled", error: "The sign-in was cancelled. Your message is still in the conversation." });
    expect(cancelled).toContain("Your message is still in the conversation.");
    expect(cancelled).toContain(">Reconnect Codex</button>");
  });
});
