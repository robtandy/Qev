import assert from "node:assert/strict";
import test from "node:test";
import { PRIORITIES, DEFAULT_PRIORITY_ORDER, PRIMARY_OBJECTIVE, GOAL_PROMPT, SURVIVAL_OBJECTIVES,
  validatePriorityOrder, objectivesFor, goalPrompt, movePriority } from "../src/objective.js";
import { prepareDecision, requestsFor, situation } from "../src/decisions.js";
import { Agent } from "../src/agent.js";
import { Stepper } from "../src/stepper.js";
import { decisionOutcome, modelState } from "../src/decision-cards.js";
import { replies } from "./replies.mjs";

const state = () => ({ ready: true, alive: true, completed: false, paused: true, owned: true, map: "test",
  epoch: 1, tick: 20, remaining: 0, controlSession: 1, actionSerial: 0, actionTicks: 0, actionTicksLeft: 0,
  player: { health: 25, armor: 0, ammo: 5, weapon: "shotgun", position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true },
  enemies: [{ slot: 7, generation: 1, kind: "monster_army", visible: true, position: [80, 0, 24], distance: 80, bearingRight: 0 }],
  pickups: [{ slot: 8, generation: 1, kind: "health", visible: true, position: [0, 80, 24], distance: 80, bearingRight: -90 }] });
const probe = p => ({ blocked: false, supported: true, hazard: false,
  end: [p.dx * p.ticks * 200 / 60, p.dy * p.ticks * 200 / 60, 24], lineOfSightAtEndpoint: p.slot > 0 ? true : null });
const exploreFirst = movePriority(DEFAULT_PRIORITY_ORDER, "explore", 0);
const permutations = ids => ids.length ? ids.flatMap((id, i) => permutations(ids.filter((_, j) => i !== j)).map(rest => [id, ...rest])) : [[]];

function fixture(options = {}) {
  const snapshot = state(), calls = [], actions = [];
  let finishStep = null;
  const engine = {
    snapshot: () => structuredClone(snapshot), probe,
    pause() {
      snapshot.paused = true; snapshot.controlSession++; snapshot.remaining = 0; snapshot.actionTicksLeft = 0;
      if (finishStep) { const done = finishStep; finishStep = null; done(engine.snapshot()); }
    },
    startAuto() { snapshot.paused = false; return ++snapshot.controlSession; },
    applyLive(params) { actions.push(params); snapshot.actionSerial++; snapshot.actionTicks = 0; snapshot.actionTicksLeft = params.ticks; return true; },
    act(params) { actions.push(params); snapshot.paused = false; snapshot.remaining = params.ticks; return new Promise(resolve => { finishStep = resolve; }); },
  };
  const model = { info: { backend: "priority-regression" }, decideMany(requests) { return new Promise((resolve, reject) => calls.push({ requests, resolve, reject })); } };
  const agent = new Agent({ engine, getModel: () => model, ...options });
  const answer = () => { const call = calls.at(-1), response = replies(call.requests); call.resolve(response); return response; };
  return { agent, engine, model, state: snapshot, calls, actions, answer };
}

test("the shared catalog, default order, and captured objective text are immutable", () => {
  assert.equal(PRIMARY_OBJECTIVE, "SURVIVE");
  assert.deepEqual(DEFAULT_PRIORITY_ORDER, ["avoid-harm", "get-supplies", "handle-threats", "explore"]);
  assert.equal(new Set(PRIORITIES.map(p => p.id)).size, 4);
  assert.deepEqual(SURVIVAL_OBJECTIVES, objectivesFor());
  assert.equal(GOAL_PROMPT, goalPrompt());
  assert.ok(Object.isFrozen(PRIORITIES) && PRIORITIES.every(Object.isFrozen));
  assert.ok(Object.isFrozen(DEFAULT_PRIORITY_ORDER) && Object.isFrozen(SURVIVAL_OBJECTIVES));
  const input = [...exploreFirst], captured = validatePriorityOrder(input);
  input.reverse();
  assert.deepEqual(captured, exploreFirst);
  assert.ok(Object.isFrozen(captured));
  assert.throws(() => captured.reverse(), TypeError);
  assert.throws(() => { PRIORITIES[0].prompt = "Override"; }, TypeError);
});

