import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANCE, DEFAULT_ASSISTANCE, assistanceOf, validateAssistance } from "../src/assistance.js";
import { RAW_INPUTS, RAW_OFFER_POLICY, unassistedState } from "../src/unassisted.js";
import { prepareDecision, candidates, requestsFor, rankResponses, situation } from "../src/decisions.js";
import { DEFAULT_PRIORITY_ORDER, goalPrompt } from "../src/objective.js";
import { Agent } from "../src/agent.js";
import { Stepper } from "../src/stepper.js";
import { decisionView, decisionOutcome } from "../src/decision-cards.js";
import { replies } from "./replies.mjs";

const observation = () => ({ ready: true, paused: true, alive: true, completed: false, assistance: "unassisted",
  epoch: 4, tick: 20, map: "test", remaining: 0, owned: true, controlSession: 1, actionSerial: 0, actionTicks: 0, actionTicksLeft: 0,
  player: { health: 50, armor: 20, ammo: 25, weapon: "shotgun", silverKey: false, goldKey: true },
  screen: { source: "renderer-visible-pixels", available: true, frame: 20, tick: 20, distorted: false, viewport: [0, 0, 640, 432] },
  enemies: [{ kind: "monster_army", visible: true, screen: { bounds: [0.2, 0.35, 0.4, 0.65], pixels: 3000, aimOverlap: false, clipped: false, sameKindCount: 1 } }],
  pickups: [{ kind: "health", visible: true, screen: { bounds: [0.7, 0.6, 0.75, 0.7], pixels: 400, aimOverlap: false, clipped: false, sameKindCount: 1 } }] });
const forbidden = () => assert.fail("assistance-off must not query privileged telemetry or geometry");
function poison(object, fields) {
  for (const key of fields) Object.defineProperty(object, key, { get: forbidden });
  return object;
}
function fixture(mode = "unassisted") {
  const state = observation(), calls = [], actions = [];
  state.assistance = mode;
  const engine = {
    snapshot: () => structuredClone(state), probe: forbidden,
    pause() { state.paused = true; state.controlSession++; state.actionTicksLeft = state.remaining = 0; },
    startAuto() { state.paused = false; return ++state.controlSession; },
    setAssistance(value) { if (state.assistance !== value) { engine.pause(); state.assistance = value; state.epoch++; } },
    act: async p => { actions.push(p); state.tick += p.ticks; state.player.health -= 2; state.player.ammo -= p.fire ? 1 : 0; return engine.snapshot(); },
    applyLive(p) { actions.push(p); state.actionSerial++; state.actionTicks = 0; state.actionTicksLeft = p.ticks; return true; },
  };
  const model = { info: { backend: "unassisted-regression" }, decideMany(requests) { return new Promise(resolve => calls.push({ requests, resolve })); } };
  const agent = new Agent({ engine, getModel: () => model });
  const answer = (id = "fire") => {
    const call = calls.at(-1), keys = Object.keys(call.requests[0].questions.action.criteria), response = replies(call.requests, keys.indexOf(id));
    call.resolve(response); return response;
  };
  return { agent, engine, model, state, calls, actions, answer };
}

test("assistance defaults on and both modes disclose their actual sensing/control boundaries", () => {
  assert.equal(DEFAULT_ASSISTANCE, "assisted");
  assert.equal(assistanceOf({}), "assisted");
  for (const value of ["assisted", "unassisted"]) assert.equal(validateAssistance(value), value);
  assert.match(ASSISTANCE.assisted.observationPolicy, /privileged local geometry/);
  assert.match(ASSISTANCE.unassisted.observationPolicy, /not RGB-only vision/);
  assert.match(ASSISTANCE.unassisted.note, /no probes, GPS, auto-aim/);
  for (const value of [undefined, null, true, false, "off", "raw", 0, 1]) assert.throws(() => validateAssistance(value), /Invalid assistance/);
  assert.throws(() => assistanceOf({ assistance: null }), /Invalid assistance/);
});

