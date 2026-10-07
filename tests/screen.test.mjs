import assert from "node:assert/strict";
import test from "node:test";
import { SCREEN_SOURCE, ScreenMemory, screenFrame, screenCues, describeScreenEntity } from "../src/screen.js";
import { unassistedState, RAW_INPUTS } from "../src/unassisted.js";
import { prepareDecision } from "../src/decisions.js";
import { Agent } from "../src/agent.js";
import { decisionOutcome } from "../src/decision-cards.js";
import { replies } from "./replies.mjs";

const entity = (scale = 1, overrides = {}) => ({ kind: "monster_army", visible: true,
  screen: { bounds: [0.5 - 0.05 * scale, 0.5 - 0.1 * scale, 0.5 + 0.05 * scale, 0.5 + 0.1 * scale],
    pixels: Math.round(1500 * scale * scale), aimOverlap: true, clipped: false, sameKindCount: 1, ...overrides } });
const observation = (tick = 10, scale = 1) => ({ ready: true, alive: true, assistance: "unassisted", paused: true, completed: false,
  epoch: 1, tick, map: "test", owned: true, controlSession: 1, actionTicksLeft: 0,
  screen: { source: SCREEN_SOURCE, available: true, frame: tick, tick, distorted: false, viewport: [0, 0, 640, 432] },
  player: { health: 100, armor: 0, ammo: 25, weapon: "shotgun" }, enemies: [entity(scale)], pickups: [] });
function sample(scales, change = () => {}) {
  const memory = new ScreenMemory(); let o;
  scales.forEach((s, i) => { o = observation(10 + i * 6, s); change(o, i); memory.observe(o); });
  return { memory, o, cue: memory.describe(o).entities[0] };
}

test("screen descriptions provide position, apparent size and actual center overlap, not metric range", () => {
  const o = observation(), cue = screenCues(o).entities[0];
  assert.match(describeScreenEntity(cue), /armed grunt center\/level \(50,50\), medium h20%, aim on/);
  o.enemies[0].screen.aimOverlap = false;
  assert.match(describeScreenEntity(screenCues(o).entities[0]), /aim off/); // A hole can cover the bbox center.
  const text = unassistedState(o);
  assert.match(text, /renderer-labelled pixels/);
  assert.match(text, /Larger\/growing may mean nearer/);
  assert.match(text, /animation and occlusion confuse depth/);
  assert.doesNotMatch(text, /nearby|medium range|far away|meters|distance [0-9]/);
});

test("screen processing never reads exact telemetry, coarse engine range bins or stable actor IDs", () => {
  const o = observation(), forbidden = () => assert.fail("privileged field read");
  for (const key of ["position", "yaw", "pitch", "grounded", "inWater"]) Object.defineProperty(o.player, key, { get: forbidden });
  for (const key of ["position", "distance", "bearingRight", "bearing", "elevation", "range", "slot", "generation", "health"]) Object.defineProperty(o.enemies[0], key, { get: forbidden });
  const memory = new ScreenMemory(); memory.observe(o);
  assert.ok(Math.abs(memory.describe(o).entities[0].height - 0.2) < 1e-9);
  assert.match(unassistedState(o), /h20%/);
});

test("unavailable, stale or malformed screen frames never fall back to geometry-based target facts", () => {
  for (const edit of [o => delete o.screen, o => o.screen.source = "world-projection", o => o.screen.available = false,
    o => o.screen.tick--, o => o.screen.frame = 0, o => o.screen.viewport[2] = NaN, o => o.screen.viewport[3] = 0,
    o => o.screen.viewport[2] = 1e10, o => o.alive = false]) {
    const o = observation(); edit(o);
    assert.equal(screenFrame(o).available, false);
    assert.match(unassistedState(o), /Screen cues unavailable; targets\/depth unknown/);
  }
  for (const edit of [e => e.screen.bounds = [-1, 0, 1, 1], e => e.screen.bounds = [0.5, 0.5, 0.4, 0.4],
    e => e.screen.bounds[0] = Infinity, e => e.screen.pixels = -1, e => e.screen.pixels = 200000,
    e => e.screen.sameKindCount = 0, e => e.screen.aimOverlap = "yes", e => e.screen.clipped = null,
    e => e.screen.bounds = [0, 0, 0.2, 0.2], e => e.visible = false, e => e.kind = "<script>hidden</script>"]) {
    const o = observation(); edit(o.enemies[0]); assert.equal(screenFrame(o).entities.length, 0);
  }
});

for (const [scales, expected] of [[[1, 1.1, 1.25], "growing"], [[1.25, 1.1, 1], "shrinking"], [[1, 1.01, 1], "steady"], [[1, 1.2, 1.1], "uncertain"]]) {
  test(`three consistent screen samples yield ${expected}, not a physical velocity or certain approach`, () => {
    const { cue } = sample(scales);
    assert.equal(cue.trend, expected); assert.equal(cue.evidence.length, 3);
    assert.equal(cue.evidence.at(-1).tick - cue.evidence[0].tick, 12);
    assert.ok(cue.evidence.every(e => Object.keys(e).sort().join(",") === "bounds,frame,pixels,tick"));
  });
}