for (const [label, invalid] of [
  ["missing", undefined], ["null", null], ["string", "avoid-harm"], ["empty", []], ["short", DEFAULT_PRIORITY_ORDER.slice(1)],
  ["extra", [...DEFAULT_PRIORITY_ORDER, "explore"]], ["duplicate", ["avoid-harm", "get-supplies", "handle-threats", "handle-threats"]],
  ["unknown", ["avoid-harm", "get-supplies", "handle-threats", "<script>unknown</script>"]], ["sparse", new Array(4)],
]) {
  test(`a ${label} priority order fails closed rather than being silently repaired`, () => {
    assert.throws(() => validatePriorityOrder(invalid), /each known priority exactly once/);
    if (invalid === undefined) return; // Omitting an optional setting intentionally uses the default.
    let probes = 0;
    assert.throws(() => prepareDecision(state(), () => { probes++; return {}; }, null, { priorityOrder: invalid }), /each known priority/);
    assert.equal(probes, 0);
    const f = fixture(); f.agent.startLive();
    const before = f.engine.snapshot(), generation = f.agent.generation;
    assert.throws(() => f.agent.setPriorities(invalid), /each known priority/);
    assert.deepEqual(f.engine.snapshot(), before);
    assert.equal(f.agent.generation, generation);
    assert.deepEqual(f.agent.priorityOrder, DEFAULT_PRIORITY_ORDER);
  });
}

test("moves shift intervening priorities without mutating the input or accepting invalid ranks", () => {
  assert.deepEqual(exploreFirst, ["explore", "avoid-harm", "get-supplies", "handle-threats"]);
  assert.deepEqual(movePriority(exploreFirst, "explore", 3), DEFAULT_PRIORITY_ORDER);
  assert.deepEqual(movePriority(exploreFirst, "avoid-harm", 1), exploreFirst);
  for (const index of [-1, 4, 1.5, NaN, "1"]) assert.throws(() => movePriority(exploreFirst, "explore", index), /Invalid priority move/);
  assert.throws(() => movePriority(exploreFirst, "unknown", 0), /Invalid priority move/);
  assert.deepEqual(DEFAULT_PRIORITY_ORDER, ["avoid-harm", "get-supplies", "handle-threats", "explore"]);
});

for (const decisionFormat of ["choice", "noul"]) {
  test(`${decisionFormat} faithfully sends all 24 priority permutations without contradictory fixed rankings`, () => {
    for (const priorityOrder of permutations(DEFAULT_PRIORITY_ORDER)) {
      const record = prepareDecision(state(), probe, null, { decisionFormat, priorityOrder, realtime: true });
      const expected = objectivesFor(priorityOrder), prefix = goalPrompt(priorityOrder);
      assert.deepEqual(record.priorityOrder, priorityOrder);
      assert.deepEqual(record.objectives, expected);
      assert.ok(Object.isFrozen(record.priorityOrder) && Object.isFrozen(record.objectives));
      assert.ok(record.sharedState.startsWith(prefix));
      assert.ok(record.candidates.every(c => c.state.startsWith(prefix)));
      assert.deepEqual(requestsFor(record.eligible, record.sharedState, decisionFormat), record.requests);
      for (const request of record.requests) {
        assert.ok(request.state.startsWith(prefix));
        assert.equal(request.state.match(/SURVIVE/g).length, 1);
        for (const [i, text] of expected.entries()) assert.ok(request.state.includes(`${i + 1}. ${text}`));
        assert.match((request.questions.action || request.questions.favorable).instructions, /listed priorities, highest first/);
        assert.doesNotMatch(JSON.stringify(request), /only after survival needs|[Ee]xploration is secondary|before exploring|Never risk life for novelty/);
      }
    }
  });
}

test("empty views and exploration-loop prose respect the current order too", () => {
  const s = state(); s.enemies = [];
  const text = situation(s, null, { recovery: true }, exploreFirst);
  assert.ok(text.startsWith(goalPrompt(exploreFirst)));
  assert.match(text, /weigh a different route against the listed priorities/);
  assert.doesNotMatch(text, /before exploring|survival first|only after survival needs/);
});

test("changing prompt priorities does not secretly change safety filters, action offers, or their order", () => {
  const restricted = p => ({ ...probe(p), hazard: p.dy < 0 });
  const before = prepareDecision(state(), restricted, null, { realtime: true });
  const after = prepareDecision(state(), restricted, null, { realtime: true, priorityOrder: exploreFirst });
  assert.equal(after.offerPolicy, before.offerPolicy);
  assert.deepEqual(after.eligible.map(c => c.id), before.eligible.map(c => c.id));
  assert.deepEqual(after.candidates.map(({ state, ...facts }) => facts), before.candidates.map(({ state, ...facts }) => facts));
  assert.ok(after.candidates.some(c => !c.allowed && c.filterKind === "geometry"));
  assert.notEqual(after.requests[0].state, before.requests[0].state);
});

