import assert from "node:assert/strict";
import test from "node:test";
import { ExplorationMemory, MAX_CELLS } from "../src/navigation.js";
import { Agent } from "../src/agent.js";
import { candidates, prepareDecision, situation } from "../src/decisions.js";

const state = () => ({ map: "lq_e0m1", epoch: 1, tick: 1, ready: true, alive: true, completed: false, paused: true,
  player: { health: 100, armor: 0, ammo: 25, weapon: "shotgun", position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true, silverKey: false, goldKey: false }, enemies: [], pickups: [] });
const probe = (p) => ({ blocked: false, supported: true, hazard: false, end: [p.dx * p.ticks * 200 / 60, p.dy * p.ticks * 200 / 60, 24], lineOfSightAtEndpoint: p.slot > 0 ? true : null });
const scan = { id: "scan-left", category: "scan", params: { dx: 0, dy: 0 }, geometry: { end: [0, 0, 24] }, label: "Look left" };
function scans(nav, s, count) {
  for (let i = 0; i < count; i++) {
    const started = nav.summary(s), after = structuredClone(s); after.tick += 30;
    nav.outcome(scan, s, after, started, 30); Object.assign(s, after);
  }
}

test("empty rooms and defeated enemies are not level completion", () => {
  const s = state(), nav = new ExplorationMemory(); nav.observe(s);
  const result = prepareDecision(s, probe, null, { navigation: nav });
  assert.equal(nav.summary(s).goalComplete, false);
  for (const r of result.requests) {
    assert.match(r.state, /COMPLETE THE LEVEL/);
    assert.match(r.state, /Kills or an empty room are NOT completion/);
    assert.equal(r.questions.action.type, "choice");
    assert.match(r.questions.action.instructions, /find and reach the level exit/);
  }
  s.completed = true; s.epoch++;
  nav.observe(s);
  assert.equal(nav.summary(s).goalComplete, true);
  assert.match(situation(s), /engine confirmed the exit/);
  assert.equal(candidates(s, probe).length, 0);
});

test("only measured cell entries count; re-reading a frozen observation does not inflate visits", () => {
  const s = state(), nav = new ExplorationMemory();
  for (let i = 0; i < 10; i++) nav.observe(s);
  assert.equal(nav.summary(s).rememberedCells, 1);
  assert.equal(nav.summary(s).currentCellEntries, 1);
  s.player.position[0] = 80; s.tick++; nav.observe(s);
  s.player.position[0] = 0; s.tick++; nav.observe(s);
  assert.equal(nav.summary(s).rememberedCells, 2);
  assert.equal(nav.summary(s).currentCellEntries, 2);
  assert.equal(nav.summary(s).distanceMoved, 160);
});

test("reacquiring the same visible actor does not fake an exploration discovery", () => {
  const s = state(), nav = new ExplorationMemory();
  const enemy = { slot: 5, generation: 1, kind: "monster_army", visible: true };
  s.enemies = [enemy]; nav.observe(s);
  s.enemies = []; s.tick++; nav.observe(s);
  s.enemies = [enemy]; s.tick++; nav.observe(s);
  assert.equal(nav.summary(s).newContacts, 1);
  s.enemies.push({ slot: 6, generation: 1, visible: false }); nav.observe(s);
  assert.equal(nav.summary(s).newContacts, 1);
  s.enemies[0].generation++; nav.observe(s);
  assert.equal(nav.summary(s).newContacts, 2);
});

test("unproductive scan loops are explicitly filtered when a walkable alternative exists", () => {
  const s = state(), nav = new ExplorationMemory(); nav.observe(s); scans(nav, s, 2);
  assert.equal(nav.summary(s).recovery, true);
  const result = prepareDecision(s, probe, null, { navigation: nav });
  assert.ok(result.candidates.filter((c) => c.category === "scan").every((c) => !c.allowed && c.filterKind === "loop"));
  assert.ok(result.eligible.some((c) => c.category === "exploration"));
  assert.ok(result.eligible.every((c) => c.category !== "scan"));
  assert.match(result.requests[0].state, /Loop detected/);
  const blocked = prepareDecision(s, (p) => ({ ...probe(p), blocked: !!(p.dx || p.dy) }), null, { navigation: nav });
  assert.ok(blocked.eligible.length > 0);
  assert.ok(blocked.eligible.every((c) => c.category === "scan"), "do not force unsafe walking when all routes are blocked");
});

