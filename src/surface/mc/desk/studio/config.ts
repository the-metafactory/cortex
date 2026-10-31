import type { EndpointConfig } from "../classify";
import type { StudioOptions } from "../types";

function endpointPaths(filer: EndpointConfig, expand: (path: string) => string): EndpointConfig {
  return {
    ...filer,
    ...(filer.apiKeyFile ? { apiKeyFile: expand(filer.apiKeyFile) } : {}),
    ...(filer.caFile ? { caFile: expand(filer.caFile) } : {}),
  };
}

export function resolveStudio(options: StudioOptions, expand: (path: string) => string): StudioOptions {
  const filer = options.filer;
  return {
    ...options,
    dir: expand(options.dir),
    ...(filer ? { filer: { ...endpointPaths(filer, expand), ...(filer.local ? { local: endpointPaths(filer.local, expand) } : {}) } } : {}),
  };
}