test("no-op orders leave live control alone; the controller does not expose a mutable settings array", () => {
  const input = [...exploreFirst], f = fixture({ priorityOrder: input }); input.reverse();
  f.agent.startLive();
  const generation = f.agent.generation, before = f.engine.snapshot();
  assert.equal(f.agent.setPriorities([...exploreFirst]), false);
  assert.equal(f.agent.generation, generation);
  assert.deepEqual(f.engine.snapshot(), before);
  assert.deepEqual(f.agent.priorityOrder, exploreFirst);
  assert.throws(() => f.agent.priorityOrder.reverse(), TypeError);
  assert.throws(() => { f.agent.priorityOrder = DEFAULT_PRIORITY_ORDER; }, TypeError);
});

for (const realtime of [false, true]) {
  test(`reordering discards pending ${realtime ? "live" : "inspection"} replies and preserves their original prompt`, async () => {
    const f = fixture(); if (realtime) f.agent.startLive();
    const pending = f.agent.score({ realtime }), old = f.agent.current;
    const requests = JSON.stringify(old.requests), texts = [...old.objectives];
    assert.equal(f.agent.setPriorities(exploreFirst), true);
    assert.equal(f.agent.current, null);
    assert.equal(f.state.paused, true);
    const response = f.answer();
    assert.equal(await pending, null);
    assert.equal(old.status, "discarded");
    assert.strictEqual(old.responses, response);
    assert.equal(JSON.stringify(old.requests), requests);
    assert.deepEqual(old.priorityOrder, DEFAULT_PRIORITY_ORDER);
    assert.deepEqual(old.objectives, texts);
    assert.equal(f.actions.length, 0);
    const next = f.agent.score(); f.answer(); const record = await next;
    assert.deepEqual(record.priorityOrder, exploreFirst);
    assert.ok(modelState(record).startsWith(goalPrompt(exploreFirst)));
    assert.deepEqual(decisionOutcome(record).priorityOrder, exploreFirst);
    assert.deepEqual(decisionOutcome(old).priorityOrder, DEFAULT_PRIORITY_ORDER);
  });
}

test("even a frozen scored action is invalidated when only its priority order changes", async () => {
  const f = fixture(), pending = f.agent.score(); f.answer(); const record = await pending;
  const tick = f.state.tick;
  f.agent.setPriorities(exploreFirst);
  assert.equal(f.state.tick, tick);
  assert.equal(record.status, "cancelled");
  await assert.rejects(f.agent.step(), /Score the current/);
  assert.equal(f.actions.length, 0);
});

test("reordering stops a held live action and retains its historical priorities", async () => {
  const f = fixture(); f.agent.startLive();
  const pending = f.agent.score({ realtime: true }); f.answer(); const record = await pending;
  assert.equal(f.agent.applyLive(), true);
  f.state.tick += 3; f.state.actionTicks = 3; f.state.actionTicksLeft -= 3;
  f.agent.setPriorities(exploreFirst);
  assert.equal(f.state.paused, true);
  assert.equal(f.state.actionTicksLeft, 0);
  assert.equal(f.agent.active, null);
  assert.equal(f.agent.liveSession, null);
  assert.equal(record.status, "interrupted");
  assert.equal(record.execution.ticksApplied, 3);
  assert.deepEqual(record.priorityOrder, DEFAULT_PRIORITY_ORDER);
  assert.deepEqual(f.agent.priorityOrder, exploreFirst);
});

test("a pending UI Step cannot execute its old prompt after priorities change", async () => {
  const f = fixture(), stepper = new Stepper(f.agent);
  const pending = stepper.step(), record = f.agent.current;
  stepper.cancel(); f.agent.setPriorities(exploreFirst);
  f.answer(); assert.equal(await pending, null);
  assert.equal(record.status, "discarded");
  assert.equal(f.actions.length, 0);
  assert.equal(stepper.busy, false);
});

test("a priority change interrupts an executing Step rather than restarting it with new priorities", async () => {
  const f = fixture(), stepper = new Stepper(f.agent);
  const pending = stepper.step(); f.answer();
  await Promise.resolve(); await Promise.resolve();
  const record = f.agent.current;
  assert.equal(f.actions.length, 1);
  f.state.tick++; f.state.actionTicks = 1;
  stepper.cancel(); f.agent.setPriorities(exploreFirst);
  await pending;
  assert.equal(record.status, "interrupted");
  assert.equal(record.after.tick - record.before.tick, 1);
  assert.equal(f.state.paused, true);
  assert.deepEqual(f.agent.priorityOrder, exploreFirst);
});

test("map/model/controller invalidations do not reset the user's priority order", () => {
  const f = fixture({ priorityOrder: exploreFirst });
  f.agent.invalidate(); f.state.epoch++; f.agent.getModel = () => ({ info: { backend: "replacement" } });
  f.agent.invalidate();
  assert.deepEqual(f.agent.priorityOrder, exploreFirst);
});