for (const decisionFormat of ["choice", "noul"]) {
  test(`${decisionFormat} assistance-off never queries geometry, GPS, exact bearings, IDs or navigation`, () => {
    const s = observation();
    poison(s.player, ["position", "yaw", "pitch", "grounded", "inWater"]);
    for (const e of [...s.enemies, ...s.pickups]) poison(e, ["position", "distance", "bearingRight", "bearing", "elevation", "range", "slot", "generation", "health", "intent"]);
    const navigation = new Proxy({}, { get: forbidden });
    const r = prepareDecision(s, forbidden, null, { realtime: true, decisionFormat, navigation });
    assert.equal(r.assistance, "unassisted");
    assert.equal(r.navigation, null); assert.equal(r.steering, null);
    assert.equal(r.offerPolicy, RAW_OFFER_POLICY);
    assert.equal(r.eligible.length, 14);
    assert.ok(r.eligible.every(c => c.allowed && c.geometry === null && c.route === null && !c.reason));
    assert.equal(r.requests.length, decisionFormat === "choice" ? 1 : 14);
    assert.deepEqual(requestsFor(r.eligible, r.sharedState, decisionFormat), r.requests);
    assert.equal(candidates(s, forbidden, null, { navigation }).length, 14);
    assert.match(situation(s), /HUD: health 50/);
    for (const request of r.requests) {
      assert.match(request.state, /Assistance OFF/);
      assert.match(request.state, /armed grunt left\/level \(30,50\), large h30%, aim off/);
      assert.match(request.state, /health right\/below \(73,65\), small h10%, aim off/);
      assert.doesNotMatch(request.state, /LOS blocked|LOS clear|clear floor|new cell|visited grid|waypoint|enemy farther|enemy closer|silver key required/);
    }
  });
}

test("the fixed input set does not change with health, ammo, weapon, visibility or pickups", () => {
  const ids = RAW_INPUTS.map(input => input.id);
  for (const health of [5, 100, 250]) for (const ammo of [0, 25]) for (const weapon of ["axe", "shotgun"]) {
    const s = observation(); Object.assign(s.player, { health, ammo, weapon });
    for (const enemies of [s.enemies, []]) {
      s.enemies = enemies;
      const r = prepareDecision(s, forbidden, { epoch: s.epoch, label: "walk", damage: 50, ammoChange: -2 }, { realtime: true });
      assert.deepEqual(r.eligible.map(c => c.id), ids);
      assert.ok(r.eligible.find(c => c.id === "fire").params.fire);
      assert.ok(r.eligible.every(c => !c.filterKind && !c.offerNote));
    }
  }
});

test("relative input parameters encode ordinary view-relative axes/rates, not target coordinates", () => {
  for (const realtime of [true, false]) {
    const r = prepareDecision(observation(), forbidden, null, { realtime });
    const p = id => r.eligible.find(c => c.id === id).params;
    assert.equal(p("forward").forward, 1); assert.equal(p("back").forward, -1);
    assert.equal(p("left").side, -1); assert.equal(p("right").side, 1);
    assert.equal(p("turn-left").yawRate, 60); assert.equal(p("turn-right").yawRate, -60);
    assert.equal(p("look-up").pitchRate, -45); assert.equal(p("look-down").pitchRate, 45);
    for (const c of r.eligible) {
      assert.equal(c.params.input, "relative"); assert.equal(c.params.ticks, realtime ? 45 : 12);
      assert.ok(Math.hypot(c.params.forward, c.params.side) <= 1);
      assert.ok(!["dx", "dy", "yaw", "pitch", "slot", "generation"].some(key => key in c.params));
    }
    assert.deepEqual([p("wait").forward, p("wait").side, p("wait").yawRate, p("wait").pitchRate, p("wait").fire], [0, 0, 0, 0, false]);
  }
});

test("raw prompt formatting excludes unobserved contacts and never falls back to exact telemetry", () => {
  const s = observation(); s.enemies.push({ kind: "HIDDEN_ENEMY", visible: false });
  Object.assign(s.enemies[0], { screen: null, bearing: undefined, elevation: "SECRET_ANGLE", range: 123, bearingRight: 20, distance: 90, slot: 9999, position: [999, 999, 999] });
  s.player.hidden = "SECRET_PLAYER_FIELD";
  const text = unassistedState(s);
  assert.match(text, /Enemies: none visible/);
  assert.doesNotMatch(text, /SECRET_|HIDDEN_ENEMY|999|distance|bearingRight/);
});

test("raw inputs respect reordered priorities without changing the offered actions or probabilities", () => {
  const order = [...DEFAULT_PRIORITY_ORDER].reverse(), r = prepareDecision(observation(), forbidden, null, { priorityOrder: order });
  assert.ok(r.requests[0].state.startsWith(goalPrompt(order)));
  const response = replies(r.requests, r.eligible.findIndex(c => c.id === "wait"));
  const saved = structuredClone(response);
  assert.equal(rankResponses(response, r.eligible)[0].id, "wait");
  assert.deepEqual(response, saved);
  assert.deepEqual(r.eligible.map(c => c.id), RAW_INPUTS.map(c => c.id));
});

