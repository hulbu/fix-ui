import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fixture host: static files from `e2e/fixtures`, loopback only.
 *
 * 127.0.0.1 on purpose — the extension's manifest holds host permissions for
 * loopback http (`http://127.0.0.1/*`, any port), which is what lets the
 * extension spec inject into these pages and what the origin→project map is
 * keyed on.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const port = Number(process.argv[2] ?? process.env.FIXUI_E2E_PORT ?? 4399);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  // `path.join` on a normalized relative path: nothing may escape `fixtures/`.
  const file = path.join(root, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  readFile(file).then(
    (body) => {
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        // Fixtures are rebuilt between runs; a cached bundle would test the last run.
        "cache-control": "no-store",
      });
      res.end(body);
    },
    () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`no fixture at ${pathname}`);
    },
  );
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fix-ui e2e fixtures on http://127.0.0.1:${port}`);
});
