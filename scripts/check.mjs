import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checked = 0;
for (const dir of ["src", "scripts", "tests"]) {
  for (const name of readdirSync(resolve(root, dir), { recursive: true })) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ["--check", resolve(root, dir, name)], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status) process.exit(result.status);
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
