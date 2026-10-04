import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeServer } from "../scripts/serve.mjs";
import { DEMO_DIRECTORY } from "../scripts/demo-assets.mjs";

test("development server serves only explicit mounts, never user game assets or project secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qev-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["public", "src", "build/engine", "local-assets", "node_modules/kevala/js/src", DEMO_DIRECTORY]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "public/index.html"), "Qev");
  await writeFile(join(root, "public/PAK0.PAK"), "private-game-data");
  await writeFile(join(root, "build/engine/qwasm.wasm"), "wasm");
  await writeFile(join(root, "local-assets/pak0.pak"), "private-game-data");
  await writeFile(join(root, ".env"), "private-config");
  await writeFile(join(root, "build/engine/pak0.pak"), "accidentally-copied-game-data");
  await symlink(join(root, "local-assets/pak0.pak"), join(root, "public/leaked.pak"));
  await writeFile(join(root, DEMO_DIRECTORY, "pak0.pak"), "private-game-data-is-not-a-demo-even-with-the-same-filename");
  const server = makeServer(root);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(url)).text(), "Qev");
  const wasm = await fetch(`${url}/engine/qwasm.wasm`);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  for (const path of ["/.env", "/PAK0.PAK", "/local-assets/pak0.pak", "/build/engine/qwasm.wasm", "/engine/pak0.pak", "/leaked.pak", "/src/%2e%2e%2flocal-assets/pak0.pak", "/src/%00bad", "/demo/pak3.pak", "/demo/PAK0.PAK", "/demo/%2e%2e%2flocal-assets/pak0.pak", `/${DEMO_DIRECTORY}/pak0.pak`]) {
    const response = await fetch(url + path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.doesNotMatch(await response.text(), /private|accidentally/);
  }
  for (const name of ["pak0.pak", "pak1.pak", "pak2.pak", "NOTICE.txt"]) {
    const response = await fetch(`${url}/demo/${name}`);
    assert.equal(response.status, 503, "unverified or incomplete bundles must fail closed");
    const message = await response.text();
    assert.match(message, /npm run setup:demo/);
    assert.doesNotMatch(message, /private-game-data/);
  }
  await rm(join(root, DEMO_DIRECTORY, "pak0.pak"));
  await symlink(join(root, "local-assets/pak0.pak"), join(root, DEMO_DIRECTORY, "pak0.pak"));
  assert.equal((await fetch(`${url}/demo/pak0.pak`)).status, 503, "outside symlinks cannot turn the demo endpoint into an asset leak");
  assert.equal((await fetch(url, { method: "POST", body: "upload" })).status, 405);
});
