import { writeFile } from "node:fs/promises";
import { openConversationHost } from "../../host";
import { answering } from "./scratch";
import { handleConversations } from "../../../surface/mc/api/conversations";
import { buildAllowedHostnames } from "../../../surface/mc/api/mutation-guard";

const dir = process.env.CONVERSATION_DIR ?? "";
const label = process.env.CONVERSATION_LABEL ?? "";
const lane = { provider: "fixture", model: "fixture-model" };
const status = await openConversationHost({
  dir, stack: "fixture", label, expectedLabel: label, lanes: { local: lane, cloud: lane },
  turns: answering(async request => {
    const last = request.prompt;
    if (last.includes("HANG") && process.env.CONVERSATION_HANG === "1") {
      await writeFile(`${dir}/model-entered`, "model request in flight");
      await new Promise(() => undefined);
    }
    return `fixture answer: ${last}`;
  }),
});
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: (req, bound) => handleConversations(req, new URL(req.url), { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: bound.port ?? 0, principals: new Set() }, () => status),
});
process.on("SIGTERM", () => {
  void (async () => {
    await server.stop(true);
    if (status.state === "ready") await status.host.close();
    process.exit(0);
  })();
});
process.stdout.write(`${JSON.stringify({ port: server.port, state: status.state, ...(status.state === "ready" ? { resumed: status.resumed, tookOver: status.tookOver?.pid ?? null } : { reason: status.reason }) })}\n`);
