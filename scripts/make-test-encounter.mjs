// Generate Qev's demo/QA encounter using LibreQuake v0.09-beta Lite geometry.
// Requires the exact freely licensed archive and notices; no proprietary Quake resources.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspectPak } from "../src/pak.js";

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/make-test-encounter.mjs /path/to/LibreQuake/lite/id1/pak0.pak [output/pak2.pak]");
const pak = readFileSync(source);
if (createHash("sha256").update(pak).digest("hex") !== "0dd895a425e75d9908025dcfe340f75f5b8166ada68b2d7ee54d8d91d29378ff") throw new Error("This fixture only supports the pinned LibreQuake v0.09-beta Lite pak0.pak. Original Quake data is never modified.");
inspectPak(pak.buffer.slice(pak.byteOffset, pak.byteOffset + pak.byteLength), "pak0.pak");
let map;
for (let i = pak.readUInt32LE(4), end = i + pak.readUInt32LE(8); i < end; i += 64) {
  const name = pak.subarray(i, i + 56).toString().split("\0")[0];
  if (name === "maps/lq_e0m1.bsp") map = pak.subarray(pak.readUInt32LE(i + 56), pak.readUInt32LE(i + 56) + pak.readUInt32LE(i + 60));
}
if (!map || map.readUInt32LE(0) !== 29) throw new Error("Expected the original-format LibreQuake lq_e0m1 BSP.");
const text = map.subarray(map.readUInt32LE(4), map.readUInt32LE(4) + map.readUInt32LE(8)).toString();
const entities = [...text.matchAll(/\{[^}]*\}/g)].map((m) => m[0]).filter((entity) => {
  const classname = entity.match(/"classname"\s+"([^"]+)"/)?.[1] || "";
  return !/^(monster_|item_|weapon_|info_player_)/.test(classname);
});
entities.push('{\n"classname" "info_player_start"\n"origin" "392 -208 -248"\n"angle" "180"\n}');
entities.push('{\n"classname" "monster_army"\n"origin" "296 -208 -248"\n"angle" "0"\n}');
entities.push('{\n"classname" "item_health"\n"origin" "392 -264 -264"\n}');
const entityBytes = Buffer.from(entities.join("\n") + "\n\0");
const bsp = Buffer.concat([map, entityBytes]);
bsp.writeUInt32LE(map.length, 4); bsp.writeUInt32LE(entityBytes.length, 8);
const header = Buffer.alloc(12), directory = Buffer.alloc(64);
header.write("PACK"); header.writeUInt32LE(12 + bsp.length, 4); header.writeUInt32LE(64, 8);
directory.write("maps/qev_encounter.bsp"); directory.writeUInt32LE(12, 56); directory.writeUInt32LE(bsp.length, 60);
const output = resolve(process.argv[3] || "build/test-assets/encounter/pak2.pak");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, bsp, directory]));
writeFileSync(resolve(dirname(output), "README.txt"), "Local Qev QA overlay, derived from LibreQuake v0.09-beta Lite lq_e0m1.\nUse only with the original LibreQuake pak0.pak and pak1.pak.\nRetain the original archive's docs/COPYING, CREDITS and all other licensing notices.\nSources: https://github.com/lavenderdotpet/LibreQuake/tree/v0.09-beta\nThis overlay changes entity placement only: one player, one grunt, one health pickup.\nOriginal geometry, doors/triggers, and game rules remain; this is not a newly authored arena.\nOnly the hash-verified LibreQuake demo bundle may be served by Qev locally; PAKs are not committed to Git.\n");
console.log(`Created ${output}. Use with the matching LibreQuake pak0.pak and pak1.pak on map qev_encounter.`);
