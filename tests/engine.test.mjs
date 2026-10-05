import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Engine, engineErrorFromLog, DIFFICULTIES, DEFAULT_DIFFICULTY, validateDifficulty } from "../src/engine.js";

test("fatal legacy stdout errors retain their cause and give demo-repair guidance", () => {
  const error = engineErrorFromLog("Error: You must have the registered version to use modified games");
  assert.match(error.message, /registered version/);
  assert.match(error.message, /npm run setup:demo/);
  assert.doesNotMatch(error.message, /select.*pak/i);
  assert.match(engineErrorFromLog("Host_Error: failed to load map").message, /failed to load map/);
  assert.equal(engineErrorFromLog("Playing shareware version."), null);
  assert.equal(engineErrorFromLog("FindFile: can't find gfx/pop.lmp"), null);
  assert.equal(engineErrorFromLog("Warning: a non-fatal warning"), null);
});

function audioFixture(state = "suspended") {
  const calls = [];
  const context = { state, resume() { calls.push("resume"); context.state = "running"; return Promise.resolve(); } };
  const engine = new Engine({ SDL2: { audioContext: context, audio: { scriptProcessorNode: {} } },
    _qev_pause() { calls.push("pause"); }, _qev_auto() { assert.fail("audio must not start gameplay"); } });
  return { engine, context, calls };
}

for (const state of ["suspended", "interrupted"]) {
  test(`audio ${state} by the browser resumes within the gesture, without advancing the world`, async () => {
    const { engine, calls } = audioFixture(state);
    const result = engine.resumeAudio();
    assert.deepEqual(calls, ["resume"], "resume() must be invoked before any await loses user activation");
    assert.equal(await result, true);
    assert.deepEqual(calls, ["resume"]);
  });
}

test("running audio does not create or resume a second context", async () => {
  const { engine, calls } = audioFixture("running");
  assert.equal(await engine.resumeAudio(), true);
  assert.deepEqual(calls, []);
});

test("absent, failed, or closed audio devices give actionable errors instead of silent success", async () => {
  for (const module of [{}, { SDL2: {} }, { SDL2: { audioContext: { state: "running" } } }]) {
    await assert.rejects(new Engine(module).resumeAudio(), /audio is unavailable.*reload/);
  }
  const { engine, calls } = audioFixture("closed");
  await assert.rejects(engine.resumeAudio(), /audio is unavailable/);
  assert.deepEqual(calls, []);
});

test("browser audio rejection or continued suspension is reported, with no gameplay side effects", async () => {
  const { engine, context, calls } = audioFixture();
  context.resume = () => Promise.reject(new Error("Autoplay blocked"));
  await assert.rejects(engine.resumeAudio(), /Autoplay blocked/);
  context.resume = () => Promise.resolve();
  await assert.rejects(engine.resumeAudio(), /kept game audio suspended/);
  assert.deepEqual(calls, []);
});

test("an audio unlock completing after Stop cannot resume simulation or undo native audio pause", async () => {
  const { engine, context, calls } = audioFixture();
  let finish;
  context.resume = () => new Promise(resolve => { finish = () => { context.state = "running"; resolve(); }; });
  const pending = engine.resumeAudio();
  engine.pause(); finish();
  assert.equal(await pending, true);
  assert.deepEqual(calls, ["pause"]);
});

test("Hard is the default in both the engine and the initial difficulty selector", () => {
  assert.equal(DEFAULT_DIFFICULTY, 2);
  assert.equal(DIFFICULTIES[DEFAULT_DIFFICULTY], "Hard");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<option value="2" selected>Hard<\/option>/);
});

test("all four Quake difficulties are supported, with no coercion of invalid input", () => {
  assert.deepEqual(DIFFICULTIES, ["Easy", "Normal", "Hard", "Nightmare"]);
  for (const level of [0,1,2,3]) assert.equal(validateDifficulty(level), level);
  for (const level of [undefined,null,"2",false,-1,4,1.5,NaN,Infinity]) assert.throws(() => validateDifficulty(level), /Invalid difficulty/);
});

function mapFixture() {
  let state = { ready: true, alive: true, paused: true, remaining: 0, epoch: 1, map: "lq_e0m6", difficulty: 2 };
  const calls = [];
  const engine = new Engine({ UTF8ToString: x => x, _qev_snapshot: () => JSON.stringify(state),
    ccall(name, result, types, values) {
      calls.push({ name, result, types, values });
      state = { ...state, epoch: state.epoch + 1, map: values[0], difficulty: values[1] };
      return 1;
    } });
  return { engine, calls };
}

test("map and difficulty are applied together before starting the next world", async () => {
  const { engine, calls } = mapFixture();
  const after = await engine.loadMap("lq_e0m6", 3);
  assert.equal(after.difficulty, 3);
  assert.equal(after.map, "lq_e0m6");
  assert.deepEqual(calls, [{ name: "qev_new_game", result: "number", types: ["string", "number"], values: ["lq_e0m6", 3] }]);
});

test("a restart without new settings preserves the actual active difficulty", async () => {
  const { engine, calls } = mapFixture();
  await engine.loadMap("lq_e0m6");
  assert.deepEqual(calls[0].values, ["lq_e0m6", 2]);
});

test("invalid map names and difficulties never reach the native command boundary", async () => {
  const { engine, calls } = mapFixture();
  for (const map of [null,"","../map","lq_e0m6;kill","x".repeat(41)]) await assert.rejects(engine.loadMap(map, 0), /Invalid map/);
  for (const level of [null,"2",-1,4,NaN,Infinity,1.5]) await assert.rejects(engine.loadMap("lq_e0m6", level), /Invalid difficulty/);
  assert.deepEqual(calls, []);
});

test("an engine fault rejects waits before querying an exited WASM instance or timing out", async () => {
  const fault = engineErrorFromLog("Error: Couldn't load gfx/palette.lmp");
  const engine = new Engine({ _qev_snapshot() { assert.fail("must not query a failed engine"); } }, () => fault);
  await assert.rejects(engine.waitFor(() => false, 30_000), (error) => error === fault);
});
