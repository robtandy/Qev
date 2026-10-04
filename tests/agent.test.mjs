import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { candidates, prepareDecision, rankResponses, situation } from "../src/decisions.js";
import { replies } from "./replies.mjs";

const observation = () => ({
  version: 1, ready: true, paused: true, alive: true, epoch: 3, tick: 42, remaining: 0,
  player: { health: 28, armor: 0, ammo: 8, weapon: "shotgun", position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true, inWater: false },
  enemies: [{ slot: 7, generation: 2, kind: "monster_army", position: [300, -30, 24], distance: 302, bearingRight: 6, visible: true }],
  pickups: [{ slot: 9, generation: 1, kind: "health", position: [0, 80, 24], distance: 80, bearingRight: -90, visible: true }],
});
const clearProbe = (p) => ({ blocked: false, supported: true, hazard: false, end: [p.dx * 40, p.dy * 40, 24], lineOfSightAtEndpoint: p.slot > 0 ? true : null });
function fixture() {
  let snapshot = observation();
  let pending;
  const calls = [], actions = [];
  const model = { info: { model: "test", backend: "mock" }, decideMany(requests) {
    calls.push(requests);
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  } };
  const engine = {
    snapshot: () => structuredClone(snapshot),
    pause: () => { snapshot.paused = true; },
    probe: clearProbe,
    act: async (params) => { actions.push(params); snapshot.tick += params.ticks; snapshot.player.position[0] += 20; snapshot.player.health -= 2; return structuredClone(snapshot); },
  };
  const agent = new Agent({ engine, getModel: () => model });
  return { agent, engine, model, calls, actions, get state() { return snapshot; }, set state(s) { snapshot = s; }, get pending() { return pending; } };
}
async function scored(f) { const p = f.agent.score(); f.pending.resolve(replies(f.calls[0])); return p; }

test("shared-state choice keeps rejected moves outside model input and retains scans", () => {
  const result = prepareDecision(observation(), (p) => ({ ...clearProbe(p), hazard: p.dy < 0 }));
  assert.ok(result.candidates.some((c) => !c.allowed));
  assert.ok(result.eligible.every((c) => c.allowed));
  assert.ok(result.eligible.length <= 8);
  assert.ok(result.eligible.some((c) => c.id === "scan-left"));
  assert.ok(result.eligible.some((c) => c.id === "scan-right"));
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].state, result.sharedState);
  assert.equal(result.requests[0].questions.action.type, "choice");
  assert.deepEqual(Object.keys(result.requests[0].questions.action.criteria), result.eligible.map((c) => c.id));
  for (const c of result.eligible) assert.equal(c.params.ticks, 12);
});

test("axis conventions and diagonal normalization match Quake view angles", () => {
  const state = observation();
  state.enemies = [];
  const list = candidates(state, clearProbe);
  assert.equal(list.find((c) => c.id === "forward").params.dx, 1);
  assert.equal(list.find((c) => c.id === "left").params.dy, 1);
  assert.equal(list.find((c) => c.id === "right").params.dy, -1);
  for (const c of list) assert.ok(Math.hypot(c.params.dx, c.params.dy) <= 1.000001);
  assert.equal(list.find((c) => c.id === "scan-left").params.yaw, 36);
  assert.equal(list.find((c) => c.id === "scan-right").params.yaw, 324);
});

test("no ammunition filters firing; no enemies is not represented as a safe world", () => {
  const state = observation(); state.player.ammo = 0;
  let result = prepareDecision(state, clearProbe);
  assert.ok(result.candidates.filter((c) => c.params.fire).every((c) => !c.allowed));
  assert.ok(result.eligible.every((c) => !c.params.fire));
  state.enemies = [];
  result = prepareDecision(state, clearProbe);
  assert.match(result.requests[0].state, /unseen areas are unknown/);
});

test("blocked and unsupported movement is filtered without assigning tactical scores in code", () => {
  for (const bad of [{ blocked: true }, { supported: false }, { hazard: true }]) {
    const r = prepareDecision(observation(), (p) => ({ ...clearProbe(p), ...(p.dx || p.dy ? bad : {}) }));
    assert.ok(r.candidates.some((c) => !c.allowed));
    assert.ok(r.eligible.every((c) => !c.params.dx && !c.params.dy));
  }
});

