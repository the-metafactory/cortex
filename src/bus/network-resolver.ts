/**
 * G-500: Network Resolution
 *
 * Provides O(1) lookups for:
 * - Discord guild ID → network ID
 * - Mattermost channel ID → network ID
 * - Network ID → NetworkConfig (for CloudPublisher)
 *
 * Lookup tables are built once at startup via initNetworkLookups(),
 * and rebuilt on config reload. Never rebuilt per-message.
 */

import type { BotConfig, NetworkConfig, NetworkResolver, NetworkFile } from "../common/types/config";

// =============================================================================
// Lookup Tables
// =============================================================================

export interface NetworkLookupTables {
  guildToNetwork: Map<string, string>;
  channelToNetwork: Map<string, string>;
  networksById: Map<string, NetworkFile>;
}

export function buildNetworkLookups(config: BotConfig): NetworkLookupTables {
  const guildToNetwork = new Map<string, string>();
  const channelToNetwork = new Map<string, string>();
  const networksById = new Map<string, NetworkFile>();

  for (const network of config.networks) {
    networksById.set(network.id, network);

    for (const discord of network.discord) {
      guildToNetwork.set(discord.guildId, network.id);
    }

    for (const mm of network.mattermost) {
      for (const channelId of mm.channels) {
        channelToNetwork.set(channelId, network.id);
      }
    }
  }

  return { guildToNetwork, channelToNetwork, networksById };
}

// =============================================================================
// Cached module-level lookups — built once, used per-message
// =============================================================================

let cachedLookups: NetworkLookupTables = {
  guildToNetwork: new Map(),
  channelToNetwork: new Map(),
  networksById: new Map(),
};
let cachedConfig: BotConfig | null = null;

/**
 * Initialize (or rebuild) the cached lookup tables.
 * Call at startup and on config reload.
 */
export function initNetworkLookups(config: BotConfig): void {
  cachedLookups = buildNetworkLookups(config);
  cachedConfig = config;
}

/**
 * Get the cached lookups, rebuilding if config reference changed.
 * This ensures correctness even if initNetworkLookups wasn't called,
 * while avoiding per-message Map rebuilds in the hot path.
 */
function getLookups(config: BotConfig): NetworkLookupTables {
  if (config !== cachedConfig) {
    initNetworkLookups(config);
  }
  return cachedLookups;
}

// =============================================================================
// Resolution Functions
// =============================================================================

export function getNetworkForGuild(guildId: string, config: BotConfig): string | undefined {
  return getLookups(config).guildToNetwork.get(guildId);
}

export function getNetworkForChannel(channelId: string, config: BotConfig): string | undefined {
  return getLookups(config).channelToNetwork.get(channelId);
}

export function createNetworkResolver(config: BotConfig): NetworkResolver {
  const tables = getLookups(config);

  return (networkId: string | undefined): NetworkConfig | null => {
    if (networkId) {
      const network = tables.networksById.get(networkId);
      if (!network?.cloud) return null;
      const { endpoint, apiKey, operatorId, cfAccessClientId, cfAccessClientSecret } = network.cloud;
      return { id: network.id, endpoint, apiKey, operatorId, cfAccessClientId, cfAccessClientSecret };
    }

    // No network ID — return first network with cloud config
    for (const network of config.networks) {
      if (network.cloud) {
        const { endpoint, apiKey, operatorId, cfAccessClientId, cfAccessClientSecret } = network.cloud;
        return { id: network.id, endpoint, apiKey, operatorId, cfAccessClientId, cfAccessClientSecret };
      }
    }

    return null;
  };
}
