import { awaitAsyncExpect } from "./await-async-expect.ts";
import { noComments } from "./no-comments.ts";
import { noIgnoredError } from "./no-ignored-error.ts";

export const cortex = { rules: { "no-comments": noComments, "await-async-expect": awaitAsyncExpect, "no-ignored-error": noIgnoredError } };
