import assert from "node:assert/strict";
import test from "node:test";
import { inspectPak, preparePaks } from "../src/pak.js";

function pak(paths = ["progs.dat", "gfx/palette.lmp", "maps/e1m1.bsp", "gfx/pop.lmp"]) {
  const bytes = new Uint8Array(12 + paths.length * 64);
  bytes.set(new TextEncoder().encode("PACK"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 12, true); view.setUint32(8, paths.length * 64, true);
  paths.forEach((path, i) => {
    bytes.set(new TextEncoder().encode(path), 12 + i * 64);
    view.setUint32(12 + i * 64 + 56, 12, true);
  });
  return bytes.buffer;
}
const file = (name, buffer = pak()) => ({ name, size: buffer.byteLength, arrayBuffer: async () => buffer });

test("validates PAK directories without mutating the downloaded archive list", async () => {
  const files = [file("PAK1.PAK", pak(["maps/e1m2.bsp"])), file("PAK0.PAK")];
  const data = await preparePaks(files);
  assert.deepEqual(data.files.map((f) => f.name), ["pak0.pak", "pak1.pak"]);
  assert.deepEqual(data.maps, ["e1m1", "e1m2"]);
  assert.deepEqual(files.map((f) => f.name), ["PAK1.PAK", "PAK0.PAK"]);
});

test("rejects invalid names, headers, directories, and file bounds", () => {
  assert.throws(() => inspectPak(pak(), "../pak0.pak"), /named/);
  assert.throws(() => inspectPak(new ArrayBuffer(1), "pak0.pak"), /size/);
  const header = pak(); new Uint8Array(header)[0] = 0;
  assert.throws(() => inspectPak(header, "pak0.pak"), /not a Quake/);
  const directory = pak(); new DataView(directory).setUint32(8, 9, true);
  assert.throws(() => inspectPak(directory, "pak0.pak"), /directory/);
  const entry = pak(); new DataView(entry).setUint32(12 + 60, 100000, true);
  assert.throws(() => inspectPak(entry, "pak0.pak"), /entry/);
});
for (const path of ["../outside", "/outside", "gfx/../../outside", "gfx\\outside"]) {
  test(`rejects unsafe PAK entry ${path}`, () => assert.throws(() => inspectPak(pak([path]), "pak0.pak"), /entry/));
}
test("matches the legacy engine's directory limits and requires terminated names", () => {
  assert.throws(() => inspectPak(pak(Array(2049).fill("a")), "pak0.pak"), /directory/);
  assert.throws(() => inspectPak(pak(["a".repeat(56)]), "pak0.pak"), /entry/);
  assert.throws(() => inspectPak(pak(), "pak01.pak"), /named/);
});

test("rejects numbering gaps that would make Quake silently ignore later archives", async () => {
  await assert.rejects(preparePaks([file("pak0.pak"), file("pak2.pak")]), /missing pak1/);
});

test("catches the missing LibreQuake pak1 before starting the legacy engine", async () => {
  const base = file("pak0.pak", pak(["progs.dat", "gfx/palette.lmp", "maps/e1m1.bsp"]));
  await assert.rejects(preparePaks([base]), (error) => error.code === "INCOMPLETE_PAK_SET" && /gfx\/pop\.lmp/.test(error.message) && /npm run setup:demo/.test(error.message));
  const data = await preparePaks([base, file("pak1.pak", pak(["gfx/pop.lmp"]))]);
  assert.deepEqual(data.files.map((f) => f.name), ["pak0.pak", "pak1.pak"]);
  assert.deepEqual(data.maps, ["e1m1"]);
});

test("requires a complete base game, unique archive names, and at least one map", async () => {
  await assert.rejects(preparePaks([]), /No demo archives/);
  await assert.rejects(preparePaks([file("pak1.pak")]), /pak0/);
  await assert.rejects(preparePaks([file("PAK0.PAK"), file("pak0.pak")]), /Duplicate/);
  await assert.rejects(preparePaks([file("pak0.pak", pak(["maps/e1m1.bsp"]))]), /progs/);
  await assert.rejects(preparePaks([file("pak0.pak", pak(["progs.dat", "gfx/palette.lmp"]))]), /No supported maps/);
});
