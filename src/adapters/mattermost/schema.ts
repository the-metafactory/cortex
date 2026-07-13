/**
 * cortex#1796 (S11, ADR-0024 D5 extraction lane) — the Mattermost surface
 * plugin's own schema data, mirroring `metafactory-cortex-adapter-web`'s
 * `src/schema.ts` (cortex#1794 S9).
 *
 * ## MattermostBindingSchema
 *
 * Originally lived in cortex's `src/common/types/surfaces.ts`. Relocated here
 * (plugin-owned data — S4's own principle: `adapters/registry.ts`'s
 * `AdapterPlugin.bindingSchema` docstring) as the INVERSION step (mirrors
 * web's S9b); `surfaces.ts` imports it back and re-exports it so every
 * existing in-tree consumer keeps working unchanged while mattermost is
 * still in-tree. The FINAL MOVE slice (cortex#1796 S11 MOVE) drops that
 * re-export — the schema then lives ONLY here (in-tree) / in the
 * `metafactory-cortex-adapter-mattermost` bundle (out-of-tree) — exactly
 * like `WebBindingSchema`'s cortex#1794 S9 MOVE.
 *
 * ## MattermostPresenceSchema
 *
 * UNLIKE `WebBindingSchema` (which had no cortex-core consumer beyond the
 * web adapter itself — web never folds into `agents[*].presence.web`),
 * Mattermost's canonical `MattermostPresenceSchema` in
 * `common/types/cortex-config.ts` is genuine cortex-core config-schema
 * machinery: `PresenceSchema.mattermost`, `AgentConfig`, hot-reload
 * (`cortex.ts`'s `updateConfig` dispatch), `surface-adapter-boot.ts`'s
 * `buildPresence()`, and `migrate-config-lib.ts` all depend on it
 * independent of where the ADAPTER BEHAVIOR lives. That schema stays in
 * `cortex-config.ts` permanently — it is NOT relocated.
 *
 * The copy below is a deliberate, bundle-owned DUPLICATE of that schema's
 * shape, used only for this plugin's own construction-time parsing
 * (`plugin.ts`'s `buildGatewayConstructArgs` calls `.parse()` to fill
 * defaults on a raw gateway-path binding) and for typing the adapter files
 * in this directory. Same duplication tradeoff as this directory's
 * `envelope-renderer.ts` / `context.ts`'s `formatContextForClaude` — kept
 * in sync BY HAND with `cortex-config.ts`'s canonical version; a genuine
 * schema drift is a plugin-author migration note, not a silent break (the
 * SDK's `SURFACE_SDK_VERSION` gate covers `PlatformAdapter`/`AdapterPlugin`
 * shape changes, not sibling-schema drift like this).
 */

import { z } from "zod/v4";

/**
 * Mattermost surface binding — the API connection subset of
 * `MattermostPresenceSchema`. `apiUrl` + `apiToken` are the irreducible
 * binding (the bot needs both to reach the server); webhook/trigger knobs
 * ride along via the catchall.
 */
export const MattermostBindingSchema = z
  .object({
    apiUrl: z.string().min(1, "surfaces.mattermost[].binding.apiUrl is required"),
    apiToken: z.string().min(1, "surfaces.mattermost[].binding.apiToken is required"),
  })
  .catchall(z.unknown());

export type MattermostBinding = z.infer<typeof MattermostBindingSchema>;

/**
 * Bundle-owned duplicate of `common/types/cortex-config.ts`'s
 * `MattermostPresenceSchema` — see module doc above for why this is a
 * duplicate, not a relocation.
 */
export const MattermostPresenceSchema = z.object({
  /** Whether this presence is active. Default: true. */
  enabled: z.boolean().default(true),
  callbackPort: z.number().int().default(8080),
  triggerWord: z.string().optional(),
  webhookUrl: z.string().optional(),
  apiUrl: z.string().optional(),
  apiToken: z.string().optional(),
  webhookToken: z.string().optional(),
  /** Channel ids to poll. If empty, uses search API (public channels only). */
  channels: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().positive().default(3000),
  /** Mattermost user ids allowed to trigger the bot. Empty = allow all. */
  allowedUsers: z.array(z.string()).default([]),
});

export type MattermostPresence = z.infer<typeof MattermostPresenceSchema>;
