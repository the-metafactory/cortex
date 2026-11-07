import { modelPaths } from "../classify";
import type { StudioOptions } from "../types";

export function resolveStudio(options: StudioOptions, expand: (path: string) => string): StudioOptions {
  const filer = options.filer;
  return {
    ...options,
    dir: expand(options.dir),
    ...(filer ? { filer: modelPaths(filer, expand) } : {}),
  };
}
