/**
 * T-3.1: Policy Loader
 * Load and validate relay policy from YAML file.
 */

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { RelayPolicySchema, type RelayPolicy } from "./policy-schema";

export function loadPolicy(path: string): RelayPolicy {
  const content = readFileSync(path, "utf-8");
  const raw: unknown = parseYaml(content);
  return RelayPolicySchema.parse(raw);
}