test("unapproved engine fields and old-episode memories never enter the prompt", () => {
  const state = observation();
  state.hiddenEnemies = [{ password: "DO_NOT_SEND" }];
  state.enemies[0].health = "SECRET_ENEMY_HEALTH";
  state.enemies[0].intent = "SECRET_AI_INTENT";
  state.player.internal = "SECRET_INTERNAL";
  const text = prepareDecision(state, clearProbe, { epoch: 99, label: "OLD_EPISODE" }).requests.map((r) => r.state).join("\n");
  assert.doesNotMatch(text, /DO_NOT_SEND|SECRET_|OLD_EPISODE/);
  assert.match(situation(state, { epoch: 3, label: "walk", displacement: 1, damage: 4 }), /almost no displacement; lost 4 health/);
});

test("actors marked unobserved are excluded even if a telemetry adapter includes them", () => {
  const state = observation();
  state.enemies[0].visible = false;
  state.pickups[0].visible = false;
  const result = prepareDecision(state, clearProbe);
  assert.ok(result.eligible.every((c) => c.params.slot === -1));
  assert.doesNotMatch(result.requests.map((r) => r.state).join(" "), /army|visible health/);
});

test("airborne scanning remains possible without claiming established floor support", () => {
  const state = observation(); state.player.grounded = false;
  const result = prepareDecision(state, (p) => ({ ...clearProbe(p), supported: false }));
  const scan = result.eligible.find((c) => c.id === "scan-left");
  assert.ok(scan);
  assert.match(scan.state, /Airborne|gravity/);
  assert.doesNotMatch(scan.state, /has floor support/);
  assert.ok(result.eligible.every((c) => c.params.dx === 0 && c.params.dy === 0));
});

test("non-firing choices describe enemy exposure too, not just the pickup's line of sight", () => {
  const result = prepareDecision(observation(), (p) => ({ ...clearProbe(p), lineOfSightAtEndpoint: p.slot === 7 }));
  const scan = result.eligible.find((c) => c.id === "scan-left");
  const pickup = result.eligible.find((c) => c.id === "pickup-9");
  for (const candidate of [scan, pickup]) {
    assert.match(candidate.state, /remains exposed to the observed enemy/);
    assert.match(candidate.state, /Does not fire at the observed enemy/);
    assert.equal(candidate.geometry.threatExposure.slot, 7);
    assert.equal(candidate.geometry.threatExposure.lineOfSightAtEndpoint, true);
  }
});

test("ranking maps back to original indices, retains public precision, and breaks ties by input order", () => {
  const r = [{ answers: { favorable: { noul: 0.123456789 } } }, { answers: { favorable: { noul: 0.8 } } }, { answers: { favorable: { noul: 0.8 } } }];
  const saved = structuredClone(r);
  const ranked = rankResponses(r, [{ id: "a" }, { id: "b" }, { id: "c" }], "noul");
  assert.deepEqual(ranked.map((x) => x.index), [1, 2, 0]);
  assert.equal(ranked[2].probability, 0.123456789);
  assert.deepEqual(r, saved);
});

for (const value of [undefined, null, "0.9", NaN, Infinity, -0.1, 1.1]) {
  test(`rejects invalid model probabilities (${String(value)})`, () => {
    assert.throws(() => rankResponses([{ answers: { favorable: { noul: value } } }], [{ id: "a" }], "noul"), /Invalid/);
  });
}

test("score freezes time and captures the actual complete input and untouched response", async () => {
  const f = fixture();
  const before = f.engine.snapshot();
  const promise = f.agent.score();
  assert.equal(f.agent.busy, true);
  assert.equal(f.calls.length, 1);
  assert.strictEqual(f.agent.current.requests, f.calls[0]);
  const response = replies(f.calls[0]);
  f.pending.resolve(response);
  const record = await promise;
  assert.strictEqual(record.responses, response);
  assert.equal(record.responses[0].raw_probabilities.action[0], 0.123456789);
  assert.equal(record.status, "scored");
  assert.equal(f.actions.length, 0);
  assert.deepEqual(f.engine.snapshot(), before);
  assert.equal(f.agent.busy, false);
});

test("only an explicit step executes one bounded selected action and records its measured outcome", async () => {
  const f = fixture();
  const record = await scored(f);
  await f.agent.step();
  assert.equal(f.actions.length, 1);
  assert.strictEqual(f.actions[0], record.eligible[record.selectedIndex].params);
  assert.equal(record.after.tick - record.before.tick, 12);
  assert.equal(record.status, "executed");
  assert.equal(f.agent.memory.damage, 2);
  await assert.rejects(f.agent.step(), /Score/);
});

