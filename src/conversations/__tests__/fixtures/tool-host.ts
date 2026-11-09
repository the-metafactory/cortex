import type { ToolsConfig } from "../../../common/types/desk-conversations";
import type { ModelRoute } from "../../types";
import { ToolHost, type ToolDefinition, type ToolSession } from "../../tools/capabilities";

export interface ToolRig {
  call: (name: string, input: unknown) => Promise<{ outcome: string; text: string }>;
}

export function toolRig(options: { route: ModelRoute; config: () => ToolsConfig; session: () => Promise<ToolSession | null>; tools: ToolDefinition[] }): ToolRig {
  const host = new ToolHost({ config: options.config, session: options.session, tools: options.tools });
  const surface = host.surface("c", options.route, () => Promise.resolve());
  return { call: (name, input) => surface.call("id", name, input, new AbortController().signal) };
}

export const toolBody = (text: string): Record<string, unknown> => {
  const start = text.indexOf("\n") + 1;
  return JSON.parse(text.slice(start, text.indexOf("\n</tool-result>"))) as Record<string, unknown>;
};
