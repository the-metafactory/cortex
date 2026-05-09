/**
 * F-007: Message keyword parser
 *
 * Extracts mode (sync/async/team/help) and context depth from message content.
 * Extracted from grove-bot.ts to be shared across all platform adapters.
 */

export interface ParsedMessage {
  /** Message routing mode */
  mode: "sync" | "async" | "team" | "help" | "learning";
  /** Cleaned content (keywords stripped) */
  content: string;
  /** Context depth override from context:N keyword */
  contextDepth?: number;
  /** Learning command details (for mode: "learning") */
  learningCommand?: {
    action: "add" | "list" | "remove" | "search";
    text?: string; // For add/search actions
    id?: string;   // For remove action
  };
}

const CONTEXT_PATTERN = /\bcontext[:\s]+(\d+)\b/i;
const MAX_CONTEXT_DEPTH = 100;

/**
 * Parse message keywords and extract routing mode + context depth.
 *
 * Keywords:
 * - `async: <text>` → fire-and-forget mode
 * - `team: <text>` → multi-agent team mode
 * - `/help` or `help` → help response (no CC invocation)
 * - `context:N` → override context fetch depth (cap at 100)
 *
 * Context depth can combine with any mode: `context:20 async: do it`
 */
export function parseMessageKeywords(
  content: string,
  defaultDepth: number,
): ParsedMessage {
  let cleaned = content;
  let contextDepth: number | undefined;

  // Extract context:N (can appear anywhere in the message)
  const contextMatch = cleaned.match(CONTEXT_PATTERN);
  if (contextMatch) {
    contextDepth = Math.min(parseInt(contextMatch[1]!, 10), MAX_CONTEXT_DEPTH);
    cleaned = cleaned.replace(contextMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  // Check for /help or bare "help" (after context stripping)
  if (/^\/?(help|commands)\b/i.test(cleaned.trim())) {
    return { mode: "help", content: "", contextDepth };
  }

  // Check for /learning command
  const learningMatch = cleaned.trim().match(/^\/learning\s+(.*)/i);
  if (learningMatch) {
    const args = learningMatch[1]!.trim();

    // /learning list
    if (/^list$/i.test(args)) {
      return {
        mode: "learning",
        content: "",
        contextDepth,
        learningCommand: { action: "list" },
      };
    }

    // /learning remove <id>
    const removeMatch = args.match(/^remove\s+(\S+)/i);
    if (removeMatch) {
      return {
        mode: "learning",
        content: "",
        contextDepth,
        learningCommand: { action: "remove", id: removeMatch[1] },
      };
    }

    // /learning search <query>
    const searchMatch = args.match(/^search\s+(.+)/i);
    if (searchMatch) {
      return {
        mode: "learning",
        content: "",
        contextDepth,
        learningCommand: { action: "search", text: searchMatch[1] },
      };
    }

    // /learning <text> — add a new learning
    if (args.length > 0) {
      return {
        mode: "learning",
        content: "",
        contextDepth,
        learningCommand: { action: "add", text: args },
      };
    }

    // /learning with no args — treat as help for learning command
    return {
      mode: "learning",
      content: "",
      contextDepth,
      learningCommand: { action: "list" }, // Default to list
    };
  }

  // Check for async: prefix
  if (cleaned.toLowerCase().startsWith("async:")) {
    return {
      mode: "async",
      content: cleaned.slice(6).trim(),
      contextDepth,
    };
  }

  // Check for team: prefix
  if (cleaned.toLowerCase().startsWith("team:")) {
    return {
      mode: "team",
      content: cleaned.slice(5).trim(),
      contextDepth,
    };
  }

  // Default: synchronous chat
  return { mode: "sync", content: cleaned, contextDepth };
}
