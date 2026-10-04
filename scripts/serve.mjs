import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_ASSETS, DEMO_SETUP_HELP } from "../src/demo-manifest.js";
import { DEMO_DIRECTORY, readDemoAssets } from "./demo-assets.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8" };
const mounts = [["/engine/", "build/engine"], ["/vendor/kevala/", "node_modules/kevala/js/src"], ["/src/", "src"], ["/", "public"]];
const engineFiles = new Set(["qwasm.mjs", "qwasm.wasm", "build.json", "QWASM-LICENSE.txt"]);

export function makeServer(projectRoot = root) {
  const demoNames = new Set(DEMO_ASSETS.map((spec) => spec.name));
  let demoReady = null;
  const getDemo = () => demoReady ||= readDemoAssets(resolve(projectRoot, DEMO_DIRECTORY)).catch((error) => {
    demoReady = null; // A subsequent request can retry after npm run setup:demo.
    throw error;
  });
  return createServer(async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").some((p) => p.startsWith("."))) { res.writeHead(403).end("Forbidden"); return; }
      if (pathname.startsWith("/demo/")) {
        const name = pathname.slice("/demo/".length);
        if (!demoNames.has(name)) { res.writeHead(404).end("Not found"); return; }
        let data;
        try { data = (await getDemo()).get(name); }
        catch {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(`The verified LibreQuake demo is not installed or is invalid. ${DEMO_SETUP_HELP}`);
          return;
        }
        res.writeHead(200, { "Content-Type": types[extname(name)] || "application/octet-stream", "Content-Length": data.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
        res.end(req.method === "HEAD" ? undefined : data);
        return;
      }
      // The only PAK-serving exception is the complete, hash-verified LibreQuake bundle above.
      if (/\.pak$/i.test(pathname)) { res.writeHead(403).end("Forbidden"); return; }
      const [prefix, directory] = mounts.find(([prefix]) => pathname.startsWith(prefix));
      const name = pathname.slice(prefix.length) || "index.html";
      if (prefix === "/engine/" && !engineFiles.has(name)) { res.writeHead(404).end("Not found"); return; }
      const base = await realpath(resolve(projectRoot, directory));
      const file = await realpath(resolve(base, name));
      if (!file.startsWith(base + sep)) { res.writeHead(403).end("Forbidden"); return; }
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404).end("Not found");
      else res.destroy();
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || process.env.PORT || 8090);
  makeServer().listen(port, "127.0.0.1", () => console.log(`Qev: http://127.0.0.1:${port} (local only; only the verified LibreQuake demo PAKs may be served)`));
}