test("fully inspected blocked terrain waits and rechecks, with occasional scans instead of endless spinning", () => {
  const s = state(), nav = new ExplorationMemory();
  for(let i=0;i<8;i++){s.player.yaw=i*45; nav.observe(s);}
  scans(nav,s,6);
  const blocked=(p)=>({...probe(p),blocked:!!(p.dx||p.dy)});
  let result=prepareDecision(s,blocked,null,{navigation:nav});
  assert.ok(result.eligible.some(c=>c.id==='wait-route'));
  assert.ok(result.eligible.every(c=>c.category!=='scan'));
  s.tick+=120; nav.observe(s);
  result=prepareDecision(s,blocked,null,{navigation:nav});
  assert.ok(result.eligible.some(c=>c.category==='scan'), 'look again when time/obstacles may have changed');
});

test("failed movement routes cool down temporarily without inventing geometry or changing model scores", () => {
  const s = state(), nav = new ExplorationMemory(); nav.observe(s);
  const walk = { id: "forward", category: "exploration", params: { dx: 1, dy: 0 }, geometry: { end: [40, 0, 24] }, label: "Walk forward" };
  for (let i = 0; i < 2; i++) {
    const started = nav.summary(s), after = { ...s, tick: s.tick + 12 };
    nav.outcome(walk, s, after, started, 12); s.tick = after.tick;
  }
  const result = prepareDecision(s, probe, null, { navigation: nav });
  const forward = result.candidates.find((c) => c.id === "forward");
  assert.equal(forward.geometry.blocked, false);
  assert.equal(forward.allowed, false);
  assert.equal(forward.filterKind, "loop");
  scans(nav, s, 6);
  assert.equal(nav.route(s.player.position, [40, 0, 24], 1, 0).coolingDown, false);
});

test("adaptive movement keeps a short safe step when a longer lease hits a wall", () => {
  const s = state(), calls = [];
  const result = candidates(s, (p) => { calls.push(p.ticks); return { ...probe(p), blocked: p.ticks > 12 && !!(p.dx || p.dy) }; }, null, { realtime: true });
  const forward = result.find((c) => c.id === "forward");
  assert.equal(forward.allowed, true);
  assert.equal(forward.params.ticks, 12);
  assert.match(forward.state, /Shorter step/);
  assert.ok(calls.includes(45) && calls.includes(24) && calls.includes(12));
});

test("movement includes backtracking and diagonals even while a threat is visible", () => {
  const s = state();
  s.enemies = [{ slot: 5, generation: 1, kind: "monster_army", visible: true, position: [80, 0, 24], bearingRight: 0, distance: 80 }];
  const result = prepareDecision(s, probe);
  for (const id of ["forward", "forward-left", "forward-right", "back", "back-left", "back-right"]) assert.ok(result.candidates.some((c) => c.id === id));
  assert.ok(result.eligible.some((c) => c.category === "combat"));
  assert.ok(result.eligible.some((c) => c.category === "exploration"));
  assert.ok(result.eligible.length <= 8);
  assert.equal(result.candidates.find((c) => c.id === "left").params.yaw, 90);
});

test("full health and already-owned keys are not pursued as useful pickups", () => {
  const s = state(); s.player.silverKey = true;
  s.pickups = ["health", "silver_key", "gold_key"].map((kind, i) => ({ kind, slot: 7 + i, generation: 0, visible: true, position: [40, 0, 24], bearingRight: 0, distance: 40 }));
  const result = prepareDecision(s, probe);
  assert.equal(result.candidates.find((c) => c.id === "pickup-7").filterKind, "objective");
  assert.equal(result.candidates.find((c) => c.id === "pickup-8").allowed, false);
  assert.equal(result.candidates.find((c) => c.id === "pickup-9").allowed, true);
  assert.match(situation(s), /Keys: silver/);
});

