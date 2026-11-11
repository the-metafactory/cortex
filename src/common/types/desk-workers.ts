import { z } from "zod";

const WORKER_REPOSITORY_PATTERN = String.raw`(?:(?:github|gitlab):[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)+`;
export const WORKER_REPOSITORY_REF = new RegExp(`^${WORKER_REPOSITORY_PATTERN}$`);
export const WORKER_NODE_REF = new RegExp(`^${WORKER_REPOSITORY_PATTERN}#[1-9]\\d*$`);
const ARGV = z.array(z.string().min(1)).min(1);
const nodePlaceholder = (arg: string): boolean => arg.includes("{ref}") || arg.includes("{id}");

const startCommand = ARGV.refine(argv => argv.some(arg => arg.includes("{id}")) && argv.some(arg => arg.includes("{map}")), "must pass the node with {id} and the map with {map}");
const statusCommand = ARGV.refine(argv => argv.some(nodePlaceholder), "must pass the node with {ref} or {id}");
const stopCommand = ARGV.refine(argv => argv.some(nodePlaceholder) && argv.some(arg => arg.includes("{map}")) && argv.some(arg => arg.includes("{generation}")), "must pass the node, the map with {map} and the generation with {generation}");

export const WorkerHandoffOptionsSchema = z.object({
  maps: z.array(z.string().trim().max(320).regex(WORKER_NODE_REF)).min(1).max(50).refine(maps => new Set(maps).size === maps.length, "mc.desk.workers.maps names a map twice"),
  start: startCommand,
  stop: stopCommand,
  status: statusCommand.optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(120),
}).strict();
export type WorkerHandoffOptions = z.infer<typeof WorkerHandoffOptionsSchema>;
