import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { DEFAULT_DECISION_FORMAT, prepareDecision, requestsFor, rankResponses } from "../src/decisions.js";
import { ExplorationMemory } from "../src/navigation.js";

const state = () => ({ ready: true, alive: true, completed: false, paused: true, map: "test", epoch: 1, tick: 1,
  player: { health: 25, armor: 10, ammo: 12, weapon: "shotgun", silverKey: true, goldKey: false, position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true },
  enemies: [{ slot: 7, generation: 1, kind: "monster_army", position: [100, 0, 24], distance: 100, bearingRight: 0, visible: true }],
  pickups: [{ slot: 8, generation: 1, kind: "gold_key", position: [0, 100, 24], distance: 100, bearingRight: -90, visible: true }],
});
const probe = (p) => ({ blocked: false, supported: true, hazard: false, end: [p.dx * p.ticks * 200 / 60, p.dy * p.ticks * 200 / 60, 24], lineOfSightAtEndpoint: true });
const eligible = [{ id: "a" }, { id: "b" }, { id: "c" }];
const response = (choice = "b", probabilities = { a: 0.4, b: 0.4, c: 0.2 }) => [{ answers: { action: { type: "choice", choice, probabilities } }, raw_probabilities: { action: [0.400001, 0.400002, 0.199997] }, untouched: "<script>not executable</script>" }];

test("choice is one state with a short description for every offered action", () => {
  assert.equal(DEFAULT_DECISION_FORMAT, "choice");
  const s = state(), navigation = new ExplorationMemory(); navigation.observe(s);
  const r = prepareDecision(s, probe, null, { realtime: true, navigation });
  assert.equal(r.decisionFormat, "choice");
  assert.equal(r.requests.length, 1);
  const input = r.requests[0];
  assert.equal(input.questions.action.type, "choice");
  assert.equal(input.state.match(/COMPLETE THE LEVEL/g).length, 1);
  assert.match(input.state, /health 25.*armor 10.*ammo 12.*keys silver/);
  assert.match(input.state, /gold key/);
  assert.match(input.state, /new cell/);
  assert.match(input.state, /stationary input/);
  assert.match(input.state, /Geometry is estimated/);
  assert.match(input.state, /enemy LOS/);
  assert.deepEqual(Object.keys(input.questions.action.criteria), r.eligible.map(c => c.id));
  for (const c of r.eligible) {
    assert.equal(input.questions.action.criteria[c.id], c.choiceText);
    assert.ok(c.choiceText.length < 110);
    assert.ok(input.state.includes(`${c.id}: `));
  }
  input.questions.action.criteria[r.eligible[0].id] = "changed";
  assert.notEqual(r.eligible[0].choiceText, "changed", "request metadata must not alias mutable candidate descriptions");
});

test("the noul comparison uses the identical candidate pool, geometry, and observation", () => {
  const s = state(), options = { realtime: true };
  const choice = prepareDecision(s, probe, null, options);
  const noul = prepareDecision(s, probe, null, { ...options, decisionFormat: "noul" });
  assert.deepEqual(choice.candidates, noul.candidates);
  assert.deepEqual(choice.eligible, noul.eligible);
  assert.equal(choice.sharedState, noul.sharedState);
  assert.equal(noul.requests.length, noul.eligible.length);
  assert.ok(noul.requests.every((r, i) => r.questions.favorable.type === "noul" && r.state === noul.eligible[i].state));
  assert.deepEqual(requestsFor(choice.eligible, choice.sharedState, "noul"), noul.requests);
  assert.deepEqual(requestsFor(noul.eligible, noul.sharedState, "choice"), choice.requests);
});

test("the actual SDK choice wins a rounded tie instead of silently choosing the first row", () => {
  const replies = response(), saved = structuredClone(replies);
  const ranking = rankResponses(replies, eligible);
  assert.deepEqual(ranking.map(r => r.index), [1, 0, 2]);
  assert.equal(ranking[0].id, replies[0].answers.action.choice);
  assert.equal(ranking[0].probability, 0.4);
  assert.deepEqual(replies, saved);
});

test("probabilities are mapped by action ID, not the response object's key order", () => {
  const ranked = rankResponses(response("b", { c: 0.1, b: 0.7, a: 0.2 }), eligible);
  assert.deepEqual(ranked.map(r => [r.index, r.probability]), [[1, 0.7], [0, 0.2], [2, 0.1]]);
});

test("legitimate SDK rounding and a single offered action remain valid", () => {
  assert.equal(rankResponses(response("c", { a: 0.33, b: 0.33, c: 0.33 }), eligible)[0].id, "c");
  assert.equal(rankResponses(response("a", { a: 1 }), [{ id: "a" }])[0].probability, 1);
});

for (const value of [undefined, null, "0.4", NaN, Infinity, -0.1, 1.1]) {
  test(`choice rejects invalid public probabilities (${String(value)})`, () => {
    assert.throws(() => rankResponses(response("b", { a: value, b: 0.4, c: 0.2 }), eligible), /Invalid/);
  });
}

for (const [label, replies] of [
  ["unknown action", response("not-offered")],
  ["non-string action", response(1)],
  ["missing probabilities", response("b", null)],
  ["missing action probability", response("b", { a: 0.3, b: 0.7 })],
  ["extra action probability", response("b", { a: 0.1, b: 0.7, c: 0.1, d: 0.1 })],
  ["wrong probability keys", response("b", { a: 0.1, b: 0.7, d: 0.2 })],
  ["non-normalized probabilities", response("b", { a: 0.8, b: 0.9, c: 0.7 })],
  ["choice contradicts probabilities", response("a", { a: 0.1, b: 0.8, c: 0.1 })],
  ["wrong question type", [{ answers: { action: { type: "noul", choice: "b", probabilities: { a: 0.1, b: 0.8, c: 0.1 } } } }]],
  ["unexpected response count", [...response(), ...response()]],
  ["noul cannot masquerade as a choice", [{ answers: { favorable: { noul: 0.9 } } }]],
]) {
  test(`choice rejects ${label} without a fallback action`, () => {
    assert.throws(() => rankResponses(replies, eligible), /Invalid|response count/);
  });
}

test("unknown formats fail and a controller's response protocol cannot change mid-flight", () => {
  assert.throws(() => prepareDecision(state(), probe, null, { decisionFormat: "guess" }), /Unsupported/);
  assert.throws(() => new Agent({ engine: {}, getModel() {}, decisionFormat: "guess" }), /Unsupported/);
  const a = new Agent({ engine: {}, getModel() {}, decisionFormat: "noul" });
  assert.throws(() => { a.decisionFormat = "choice"; }, TypeError);
  assert.equal(a.decisionFormat, "noul");
});

test("a malformed choice is recorded unchanged but cannot score or execute", async () => {
  const before = state(), bad = response("not-offered"); let actions = 0;
  const a = new Agent({ engine: { pause() {}, snapshot: () => structuredClone(before), probe, act() { actions++; } },
    getModel: () => model });
  const model = { decideMany: async () => bad };
  await assert.rejects(a.score(), /not one of the offered actions/);
  assert.strictEqual(a.current.responses, bad);
  assert.equal(a.current.status, "error");
  assert.equal(a.current.selectedIndex, null);
  await assert.rejects(a.step(), /Score/);
  assert.equal(actions, 0);
});
