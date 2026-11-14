export class ConversationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string, readonly code?: "discord-history") { super(message); }
}

export const noLaneMessage = (policy: "local" | "cloud"): string => policy === "local" ? "No local model is configured. Nothing was sent; no cloud fallback is used." : "No conversation model is configured. Nothing was sent.";
