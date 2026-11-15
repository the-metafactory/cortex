import { awaitAsyncExpect } from "./await-async-expect.ts";
import { noComments } from "./no-comments.ts";

export const cortex = { rules: { "no-comments": noComments, "await-async-expect": awaitAsyncExpect } };
