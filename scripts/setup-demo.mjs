// Explicit one-time install of freely licensed assets. The web server never fetches upstream data.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_ARCHIVE, DEMO_DIRECTORY, makeDemoNotice, readDemoAssets, verifyDemoAsset } from "./demo-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, DEMO_DIRECTORY);
try {
  await readDemoAssets(output);
  console.log(`Verified demo is already installed: ${output}`);
  process.exit(0);
} catch { /* Build missing or invalid generated files again from the pinned upstream ZIP. */ }
await mkdir(resolve(root, "build"), { recursive: true });
const zip = resolve(root, "build", DEMO_ARCHIVE.name);
let cached;
try { cached = await readFile(zip); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (cached) verifyDemoAsset(cached, DEMO_ARCHIVE);
else {
  console.log(`Downloading LibreQuake Lite (${Math.round(DEMO_ARCHIVE.size / 1024 / 1024)} MiB) from the official release…`);
  const response = await fetch(DEMO_ARCHIVE.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`LibreQuake download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(DEMO_ARCHIVE.size);
  let offset = 0;
  for await (const chunk of response.body) {
    if (offset + chunk.byteLength > bytes.byteLength) throw new Error("Upstream archive exceeds the pinned size.");
    bytes.set(chunk, offset); offset += chunk.byteLength;
  }
  verifyDemoAsset(bytes.subarray(0, offset), DEMO_ARCHIVE);
  await writeFile(zip, bytes);
}
const temporary = await mkdtemp(resolve(root, "build/demo-setup-"));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
try {
  // The ZIP is hash-checked before extraction; only the two PAKs and upstream notices are used.
  run("unzip", ["-q", zip, "lite/id1/pak0.pak", "lite/id1/pak1.pak", "lite/id1/docs/*", "-d", temporary]);
  const id1 = resolve(temporary, "lite/id1");
  run(process.execPath, [resolve(root, "scripts/make-test-encounter.mjs"), resolve(id1, "pak0.pak"), resolve(id1, "pak2.pak")]);
  await writeFile(resolve(id1, "NOTICE.txt"), await makeDemoNotice(id1));
  await readDemoAssets(id1);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { recursive: true, force: true }); // Only the generated, versioned demo directory.
  await rename(id1, output);
  console.log(`Installed the verified LibreQuake demo and notices: ${output}`);
  console.log("Qev will load its three matching PAKs automatically. No original Quake assets are hosted.");
} finally { await rm(temporary, { recursive: true, force: true }); }
