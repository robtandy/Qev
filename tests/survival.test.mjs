import assert from "node:assert/strict";
import test from "node:test";
import { PRIMARY_OBJECTIVE, SURVIVAL_OBJECTIVES, GOAL_PROMPT } from "../src/objective.js";
import { candidates, prepareDecision, situation, rankResponses } from "../src/decisions.js";
import { replies } from "./replies.mjs";
import { ExplorationMemory } from "../src/navigation.js";

const state = () => ({ ready: true, alive: true, completed: false, paused: true, epoch: 1, tick: 20, map: "test",
  player: { health: 100, armor: 0, ammo: 25, weapon: "shotgun", position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true },
  enemies: [{ kind: "monster_army", slot: 7, generation: 1, visible: true, position: [80, 0, 24], bearingRight: 0, distance: 80 }], pickups: [] });
const probe = p => ({ blocked: false, supported: true, hazard: false,
  end: [p.dx * p.ticks * 200 / 60, p.dy * p.ticks * 200 / 60, 24], lineOfSightAtEndpoint: p.slot > 0 ? true : null });
const pickups = kinds => kinds.map((kind, i) => ({ kind, slot: 20 + i, generation: 1, visible: true, position: [0, 60 + i * 10, 24], bearingRight: -90, distance: 60 + i * 10 }));
const navigation = (recovery = false) => ({ goal: { position: [140, 0, 24], label: "Existing forward waypoint" },
  summary: () => ({ rememberedCells: 6, currentCellEntries: 2, noProgressActions: recovery ? 6 : 0, stationaryScans: recovery ? 3 : 0, recovery }),
  route: (position, endpoint, dx) => ({ destinationVisited: dx < 0, visits: dx < 0 ? 10 : 0, sameCell: false, failures: 0, coolingDown: false }),
  inspected: () => false });

for (const decisionFormat of ["choice", "noul"]) {
  test(`${decisionFormat} uses the same ordered survival objectives, with exploration last`, () => {
    const r = prepareDecision(state(), probe, null, { decisionFormat, realtime: true });
    assert.equal(PRIMARY_OBJECTIVE, "SURVIVE");
    assert.equal(r.objective, PRIMARY_OBJECTIVE);
    assert.deepEqual(r.objectives, SURVIVAL_OBJECTIVES);
    assert.equal(r.objectives.length, 4);
    assert.ok(Object.isFrozen(SURVIVAL_OBJECTIVES));
    assert.match(r.offerPolicy, /Pre-score shortlist/);
    for (const request of r.requests) {
      assert.ok(request.state.startsWith(GOAL_PROMPT));
      assert.equal(request.state.match(/SURVIVE/g).length, 1);
      assert.match(request.state, /Never risk life for novelty, keys or kills/);
      const positions = SURVIVAL_OBJECTIVES.map(goal => request.state.indexOf(goal));
      assert.ok(positions.every((pos, i) => pos >= 0 && (!i || pos > positions[i - 1])));
      const question = request.questions.action || request.questions.favorable;
      assert.match(question.instructions, /SURVIVE/);
      assert.match(question.instructions, /[Ee]xploration.*secondary/);
      assert.doesNotMatch(request.state, /COMPLETE THE LEVEL/);
    }
  });
}

test("an empty view does not claim safety or demand exploring before survival needs", () => {
  const s = state(); s.enemies = [];
  const text = situation(s);
  assert.match(text, /unseen areas are unknown/);
  assert.match(text, /Check for threats and needed supplies before exploring/);
  assert.doesNotMatch(text, /Keep exploring/);
  s.completed = true;
  assert.match(situation(s), /engine confirmed the exit/);
  assert.deepEqual(candidates(s, probe), []);
});

test("low health and missing armor keep both recovery options ahead of a key during combat", () => {
  const s = state(); s.player.health = 20; s.pickups = pickups(["gold_key", "armor", "health"]);
  const r = prepareDecision(s, probe, null, { realtime: true });
  assert.ok(r.eligible.some(c => c.pickupKind === "health"));
  assert.ok(r.eligible.some(c => c.pickupKind === "armor"));
  assert.ok(!r.eligible.some(c => c.pickupKind === "gold_key"));
  const key = r.candidates.find(c => c.pickupKind === "gold_key");
  assert.equal(key.allowed, true, "the key remains physically valid, not falsely called unsafe");
  assert.match(key.offerNote, /survival-first action budget/);
  assert.ok(r.eligible.some(c => c.category === "combat"));
  assert.ok(r.eligible.some(c => c.category === "exploration"));
  assert.ok(r.eligible.length <= 6);
});

for (const [weapon, kind] of [["shotgun", "shells"], ["double shotgun", "shells"], ["super nailgun", "spikes"], ["rocket launcher", "rockets"], ["lightning", "cells"]]) {
  test(`empty ${weapon} prioritizes its observed ${kind} supply over a key`, () => {
    const s = state(); s.player.weapon = weapon; s.player.ammo = 0; s.pickups = pickups(["gold_key", kind]);
    const r = prepareDecision(s, probe, null, { realtime: true });
    assert.ok(r.eligible.some(c => c.pickupKind === kind));
    assert.ok(!r.eligible.some(c => c.pickupKind === "gold_key"));
    assert.ok(r.eligible.every(c => !c.params.fire));
  });
}

