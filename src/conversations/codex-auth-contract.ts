export const CODEX_PROVIDER = "openai-codex";
export const CODEX_SIGN_IN_NEEDED = "Codex needs a new sign-in.";

export interface LoginView {
  id: string;
  state: "starting" | "awaiting-browser" | "awaiting-input" | "signed-in" | "cancelled" | "failed";
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  message?: string;
  prompt?: { message: string; options?: { id: string; label: string }[] };
  error?: string;
}