for (const [label, change] of [
  ["only two images", null],
  ["edge clipping", o => o.enemies[0].screen.clipped = true],
  ["tiny silhouette", o => { o.enemies[0].screen.pixels = 4; o.enemies[0].screen.bounds = [0.49, 0.49, 0.51, 0.51]; }],
  ["duplicate kind", o => o.enemies[0].screen.sameKindCount = 2],
  ["duplicate rows", o => o.enemies.push(structuredClone(o.enemies[0]))],
  ["water distortion", o => o.screen.distorted = true],
  ["new epoch", (o, i) => o.epoch += i],
  ["changed viewport", (o, i) => o.screen.viewport[0] += i],
  ["image motion", (o, i) => { o.enemies[0].screen.bounds = o.enemies[0].screen.bounds.map((n, j) => j % 2 === 0 ? n + i * 0.1 : n); o.enemies[0].screen.aimOverlap = false; }],
  ["changed silhouette fill", (o, i) => o.enemies[0].screen.pixels = 1500 / (i + 1) ** 2 | 0],
  ["changed aspect/pose", (o, i) => { o.enemies[0].screen.bounds[1] -= i * 0.06; o.enemies[0].screen.bounds[3] += i * 0.06; }],
]) test(`size-change inference is withheld for ${label}`, () => {
  const { cue } = sample(change ? [1, 1.1, 1.25] : [1, 1.25], change || (() => {}));
  assert.equal(cue.trend, "uncertain");
});

test("brief observed loss, stale gaps, backward ticks and unavailable frames reset visual continuity", () => {
  for (const kind of ["lost", "gap", "backwards", "unavailable"]) {
    const { memory } = sample([1, 1.1, 1.25]);
    const middle = observation(kind === "gap" ? 100 : kind === "backwards" ? 1 : 23, 1.3);
    if (kind === "lost") middle.enemies = [];
    if (kind === "unavailable") middle.screen.available = false;
    memory.observe(middle);
    const next = observation(middle.tick + 1, 1.4); memory.observe(next);
    assert.equal(memory.describe(next).entities[0].trend, "uncertain", kind);
  }
});

test("duplicate/polled frames cannot fabricate time or grow visual memory; retention is bounded", () => {
  const memory = new ScreenMemory(), o = observation();
  for (let i = 0; i < 100; i++) memory.observe(o);
  assert.equal(memory.samples.length, 1); assert.equal(memory.describe(o).entities[0].trend, "uncertain");
  for (let i = 1; i <= 200; i++) memory.observe(observation(i + 10));
  assert.ok(memory.samples.length <= 8);
  assert.ok(memory.samples.every(s => 210 - s.tick <= 45));
  memory.reset(); assert.equal(memory.samples.length, 0); assert.equal(memory.latest, null);
});

test("screen cues never shortlist or modify relative actions, including blind and off-center fire", () => {
  let baseline;
  for (const scale of [0.2, 1, 2]) for (const aligned of [false, true]) for (const available of [false, true]) {
    const o = observation(10, scale); o.enemies[0].screen.aimOverlap = aligned; o.screen.available = available;
    const result = prepareDecision(o, () => assert.fail("geometry probe"));
    assert.deepEqual(result.eligible.map(c => c.id), RAW_INPUTS.map(c => c.id));
    assert.ok(result.eligible.every(c => c.allowed && c.geometry === null));
    baseline ||= result.eligible.map(c => c.params);
    assert.deepEqual(result.eligible.map(c => c.params), baseline);
  }
});

test("decision cards retain original screen evidence/state after later images, invalidation and mode changes", async () => {
  let now = observation();
  const engine = { snapshot: () => structuredClone(now), pause() {}, probe() { assert.fail("probe"); } };
  const model = { decideMany: async requests => replies(requests) };
  const agent = new Agent({ engine, getModel: () => model });
  for (const [tick, scale] of [[10, 1], [16, 1.1], [22, 1.25]]) { now = observation(tick, scale); agent.observeObservation(now); }
  const record = await agent.score(), saved = JSON.stringify(record.visual), state = record.requests[0].state;
  assert.equal(record.visual.entities[0].trend, "growing"); assert.match(state, /growing/);
  assert.equal(decisionOutcome(record).screenCues, record.visual);
  now = observation(28, 0.8); agent.observeObservation(now); agent.invalidate();
  assert.equal(JSON.stringify(record.visual), saved); assert.equal(record.requests[0].state, state);
  assert.equal(agent.screenMemory.samples.length, 0);
  assert.equal(agent.navigation.inspect().rememberedCells, 0);
  now = { ...now, assistance: "assisted", player: { ...now.player, position: [0, 0, 24], yaw: 0 }, enemies: [], pickups: [] };
  agent.observeObservation(now);
  now = observation(34, 1.2); agent.observeObservation(now);
  assert.equal(agent.screenMemory.describe(now).entities[0].trend, "uncertain");
  assert.equal(agent.navigation.inspect().rememberedCells, 0);
  assert.equal(JSON.stringify(record.visual), saved); assert.equal(record.requests[0].state, state);
});
