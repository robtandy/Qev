import { DEMO_SETUP_HELP } from "./demo-manifest.js";

const decoder = new TextDecoder("ascii");
export const MAX_PAK_BYTES = 256 * 1024 * 1024;

/** Validate the directory before handing a local, trusted game archive to the legacy engine. */
export function inspectPak(buffer, name) {
  if (!/^pak(?:0|[1-9]\d*)\.pak$/i.test(name)) throw new Error("Use files named pak0.pak, pak1.pak, etc.");
  if (buffer.byteLength < 12 || buffer.byteLength > MAX_PAK_BYTES) throw new Error(`${name}: unsupported archive size (maximum 256 MiB).`);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (decoder.decode(bytes.subarray(0, 4)) !== "PACK") throw new Error(`${name}: not a Quake PAK file.`);
  const offset = view.getUint32(4, true), length = view.getUint32(8, true);
  if (offset < 12 || length % 64 || offset + length > buffer.byteLength || length / 64 > 2048) throw new Error(`${name}: invalid archive directory.`);
  const entries = [];
  for (let pos = offset; pos < offset + length; pos += 64) {
    const raw = bytes.subarray(pos, pos + 56);
    const zero = raw.indexOf(0);
    const path = decoder.decode(zero < 0 ? raw : raw.subarray(0, zero));
    const start = view.getUint32(pos + 56, true), size = view.getUint32(pos + 60, true);
    if (zero < 0 || !path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || start + size > buffer.byteLength) throw new Error(`${name}: invalid file entry.`);
    entries.push(path);
  }
  return entries;
}

export async function preparePaks(files) {
  if (!files.length) throw new Error(`No demo archives were loaded. ${DEMO_SETUP_HELP}`);
  if (files.reduce((n, file) => n + file.size, 0) > MAX_PAK_BYTES * 2) throw new Error("Demo data exceeds 512 MiB.");
  const prepared = [], paths = new Set(), names = new Set();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const name = file.name.toLowerCase();
    if (names.has(name)) throw new Error(`Duplicate archive: ${name}`);
    names.add(name);
    const buffer = await file.arrayBuffer();
    const entries = inspectPak(buffer, name);
    for (const path of entries) paths.add(path);
    prepared.push({ name, bytes: new Uint8Array(buffer) });
  }
  if (!names.has("pak0.pak")) throw new Error("pak0.pak is required. pak1.pak alone is not a complete game.");
  for (let i = 0; i < prepared.length; i++) {
    if (prepared[i].name !== `pak${i}.pak`) throw new Error(`PAKs must be consecutively numbered; missing pak${i}.pak.`);
  }
  if (!paths.has("progs.dat") || !paths.has("gfx/palette.lmp")) throw new Error("Game data must include progs.dat and gfx/palette.lmp.");
  const maps = [...paths].filter((p) => /^maps\/[\w-]+\.bsp$/.test(p)).map((p) => p.slice(5, -4)).sort();
  if (!maps.length) throw new Error("No supported maps were found in these archives.");
  if (!paths.has("gfx/pop.lmp")) {
    throw Object.assign(new Error(`The LibreQuake demo is incomplete: gfx/pop.lmp is missing. ${DEMO_SETUP_HELP}`), { code: "INCOMPLETE_PAK_SET" });
  }
  return { files: prepared, maps };
}
