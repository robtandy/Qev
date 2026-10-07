import { PRIMARY_OBJECTIVE, DEFAULT_PRIORITY_ORDER, validatePriorityOrder, objectivesFor, goalPrompt } from "./objective.js";
import { ASSISTANCE } from "./assistance.js";
import { screenCues, describeScreenEntity } from "./screen.js";

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

export function unassistedState(observation, memory = null, { realtime = false, heldAction = null, priorityOrder = DEFAULT_PRIORITY_ORDER, visual = screenCues(observation) } = {}) {
  if (observation.completed) return "Level complete: the engine confirmed the exit. No further action is required.";
  const p = observation.player;
  const enemies = visual.entities.filter(e => e.group === "enemy"), pickups = visual.entities.filter(e => e.group === "pickup");
  const text = [
    goalPrompt(priorityOrder),
    "Assistance OFF: renderer-labelled pixels; no auto-aim.",
    `HUD: health ${p.health}, armor ${p.armor}, ${p.weapon}, ammo ${p.ammo}; keys ${[p.silverKey && "silver", p.goldKey && "gold"].filter(Boolean).join("+") || "none"}.`,
    ...(visual.available ? [
      "Screen (x,y)% from top-left; aim(50,50); h=visible height%.",
      `Enemies: ${enemies.map(describeScreenEntity).join("; ") || "none visible"}.`,
      ...(pickups.length ? [`Pickups: ${pickups.map(describeScreenEntity).join("; ")}.`] : []),
      `Larger/growing may mean nearer; different sizes, animation and occlusion confuse depth.${visual.distorted ? " Warped view: size trends unknown." : ""}`,
    ] : ["Screen cues unavailable; targets/depth unknown."]),
    `Unseen space/hazards unknown. Relative walk/turn/look; max ${realtime ? 750 : 200}ms. Fire without tracking.`,
  ];
  if (realtime) text.push(`Live; holding ${heldAction || "nothing"}.`);
  if (memory?.epoch === observation.epoch) text.push(`Last${realtime && heldAction === memory.label ? "" : `: ${memory.label}`}: health -${memory.damage}, ammo ${memory.ammoChange}.`);
  return text.join("\n");
}

export function prepareUnassisted(observation, memory, options = {}) {
  const priorityOrder = validatePriorityOrder(options.priorityOrder === undefined ? DEFAULT_PRIORITY_ORDER : options.priorityOrder);
  const visual = options.visual || screenCues(observation);
  const sharedState = observation.ready && observation.alive && !observation.completed ? unassistedState(observation, memory, { ...options, priorityOrder, visual }) : "";
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
    candidates, eligible: candidates.slice(), navigation: null, steering: null, visual, sharedState };
}