test("a raw inspection action is applied unchanged, without probes or GPS-derived memory", async () => {
  const f = fixture(), stepper = new Stepper(f.agent);
  const pending = stepper.step(); f.answer("left-fire"); await pending;
  const r = f.agent.current;
  assert.equal(r.assistance, "unassisted"); assert.equal(r.status, "executed");
  assert.strictEqual(f.actions[0], r.eligible[r.selectedIndex].params);
  assert.equal(r.navigationAfter, null);
  assert.deepEqual(Object.keys(f.agent.memory).sort(), ["ammoChange", "damage", "epoch", "label", "realtime"]);
  assert.equal(f.agent.memory.damage, 2); assert.equal(f.agent.memory.ammoChange, -1);
  assert.match(decisionView(r).meta, /aids off/);
  assert.equal(decisionOutcome(r).assistance, "unassisted");
  assert.ok(!("position" in r.before.player));
  assert.equal(f.agent.navigation.inspect().rememberedCells, 0);
});

test("raw live application and outcome observation also avoid all geometry/navigation queries", async () => {
  const f = fixture(); f.agent.startLive();
  const pending = f.agent.score({ realtime: true }); f.answer("forward-fire"); const r = await pending;
  assert.equal(f.agent.applyLive(), true);
  assert.equal(r.appliedGeometry, null); assert.equal(r.appliedNavigation, null);
  f.state.tick += 3; f.state.actionTicks = 3; f.state.actionTicksLeft -= 3;
  f.agent.observeLive(f.engine.snapshot()); f.agent.pause();
  assert.equal(r.status, "interrupted"); assert.equal(r.execution.ticksApplied, 3);
  assert.equal(r.navigationAfter, null); assert.equal(f.agent.navigation.inspect().rememberedCells, 0);
  assert.equal(f.agent.memory.label, "Walk forward and fire");
});

for (const realtime of [false, true]) {
  test(`an assistance switch discards pending ${realtime ? "live" : "inspection"} replies and mode labels remain historical`, async () => {
    const f = fixture(); if (realtime) f.agent.startLive();
    const pending = f.agent.score({ realtime }), record = f.agent.current, original = JSON.stringify(record.requests);
    f.engine.setAssistance("assisted"); // Even direct native mode changes must make the observation stale.
    f.answer(); assert.equal(await pending, null);
    assert.equal(record.status, "discarded"); assert.equal(record.assistance, "unassisted");
    assert.equal(JSON.stringify(record.requests), original); assert.equal(f.actions.length, 0);
  });
}

test("off/on/off cannot replay a frozen score from the first off epoch", async () => {
  const f = fixture(), pending = f.agent.score(); f.answer(); const r = await pending;
  f.engine.setAssistance("assisted"); f.engine.setAssistance("unassisted");
  await assert.rejects(f.agent.step(), /world changed/);
  assert.equal(r.status, "discarded"); assert.equal(f.actions.length, 0);
});

test("entering off mode clears previously learned GPS navigation instead of retaining hidden help", () => {
  const f = fixture();
  const precise = { ...observation(), assistance: "assisted", player: { ...observation().player, position: [0, 0, 24], yaw: 0 }, enemies: [], pickups: [] };
  f.agent.navigation.observe(precise); precise.player.position = [100, 0, 24]; f.agent.navigation.observe(precise);
  f.agent.memory = { epoch: 4, displacement: 100, label: "Privileged route", damage: 0 };
  assert.equal(f.agent.navigation.inspect().rememberedCells, 2);
  f.agent.observeLive(f.engine.snapshot());
  assert.equal(f.agent.navigation.inspect().rememberedCells, 0);
  assert.equal(f.agent.memory, null);
});

for (const terminal of ["unready", "dead", "complete"]) {
  test(`raw mode offers no actions for a ${terminal} world`, () => {
    const s = observation();
    if (terminal === "unready") s.ready = false;
    if (terminal === "dead") s.alive = false;
    if (terminal === "complete") s.completed = true;
    assert.deepEqual(prepareDecision(s, forbidden).eligible, []);
  });
}
