import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadDemo } from "../src/demo.js";
import { verifyDemoAsset } from "../scripts/demo-assets.mjs";

function pak(paths) {
  const bytes = new Uint8Array(12 + paths.length * 64), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("PACK"));
  view.setUint32(4, 12, true); view.setUint32(8, paths.length * 64, true);
  paths.forEach((path, i) => {
    bytes.set(new TextEncoder().encode(path), 12 + i * 64);
    view.setUint32(12 + i * 64 + 56, 12, true);
  });
  return bytes;
}
const archives = [pak(["progs.dat", "gfx/palette.lmp", "maps/start.bsp"]), pak(["gfx/pop.lmp"]), pak(["maps/qev_encounter.bsp"])];
const manifest = { map: "qev_encounter", files: archives.map((bytes, i) => ({ name: `pak${i}.pak`, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") })) };
function fixture(transform = (bytes) => new Response(bytes)) {
  const requests = [];
  return { requests, fetcher: async (url, options) => {
    requests.push({ url, options });
    const index = manifest.files.findIndex((f) => url === `/demo/${f.name}`);
    assert.notEqual(index, -1, "only demo archives may be requested");
    return transform(archives[index], index);
  } };
}

test("automatic loading verifies and prepares all matching demo packs without a file picker", async () => {
  const { fetcher, requests } = fixture(), progress = [];
  const data = await loadDemo({ manifest, fetcher, onProgress: (p) => progress.push(p) });
  assert.deepEqual(requests.map((r) => r.url), ["/demo/pak0.pak", "/demo/pak1.pak", "/demo/pak2.pak"]);
  assert.ok(requests.every((r) => r.options.cache === "no-store"));
  assert.deepEqual(data.files.map((f) => f.name), ["pak0.pak", "pak1.pak", "pak2.pak"]);
  assert.deepEqual(data.maps, ["qev_encounter", "start"]);
  assert.equal(progress.at(-1).loaded, progress.at(-1).total);
  assert.ok(progress.every((p, i) => !i || p.loaded >= progress[i - 1].loaded));
  for (let i = 0; i < archives.length; i++) assert.deepEqual(data.files[i].bytes, archives[i]);
});

for (const status of [403, 404, 503]) {
  test(`missing/unavailable demo (${status}) explains setup and does not continue loading`, async () => {
    const { fetcher, requests } = fixture(() => new Response("Unavailable", { status }));
    await assert.rejects(loadDemo({ manifest, fetcher }), /npm run setup:demo/);
    assert.equal(requests.length, 1);
  });
}

test("network failures give a recovery path rather than leaving a blank canvas", async () => {
  await assert.rejects(loadDemo({ manifest, fetcher: async () => { throw new TypeError("Failed to fetch"); } }), /npm run setup:demo.*reload this page/);
});

for (const [label, transform, expected] of [
  ["truncated", (bytes) => bytes.subarray(0, bytes.length - 1), /incomplete demo download/],
  ["oversized", (bytes) => new Uint8Array(bytes.length + 1), /unexpected demo archive size/],
  ["corrupt", (bytes) => { const bad = bytes.slice(); bad[0] ^= 1; return bad; }, /integrity check failed/],
]) {
  test(`rejects ${label} demo data before it can reach Quake`, async () => {
    const { fetcher, requests } = fixture((bytes) => new Response(transform(bytes)));
    await assert.rejects(loadDemo({ manifest, fetcher }), expected);
    assert.equal(requests.length, 1);
  });
}

test("a manifest cannot silently start a different map", async () => {
  await assert.rejects(loadDemo({ manifest: { ...manifest, map: "missing" }, ...fixture() }), /demo level is missing/);
});

test("aborting automatic loading never returns partially prepared game data", async () => {
  const controller = new AbortController();
  const { fetcher, requests } = fixture((bytes) => { controller.abort(); return new Response(bytes); });
  await assert.rejects(loadDemo({ manifest, fetcher, signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests.length, 1);
  const unused = fixture();
  await assert.rejects(loadDemo({ manifest, ...unused, signal: controller.signal }), { name: "AbortError" });
  assert.equal(unused.requests.length, 0);
});

test("server verification checks both exact byte length and hash, not just a PAK filename", () => {
  const bytes = archives[0], spec = manifest.files[0];
  assert.equal(verifyDemoAsset(bytes, spec), bytes);
  assert.throws(() => verifyDemoAsset(bytes.subarray(0, 10), spec), /does not match/);
  const modified = bytes.slice(); modified[10] ^= 1;
  assert.throws(() => verifyDemoAsset(modified, spec), /does not match/);
});
