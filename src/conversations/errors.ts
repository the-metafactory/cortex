export class ConversationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string, readonly code?: "discord-history") { super(message); }
}