test("only one score is in flight and repeated step clicks cannot queue more execution", async () => {
  const f = fixture();
  const p = f.agent.score();
  await assert.rejects(f.agent.score(), /Wait/);
  await assert.rejects(f.agent.step(), /Wait/);
  f.pending.resolve(replies(f.calls[0])); await p;
  let finish;
  f.engine.act = () => new Promise((r) => { finish = r; });
  const stepping = f.agent.step();
  await assert.rejects(f.agent.step(), /Wait/);
  finish({ ...f.engine.snapshot(), tick: 54 });
  await stepping;
});

for (const change of ["reset", "tick", "model", "death", "completion"]) {
  test(`${change} discards a late result without executing`, async () => {
    const f = fixture();
    const p = f.agent.score();
    const record = f.agent.current;
    if (change === "reset") { f.agent.invalidate(); f.state.epoch++; }
    if (change === "tick") f.state.tick++;
    if (change === "model") f.agent.getModel = () => ({});
    if (change === "death") f.state.alive = false;
    if (change === "completion") f.state.completed = true;
    f.pending.resolve(replies(f.calls[0]));
    assert.equal(await p, null);
    assert.equal(record.status, "discarded");
    assert.equal(f.actions.length, 0);
    assert.equal(f.agent.busy, false);
  });
}

test("pausing while scoring still allows inspection but never executes the answer", async () => {
  const f = fixture(); const p = f.agent.score();
  f.agent.pause(); f.pending.resolve(replies(f.calls[0]));
  assert.equal((await p).status, "scored");
  assert.equal(f.actions.length, 0);
});

test("a changed snapshot cannot execute an otherwise valid old choice", async () => {
  const f = fixture(); await scored(f); f.state.tick++;
  await assert.rejects(f.agent.step(), /world changed/);
  assert.equal(f.actions.length, 0);
});

test("an error after invalidation is discarded; an active error retains the actual error", async () => {
  const f = fixture(); let p = f.agent.score();
  f.agent.invalidate(); f.pending.reject(new Error("old model failed"));
  assert.equal(await p, null);
  assert.equal(f.agent.current, null);
  p = f.agent.score(); f.pending.reject(new Error("active failure"));
  await assert.rejects(p, /active failure/);
  assert.equal(f.agent.current.status, "error");
  assert.equal(f.agent.current.error, "active failure");
  assert.equal(f.agent.busy, false);
});

test("malformed responses remain available for diagnosis but cannot become a choice", async () => {
  const f = fixture(); const p = f.agent.score();
  const bad = [{ unexpected: "raw payload" }]; f.pending.resolve(bad);
  await assert.rejects(p, /Invalid action choice/);
  assert.strictEqual(f.agent.current.responses, bad);
  assert.equal(f.agent.current.selectedIndex, null);
  await assert.rejects(f.agent.step(), /Score/);
});

test("an interrupted action records actual ticks, not the requested duration", async () => {
  const f = fixture(); await scored(f);
  f.engine.act = async () => ({ ...f.engine.snapshot(), tick: 45 });
  await f.agent.step();
  assert.equal(f.agent.current.status, "interrupted");
  assert.equal(f.agent.current.after.tick - f.agent.current.before.tick, 3);
});

test("repeated scans record measured absence of new contacts and reset with the episode", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const p = f.agent.score(); f.pending.resolve(replies(f.calls.at(-1))); await p;
    assert.match(f.agent.current.eligible[f.agent.current.selectedIndex].id, /^scan-/);
    await f.agent.step();
  }
  assert.equal(f.agent.memory.scansWithoutNewContacts, 2);
  assert.match(situation(f.engine.snapshot(), f.agent.memory), /Scanned 2 consecutive times/);
  f.agent.invalidate();
  assert.equal(f.agent.memory, null);
});

test("history is bounded and retains paired requests and responses", async () => {
  const f = fixture();
  for (let i = 0; i < 55; i++) {
    const p = f.agent.score(); f.pending.resolve(replies(f.calls.at(-1))); await p;
  }
  assert.equal(f.agent.history.length, 50);
  assert.equal(f.agent.history[0].id, 6);
  assert.equal(f.agent.history.at(-1).id, 55);
});