test("megahealth is distinguished from a normal full-health pickup", () => {
  const s = state();
  s.pickups = [{ kind: "mega_health", slot: 7, generation: 0, visible: true, position: [40, 0, 24], bearingRight: 0, distance: 40 }];
  assert.equal(candidates(s, probe).find((c) => c.id === 'pickup-7').allowed, true);
  s.player.health = 250;
  assert.equal(candidates(s, probe).find((c) => c.id === 'pickup-7').allowed, false);
});

test("real-time candidate budgeting retains both combat and exploration within its latency budget", () => {
  const s = state(); s.player.health = 40;
  s.enemies = [{ slot: 5, generation: 1, kind: "monster_army", visible: true, position: [80, 0, 24], bearingRight: 0, distance: 80 }];
  s.pickups = [{ kind: "health", slot: 7, generation: 0, visible: true, position: [40, 0, 24], bearingRight: 0, distance: 40 }];
  const result = prepareDecision(s, probe, null, { realtime: true });
  assert.ok(result.eligible.length <= 6);
  assert.ok(result.eligible.filter(c=>c.category === 'exploration').length >= 2);
  assert.ok(result.eligible.some(c=>c.category === 'combat'));
  assert.ok(result.eligible.some(c=>c.category === 'pickup'));
});

test("local touch-door facts are disclosed and missing-key doors stay filtered", () => {
  const s = state();
  let result = candidates(s, (p) => ({ ...probe(p), contact: "door" }));
  assert.match(result.find((c) => c.id === "forward").state, /touch-operated door/);
  result = candidates(s, (p) => ({ ...probe(p), contact: "door", blocked: true, locked: true, requiredKey: "gold key" }));
  assert.match(result.find((c) => c.id === "forward").reason, /gold key/);
});

test("a continuation waypoint comes only from a selected local route, not a hidden exit", () => {
  const s = state(), nav = new ExplorationMemory(); nav.observe(s);
  assert.equal(nav.goal, null);
  const c = candidates(s, probe, null, { realtime: true }).find((x) => x.id === "forward");
  nav.chosen(c);
  const result = prepareDecision(s, probe, null, { navigation: nav, realtime: true });
  assert.ok(result.eligible.some((c) => c.id === "continue-route"));
  s.hiddenExit = [9999, 9999, 9999]; s.secretMapGraph = "NEVER_SEND_GRAPH";
  assert.doesNotMatch(result.requests.map((r) => r.state).join(" "), /9999|NEVER_SEND_GRAPH/);
  s.player.position = [140, 0, 24]; s.tick++; nav.observe(s);
  assert.equal(nav.goal, null);
});

test("pause/model/controller invalidation preserves exploration, but a new map episode clears it", () => {
  const s = state();
  const engine = { pause() {}, snapshot: () => structuredClone(s) };
  const agent = new Agent({ engine, getModel: () => null });
  agent.observeLive(s);
  s.player.position[0] = 80; s.tick++; agent.observeLive(s);
  agent.invalidate();
  assert.equal(agent.navigation.summary(s).rememberedCells, 2);
  s.epoch++; s.tick = 1; agent.observeLive(s);
  assert.equal(agent.navigation.summary(s).rememberedCells, 1);
  assert.equal(agent.navigation.summary(s).noProgressActions, 0);
});

test("same-level teleport retains visited areas without counting the jump as walked distance", () => {
  const s = state(), nav = new ExplorationMemory(); nav.observe(s);
  s.epoch++; s.tick++; s.stopReason = "Player teleported."; s.player.position = [1000, 0, 24]; nav.observe(s);
  assert.equal(nav.summary(s).rememberedCells, 2);
  assert.equal(nav.summary(s).distanceMoved, 0);
});

test("exploration storage is bounded and does not claim a map-completion percentage", () => {
  const s = state(), nav = new ExplorationMemory();
  for (let i = 0; i < MAX_CELLS + 50; i++) { s.player.position[0] = i * 64; s.tick++; nav.observe(s); }
  assert.equal(nav.summary(s).rememberedCells, MAX_CELLS);
  assert.ok(nav.inspect().recentCells.length <= 32);
  assert.equal(nav.summary(s).goalComplete, false);
});
