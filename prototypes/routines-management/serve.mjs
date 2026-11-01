const root = import.meta.dir;
const port = Number(process.env.PORT ?? 4717);
const assets = new Set(["index.html", "routines-prototype.html", "routines-combined-prototype.html", "routines-prototype.js", "routines-prototype.css"]);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname.slice(1) || "index.html";
    if (!assets.has(path)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(`${root}/${path}`));
  },
});
console.log(`Approved Routines prototype: http://127.0.0.1:${port}/`);
