import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { Stepper } from "../src/stepper.js";
import { replies } from "./replies.mjs";

function fixture({ deferAction = false } = {}) {
  const state = { version: 1, ready: true, alive: true, completed: false, paused: true, remaining: 0, epoch: 1, tick: 40,
    player: { health: 100, armor: 0, ammo: 25, weapon: "shotgun", position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true, inWater: false }, enemies: [], pickups: [] };
  const calls = [], actions = [];
  let pending, finishAction;
  const decideMany = (requests) => { calls.push(requests); return new Promise((resolve, reject) => { pending = { resolve, reject }; }); };
  let model = { info: { arch: "test" }, decideMany };
  const engine = {
    snapshot: () => structuredClone(state),
    pause() { state.paused = true; state.remaining = 0; },
    probe: p => ({ blocked: false, supported: true, hazard: false, end: [p.dx * 40, p.dy * 40, 24], lineOfSightAtEndpoint: null }),
    act(params) {
      actions.push(params); state.paused = false;
      if (!deferAction) { state.tick += params.ticks; state.paused = true; return Promise.resolve(structuredClone(state)); }
      state.tick += 3; state.remaining = params.ticks - 3;
      return new Promise(resolve => { finishAction = () => {
        state.tick += state.remaining; state.remaining = 0; state.paused = true; resolve(structuredClone(state));
      }; });
    },
  };
  const agent = new Agent({ engine, getModel: () => model });
  const stepper = new Stepper(agent);
  return { state, agent, stepper, calls, actions, get pending() { return pending; },
    reply() { pending.resolve(replies(calls.at(-1))); }, finishAction: () => finishAction(),
    changeModel() { model = { info: { arch: "new-model" }, decideMany }; } };
}

test("one Step scores a frozen observation, runs exactly one action, and stops", async () => {
  const f = fixture(), pending = f.stepper.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.length, 0);
  assert.equal(f.state.tick, 40);
  assert.equal(f.state.paused, true);
  assert.equal(f.stepper.busy, true);
  f.reply(); const after = await pending;
  assert.equal(f.actions.length, 1);
  assert.equal(after.tick, 52);
  assert.equal(after.paused, true);
  assert.equal(f.agent.current.status, "executed");
  assert.deepEqual(f.actions[0], f.agent.current.eligible[f.agent.current.selectedIndex].params);
  assert.equal(f.stepper.busy, false);
});

test("successive Step clicks each get a fresh decision instead of replaying the old action", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) { const pending = f.stepper.step(); f.reply(); await pending; }
  assert.equal(f.calls.length, 2);
  assert.equal(f.actions.length, 2);
  assert.equal(f.state.tick, 64);
  assert.equal(f.agent.history[1].before.tick, 52);
});

test("an already scored, still-fresh inspection decision can be stepped without rescoring", async () => {
  const f = fixture(), score = f.agent.score(); f.reply(); await score;
  await f.stepper.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.length, 1);
});

for (const change of ["tick", "epoch", "model", "generation"]) {
  test(`Step rescores rather than applying a decision with a changed ${change}`, async () => {
    const f = fixture(), score = f.agent.score(); f.reply(); await score;
    if (change === "model") f.changeModel();
    else if (change === "generation") f.agent.generation++;
    else f.state[change]++;
    const pending = f.stepper.step();
    assert.equal(f.calls.length, 2);
    assert.equal(f.actions.length, 0);
    f.reply(); await pending;
    assert.equal(f.actions.length, 1);
  });
}

test("Stop during Step inference discards the late reply and never starts its action", async () => {
  const f = fixture(), pending = f.stepper.step();
  const record = f.agent.current;
  assert.equal(f.stepper.cancel(), true);
  assert.equal(f.stepper.cancel(), false);
  assert.equal(f.stepper.busy, false);
  assert.equal(f.agent.busy, true, "the worker still has to settle");
  f.reply();
  assert.equal(await pending, null);
  assert.equal(record.status, "discarded");
  assert.ok(record.responses);
  assert.equal(f.actions.length, 0);
  assert.equal(f.state.tick, 40);
  assert.equal(f.state.paused, true);
});

test("Stop during the action releases inputs and cannot resume the remaining ticks", async () => {
  const f = fixture({ deferAction: true }), pending = f.stepper.step();
  f.reply(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.actions.length, 1);
  assert.equal(f.state.remaining, 9);
  f.stepper.cancel(); const stoppedTick = f.state.tick;
  f.finishAction(); await pending;
  assert.equal(f.state.tick, stoppedTick);
  assert.equal(f.state.remaining, 0);
  assert.equal(f.state.paused, true);
  assert.equal(f.stepper.busy, false);
});

test("a map change during Step inference cannot execute a reply on the new level", async () => {
  const f = fixture(), pending = f.stepper.step();
  f.stepper.cancel(); f.state.epoch++; f.state.tick = 1;
  f.reply(); await pending;
  assert.equal(f.actions.length, 0);
  assert.equal(f.state.tick, 1);
  assert.equal(f.state.paused, true);
});

test("repeated Step while busy never starts concurrent inference", async () => {
  const f = fixture(), pending = f.stepper.step();
  await assert.rejects(f.stepper.step(), /Wait for the current decision/);
  assert.equal(f.calls.length, 1);
  f.reply(); await pending;
});

test("model failure ends the step without advancing simulation or applying a fallback", async () => {
  const f = fixture(), pending = f.stepper.step();
  f.pending.reject(new Error("Model failed"));
  await assert.rejects(pending, /Model failed/);
  assert.equal(f.stepper.busy, false);
  assert.equal(f.state.tick, 40);
  assert.equal(f.state.paused, true);
  assert.equal(f.actions.length, 0);
});

test("Step refuses a running, dead, completed, or unready world", async () => {
  for (const change of [{ paused: false }, { alive: false }, { completed: true }, { ready: false }]) {
    const f = fixture(); Object.assign(f.state, change);
    await assert.rejects(f.stepper.step(), /Stop a live game/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.stepper.busy, false);
  }
});
