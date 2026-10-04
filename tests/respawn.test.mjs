import assert from "node:assert/strict";
import test from "node:test";
import { Respawner } from "../src/respawn.js";

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture(mode = "auto") {
  const state = { ready: true, alive: false, completed: false, paused: true, epoch: 7, map: "lq_e0m6", difficulty: 2 };
  const model = {}, waits = [], loads = [], stages = [], resumed = [];
  let selectedModel = model;
  const agent = { generation: 0, busy: false, getModel: () => selectedModel, invalidate() { this.generation++; } };
  const engine = { snapshot: () => structuredClone(state), async loadMap(map, difficulty) {
    loads.push({ map, difficulty }); Object.assign(state, { map, difficulty, epoch: state.epoch + 1, alive: true, paused: true }); return structuredClone(state);
  } };
  const r = new Respawner({ engine, agent, getMode: () => mode,
    onState: (stage, job) => stages.push({ stage, ...job }), onResume: mode => resumed.push(mode),
    wait: ms => new Promise(resolve => waits.push({ ms, resolve })) });
  return { r, engine, agent, state, loads, waits, stages, resumed, changeModel: () => { selectedModel = {}; } };
}

for (const mode of ["auto", "human", "inspection"]) {
  test(`death restarts the active map/difficulty and preserves ${mode} intent`, async () => {
    const f = fixture(mode), before = structuredClone(f.state);
    const p = f.r.observe(f.state);
    assert.equal(f.agent.generation, 1, "invalidate old decisions before any delay/reload");
    assert.equal(f.waits[0].ms, 750);
    assert.equal(f.r.observe(f.state), null, "one restart for repeated death polls");
    f.waits[0].resolve(); await p;
    assert.deepEqual(f.loads, [{ map: before.map, difficulty: before.difficulty }]);
    assert.equal(f.r.count, 1);
    assert.equal(f.r.pending, null);
    assert.deepEqual(f.resumed, mode === "inspection" ? [] : [mode]);
    assert.ok(f.state.alive && f.state.paused, "resume callback, not stale native input, owns continuation");
  });
}

for (const patch of [{ ready: false }, { alive: true }, { completed: true }]) {
  test(`non-death state ${JSON.stringify(patch)} never auto-restarts`, () => {
    const f = fixture(); Object.assign(f.state, patch);
    assert.equal(f.r.observe(f.state), null);
    assert.equal(f.loads.length, 0);
    assert.equal(f.agent.generation, 0);
  });
}

test("Pause/focus loss cancels continuation but the new life remains safely paused", async () => {
  const f = fixture(), p = f.r.observe(f.state);
  f.r.cancelResume(); f.waits[0].resolve(); await p;
  assert.equal(f.loads.length, 1);
  assert.equal(f.r.count, 1);
  assert.deepEqual(f.resumed, []);
  assert.equal(f.state.paused, true);
});

test("Auto waits for an invalidated old worker job before starting a fresh session", async () => {
  const f = fixture(); f.agent.busy = true;
  const p = f.r.observe(f.state); f.waits[0].resolve(); await settle();
  assert.equal(f.loads.length, 1);
  assert.equal(f.waits[1].ms, 25);
  assert.equal(f.r.count, 1);
  assert.deepEqual(f.resumed, []);
  assert.ok(f.stages.some(s => s.stage === "waiting"));
  f.agent.busy = false; f.waits[1].resolve(); await p;
  assert.deepEqual(f.resumed, ["auto"]);
});

test("Pause while waiting for a hung inference releases the respawn UI without resuming", async () => {
  const f = fixture(); f.agent.busy = true;
  const p = f.r.observe(f.state); f.waits[0].resolve(); await settle();
  f.r.cancelResume(); f.waits[1].resolve(); await p;
  assert.equal(f.r.pending, null);
  assert.equal(f.agent.busy, true);
  assert.deepEqual(f.resumed, []);
});

for (const change of ["model", "generation", "world", "takeover"]) {
  test(`${change} change during respawn prevents stale automatic continuation`, async () => {
    const f = fixture(); f.agent.busy = true;
    const p = f.r.observe(f.state); f.waits[0].resolve(); await settle();
    if (change === "model") f.changeModel();
    if (change === "generation") f.agent.generation++;
    if (change === "world") f.state.epoch++;
    if (change === "takeover") f.state.paused = false;
    f.agent.busy = false; f.waits[1].resolve(); await p;
    assert.deepEqual(f.resumed, []);
  });
}

test("an intervening manual map load is not overwritten by a delayed respawn", async () => {
  const f = fixture(), p = f.r.observe(f.state);
  Object.assign(f.state, { epoch: 8, map: "lq_e0m2", alive: true });
  f.waits[0].resolve();
  assert.equal(await p, false);
  assert.equal(f.loads.length, 0);
  assert.deepEqual(f.resumed, []);
});

test("a failed restart reports its error once rather than entering a reload storm", async () => {
  const f = fixture();
  f.engine.loadMap = async () => { f.state.epoch++; throw new Error("Failed to load map"); };
  const p = f.r.observe(f.state); f.waits[0].resolve();
  await assert.rejects(p, /Failed to load map/);
  assert.equal(f.r.pending, null);
  assert.equal(f.r.count, 0);
  assert.equal(f.r.observe(f.state), null);
  assert.deepEqual(f.resumed, []);
});

test("a failed spawn cannot resume and will not be immediately retried", async () => {
  const f = fixture();
  f.engine.loadMap = async () => { f.state.epoch++; };
  const p = f.r.observe(f.state); f.waits[0].resolve();
  await assert.rejects(p, /live player/);
  assert.equal(f.r.observe(f.state), null);
  assert.deepEqual(f.resumed, []);
});

test("a subsequent death creates a distinct fresh attempt", async () => {
  const f = fixture();
  let p = f.r.observe(f.state); f.waits[0].resolve(); await p;
  Object.assign(f.state, { alive: false, epoch: f.state.epoch + 1 });
  p = f.r.observe(f.state); f.waits[1].resolve(); await p;
  assert.equal(f.loads.length, 2);
  assert.equal(f.r.count, 2);
});

test("controlled evaluation can suspend automatic retries without changing game rules", () => {
  const f = fixture(); f.r.enabled = false;
  assert.equal(f.r.observe(f.state), null);
  assert.equal(f.agent.generation, 0);
});
