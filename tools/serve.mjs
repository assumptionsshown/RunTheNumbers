// Static file server for the render layer. Node's http module only, so the repo
// stays dependency-free.
//
//   node tools/serve.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const port = Number(process.argv[2] ?? 5173);
const root = join(import.meta.dirname, "..");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".csv": "text/csv; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/render/ep01.html";

    // Keep requests inside the repo.
    const resolved = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!resolved.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const info = await stat(resolved);
    if (!info.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }

    const body = await readFile(resolved);
    res.writeHead(200, {
      "content-type": TYPES[extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}`);
});
