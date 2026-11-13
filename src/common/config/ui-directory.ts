import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { expandTilde } from "./expand-tilde";

export function resolveUiDirectory(dir: string): string {
  if (!isAbsolute(dir) && !dir.startsWith("~/")) {
    throw new Error("mc.ui.dir must be an absolute path or start with ~/");
  }
  try {
    const root = realpathSync(expandTilde(dir));
    if (statSync(root).isDirectory() && statSync(join(root, "index.html")).isFile()) return root;
  } catch (cause) {
    throw new Error("mc.ui.dir must name an existing directory containing index.html", { cause });
  }
  throw new Error("mc.ui.dir must name an existing directory containing index.html");
}

export const UiSchema = z.object({
  dir: z.string().superRefine((dir, ctx) => {
    try {
      resolveUiDirectory(dir);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    }
  }),
});

export type UiConfig = z.infer<typeof UiSchema>;