test("a validated retreat remains available instead of promoting a novel forward route", () => {
  const r = prepareDecision(state(), probe, null, { realtime: true, navigation: navigation() });
  const retreat = r.eligible.find(c => c.id === "back");
  assert.ok(retreat);
  assert.equal(retreat.route.destinationVisited, true);
  assert.ok(retreat.geometry.threatExposure.separationDelta > 0);
  assert.ok(r.eligible.some(c => c.id === "back-fire"));
  assert.ok(r.eligible.some(c => c.id === "fire-7"));
  assert.match(r.sharedState, /enemy farther/);
});

test("observed LOS-blocking routes take shortlist priority without claiming guaranteed cover", () => {
  const r = prepareDecision(state(), p => ({ ...probe(p), lineOfSightAtEndpoint: p.dy <= 0 }), null, { realtime: true });
  const walks = r.eligible.filter(c => c.category === "exploration");
  assert.ok(walks.length >= 2);
  assert.ok(walks.every(c => c.geometry.threatExposure.lineOfSightAtEndpoint === false));
  assert.match(r.sharedState, /cover.*not guaranteed/);
  assert.match(r.sharedState, /Enemy estimates use the nearest observed threat/);
});

test("compact survival prompts omit repeated maximum durations, but preserve shortened leases", () => {
  const r = prepareDecision(state(), p => ({ ...probe(p), blocked: p.ticks > 24 && (p.dx !== 0 || p.dy !== 0) }), null, { realtime: true });
  assert.match(r.sharedState, /Actions up to 750 ms; shorter limits below/);
  assert.match(r.sharedState, /back: 400ms/);
  assert.doesNotMatch(r.sharedState, /fire-7: 750ms/);
});

test("a tempting healing route is still excluded when its actual probe detects a hazard", () => {
  const s = state(); s.player.health = 5; s.pickups = pickups(["health"]);
  const r = prepareDecision(s, p => ({ ...probe(p), hazard: p.slot === 20 }), null, { realtime: true });
  const healing = r.candidates.find(c => c.pickupKind === "health");
  assert.equal(healing.allowed, false);
  assert.equal(healing.filterKind, "geometry");
  assert.ok(!r.eligible.includes(healing));
  assert.ok(r.eligible.some(c => c.id === "back"));
});

for (const pressure of ["visible threat", "recent damage"]) {
  test(`exploration loop guards do not force movement under ${pressure}`, () => {
    const s = state(), memory = { epoch: 1, label: "Last action", displacement: 0, damage: 12 };
    if (pressure === "recent damage") s.enemies = [];
    const r = prepareDecision(s, probe, pressure === "recent damage" ? memory : null, { realtime: true, navigation: navigation(true) });
    assert.ok(r.candidates.filter(c => c.category === "scan").every(c => c.allowed));
    assert.ok(r.eligible.some(c => c.category === "scan"));
    assert.doesNotMatch(r.sharedState, /Loop detected/);
  });
}

test("damage from a previous episode does not change the current loop filter", () => {
  const s = state(); s.enemies = [];
  const r = prepareDecision(s, probe, { epoch: 0, label: "Old", damage: 30 }, { realtime: true, navigation: navigation(true) });
  assert.ok(r.candidates.filter(c => c.category === "scan").every(c => c.filterKind === "loop"));
});

test("defensive shortlisting never duplicates a lone valid moving-fire candidate", () => {
  const s = state();
  const r = prepareDecision(s, p => ({ ...probe(p), error: p.fire && p.dx >= 0 ? "Test-only blocked firing primitive" : null }), null, { realtime: true });
  const ids = r.eligible.map(c => c.id);
  assert.ok(ids.includes("back-fire"));
  assert.equal(new Set(ids).size, ids.length);
});

test("the model's selected offered action is not changed by the survival priorities", () => {
  const r = prepareDecision(state(), probe, null, { realtime: true });
  const chosen = r.eligible.findIndex(c => c.id === "fire-7");
  const response = replies(r.requests, chosen);
  const untouched = structuredClone(response);
  assert.equal(rankResponses(response, r.eligible)[0].index, chosen);
  assert.deepEqual(response, untouched);
});

test("secondary level completion and waypoint inspection remain distinct from the survival objective", () => {
  const s = state(), memory = new ExplorationMemory();
  memory.observe(s);
  memory.goal = { position: [140, 0, 24], label: "Model-selected route" };
  const summary = memory.summary(s);
  assert.equal(summary.goalComplete, false);
  assert.deepEqual(summary.waypoint, memory.goal);
  assert.notStrictEqual(summary.waypoint.position, memory.goal.position);
  s.completed = true; memory.observe(s);
  assert.equal(memory.summary(s).goalComplete, true);
  assert.equal(memory.summary(s).waypoint, null);
});

test("when there is no observed pressure, ordinary exploration and route continuity remain available", () => {
  const s = state(); s.enemies = [];
  const r = prepareDecision(s, probe, null, { realtime: true, navigation: navigation() });
  assert.ok(r.eligible.some(c => c.id === "continue-route"));
  assert.ok(r.eligible.some(c => c.id === "forward"));
  assert.ok(r.eligible.some(c => c.category === "scan"));
  assert.match(r.sharedState, /Explore.*exit only after survival needs/);
});
