import { PRIMARY_OBJECTIVE, DEFAULT_PRIORITY_ORDER, validatePriorityOrder, objectivesFor, goalPrompt } from "./objective.js";
import { ASSISTANCE } from "./assistance.js";

// All inputs are always offered, even facing a wall, over a ledge, with an axe or no ammo.
// These are fixed keyboard/mouse-like primitives, not target-relative macro actions.
export const RAW_INPUTS = Object.freeze([
  { id: "forward", label: "Walk forward", forward: 1 },
  { id: "back", label: "Walk backward", forward: -1 },
  { id: "left", label: "Strafe left", side: -1 },
  { id: "right", label: "Strafe right", side: 1 },
  { id: "turn-left", label: "Turn left", yawRate: 60 },
  { id: "turn-right", label: "Turn right", yawRate: -60 },
  { id: "look-up", label: "Look up", pitchRate: -45 },
  { id: "look-down", label: "Look down", pitchRate: 45 },
  { id: "fire", label: "Fire straight ahead", fire: true },
  { id: "forward-fire", label: "Walk forward and fire", forward: 1, fire: true },
  { id: "back-fire", label: "Walk backward and fire", forward: -1, fire: true },
  { id: "left-fire", label: "Strafe left and fire", side: -1, fire: true },
  { id: "right-fire", label: "Strafe right and fire", side: 1, fire: true },
  { id: "wait", label: "Release all inputs" },
].map(input => Object.freeze(input)));
export const RAW_OFFER_POLICY = "All 14 fixed relative inputs are offered in a fixed order, without geometry probes, resource/loop filters or tactical ranking. Fire is offered even without a visible target/ammo. Only structural bounds, session/age checks, Stop/focus loss, death, completion and world changes cancel input; ordinary physics/damage still apply.";

const readable = kind => kind === "monster_army" ? "armed grunt" : kind.replace(/^monster_|^weapon_/, "").replaceAll("_", " ");
const known = (value, values) => values.includes(value) ? value : "unknown";
function describe(entity) {
  // Deliberately no fallback to exact positions/bearings/ranges or stable actor IDs.
  return `${readable(entity.kind)} ${known(entity.bearing, ["left", "ahead", "right"])}, ${known(entity.elevation, ["above", "level", "below"])}, ${known(entity.range, ["nearby", "medium range", "far away"])}`;
}
export function unassistedState(observation, memory = null, { realtime = false, heldAction = null, priorityOrder = DEFAULT_PRIORITY_ORDER } = {}) {
  if (observation.completed) return "Level complete: the engine confirmed the exit. No further action is required.";
  const p = observation.player;
  const enemies = observation.enemies.filter(e => e.visible === true).slice(0, 3);
  const pickups = observation.pickups.filter(e => e.visible === true).slice(0, 3);
  const text = [
    goalPrompt(priorityOrder),
    "Assistance OFF: HUD + coarse engine-labelled visible objects, not pixels/audio. No geometry, GPS or targeting assistance.",
    `HUD: health ${p.health}, armor ${p.armor}, ${p.weapon}, ammo ${p.ammo}; keys ${[p.silverKey && "silver", p.goldKey && "gold"].filter(Boolean).join("+") || "none"}.`,
    `Enemies: ${enemies.map(describe).join("; ") || "none observed"}; unseen areas are unknown.`,
    ...(pickups.length ? [`Pickups: ${pickups.map(describe).join("; ")}.`] : []),
    "Inputs follow the current view: walk 200 units/s, turn 60 deg/s, look 45 deg/s. Fire straight ahead without tracking. Walls, floor and hazards are unknown; normal collisions/damage apply.",
    `Hold up to ${realtime ? 750 : 200} ms.`,
  ];
  if (memory?.epoch === observation.epoch) text.push(`Last applied input: ${memory.label}; lost ${memory.damage} health, ammo change ${memory.ammoChange}.`);
  if (realtime) text.push(`Live: world continues during scoring. Currently holding: ${heldAction || "neutral input"}.`);
  return text.join("\n");
}

export function prepareUnassisted(observation, memory, options = {}) {
  const priorityOrder = validatePriorityOrder(options.priorityOrder === undefined ? DEFAULT_PRIORITY_ORDER : options.priorityOrder);
  const sharedState = observation.ready && observation.alive && !observation.completed ? unassistedState(observation, memory, { ...options, priorityOrder }) : "";
  const candidates = sharedState ? RAW_INPUTS.map(input => ({
    id: input.id, category: "input", label: input.label, choiceText: `${input.label}.`,
    params: { input: "relative", epoch: observation.epoch, tick: observation.tick,
      forward: input.forward || 0, side: input.side || 0, yawRate: input.yawRate || 0, pitchRate: input.pitchRate || 0,
      fire: input.fire === true, ticks: options.realtime ? 45 : 12 },
    geometry: null, route: null, allowed: true, reason: null, filterKind: null,
    state: `${sharedState}\nCandidate: ${input.label}.`,
  })) : [];
  return { assistance: "unassisted", observationPolicy: ASSISTANCE.unassisted.observationPolicy, controller: ASSISTANCE.unassisted.controller, objective: PRIMARY_OBJECTIVE,
    priorityOrder, objectives: objectivesFor(priorityOrder), offerPolicy: RAW_OFFER_POLICY,
    candidates, eligible: candidates.slice(), navigation: null, steering: null, sharedState };
}
