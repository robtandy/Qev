import assert from "node:assert/strict";
import test from "node:test";
import { prepareDecision } from "../src/decisions.js";

const state = (yaw = 153) => ({ ready: true, alive: true, completed: false, paused: false, epoch: 1, tick: 10,
  player: { health: 100, armor: 0, ammo: 25, weapon: "shotgun", position: [0, 0, 24], yaw, pitch: 0, grounded: true }, enemies: [], pickups: [] });
const probe = (p) => ({ blocked: false, supported: true, hazard: false, end: [p.dx * 150, p.dy * 150, 24], lineOfSightAtEndpoint: null });
const held = (yaw = 180) => ({ id: "forward-left", category: "exploration", label: "A chosen walking course", decisionId: 42,
  params: { dx: Math.cos(yaw * Math.PI / 180), dy: Math.sin(yaw * Math.PI / 180), yaw, pitch: 0, slot: -1, fire: false } });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const action = (prepared, id) => prepared.candidates.find(c => c.id === id);

test("walking uses the accepted course while the camera is still turning", () => {
  const r = prepareDecision(state(), probe, null, { realtime: true, heldCandidate: held() });
  assert.equal(r.steering.source, "held-course");
  assert.equal(r.steering.sourceDecisionId, 42);
  close(r.steering.heading, 180);
  assert.equal(r.steering.viewHeading, 153);
  close(action(r, "forward").params.yaw, 180);
  close(action(r, "forward").params.dx, -1);
  close(action(r, "forward").params.dy, 0);
  close(action(r, "left").params.yaw, 270);
  close(action(r, "right").params.yaw, 90);
  assert.match(action(r, "forward").label, /relative to the held course/);
  assert.match(r.requests[0].state, /not the turning camera/);
});

test("repeated forward choices do not chase alternating delayed camera angles", () => {
  let previous = held(180);
  for (const yaw of [153, 180, 153, 180, 156, 180]) {
    const r = prepareDecision(state(yaw), probe, null, { realtime: true, heldCandidate: previous });
    const forward = action(r, "forward");
    close(forward.params.yaw, 180);
    close(forward.params.dx, -1);
    previous = { ...forward, decisionId: previous.decisionId + 1 };
  }
});

test("course anchoring wraps at north without turning 360 degrees", () => {
  const r = prepareDecision(state(350), probe, null, { realtime: true, heldCandidate: held(1) });
  close(action(r, "forward").params.yaw, 1);
  close(action(r, "forward-left").params.yaw, 46);
  close(action(r, "forward-right").params.yaw, 316);
});

test("looking and combat still use actual view direction, not the travel frame", () => {
  const s = state(0);
  s.enemies = [{ slot: 7, generation: 1, kind: "monster_army", visible: true, position: [100, 0, 24], distance: 100, bearingRight: 0 }];
  const r = prepareDecision(s, probe, null, { realtime: true, heldCandidate: held(90) });
  close(action(r, "forward").params.yaw, 90);
  close(action(r, "scan-left").params.yaw, 90);
  close(action(r, "scan-right").params.yaw, 270);
  close(action(r, "left-fire").params.dx, 0);
  close(action(r, "left-fire").params.dy, 1);
});

for (const [label, options] of [
  ["inspection", { realtime: false, heldCandidate: held() }],
  ["no held command", { realtime: true }],
  ["scanning", { realtime: true, heldCandidate: { ...held(), category: "scan" } }],
  ["combat", { realtime: true, heldCandidate: { ...held(), category: "combat" } }],
  ["a tracked target", { realtime: true, heldCandidate: { ...held(), params: { ...held().params, slot: 7 } } }],
  ["firing", { realtime: true, heldCandidate: { ...held(), params: { ...held().params, fire: true } } }],
  ["neutral input", { realtime: true, heldCandidate: { ...held(), params: { ...held().params, dx: 0, dy: 0 } } }],
  ["invalid vector", { realtime: true, heldCandidate: { ...held(), params: { ...held().params, dx: NaN } } }],
]) {
  test(`${label} does not inherit an exploratory travel heading`, () => {
    const r = prepareDecision(state(), probe, null, options);
    assert.equal(r.steering.source, "view");
    close(action(r, "forward").params.yaw, 153);
    assert.doesNotMatch(r.requests[0].state, /not the turning camera/);
  });
}

test("anchoring cannot bypass geometry or silently replace a blocked course with view-forward", () => {
  const r = prepareDecision(state(0), p => ({ ...probe(p), blocked: p.dx < 0 }), null, { realtime: true, heldCandidate: held(180) });
  const forward = action(r, "forward");
  close(forward.params.dx, -1);
  assert.equal(forward.allowed, false);
  assert.equal(forward.filterKind, "geometry");
  assert.ok(!Object.hasOwn(r.requests[0].questions.action.criteria, "forward"));
});

test("the same changed reference frame is disclosed to the explicit noul baseline", () => {
  const r = prepareDecision(state(), probe, null, { realtime: true, heldCandidate: held(), decisionFormat: "noul" });
  assert.ok(r.requests.every(x => x.state.includes("not the turning camera")));
});
