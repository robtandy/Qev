import { PRIMARY_OBJECTIVE, DEFAULT_PRIORITY_ORDER, validatePriorityOrder, objectivesFor, goalPrompt, OFFER_POLICY } from "./objective.js";

export const ACTION_TICKS = 12;
export const LIVE_TICKS = 45;
export const MAX_DECISION_AGE_TICKS = 60;
export const MAX_DECISION_AGE_MS = 1500;
export const TICK_HZ = 60;
export const DEFAULT_DECISION_FORMAT = "choice";
export function validateDecisionFormat(format) {
  if (format !== "choice" && format !== "noul") throw new Error(`Unsupported decision format: ${format}`);
  return format;
}
// Retained only as the explicit comparison baseline, never silently substituted for choice.
export const NOUL_BASELINE_QUESTION = {
  favorable: {
    type: "noul",
    instructions: `Does this action help the player ${PRIMARY_OBJECTIVE} according to the listed priorities, highest first?`,
    criteria: {
      true: "advances a higher-priority goal without needlessly sacrificing it for a lower-priority goal",
      false: "ignores higher-priority needs or pursues a lower-priority goal at their expense",
    },
  },
};

export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const wrap = (angle) => ((angle % 360) + 360) % 360;
const bearing = (n) => Math.abs(n) < 15 ? "ahead" : n < 0 ? "to the left" : "to the right";
const range = (n) => n < 128 ? "nearby" : n < 512 ? "at medium range" : "far away";
const readable = (kind) => kind === "monster_army" ? "armed grunt" : kind.replace(/^monster_|^weapon_/, "").replaceAll("_", " ");
const toward = (from, to) => {
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
  return length > 1 ? [dx / length, dy / length] : [0, 0];
};
const heading = (move) => Math.atan2(move[1], move[0]) * 180 / Math.PI;
const moving = (candidate) => Math.hypot(candidate.params.dx, candidate.params.dy) > 0.001;
const safe = (geometry) => !geometry.error && !geometry.blocked && geometry.supported && !geometry.hazard;
const COURSE_CONTEXT = "Walk headings use the held course, not the turning camera; contacts/scans/combat use current view.";
const underPressure = (observation, memory) => observation.enemies.some(e => e.visible === true) ||
  (memory?.epoch === observation.epoch && memory.damage > 0);
const ammoKind = (weapon) => /shotgun/.test(weapon) ? "shells" : /nailgun/.test(weapon) ? "spikes" :
  /launcher/.test(weapon) ? "rockets" : weapon === "lightning" ? "cells" : null;
function supplyPriority(candidate, player) {
  const kind = candidate.pickupKind;
  if ((kind === "health" || kind === "mega_health") && player.health < 100) return player.health <= 30 ? 0 : 1;
  if (kind === ammoKind(player.weapon) && player.ammo <= 5) return player.ammo <= 0 ? 1 : 2;
  if (kind === "armor" && player.armor < 100) return 2;
  if (kind === "mega_health" || kind === "armor" || kind === ammoKind(player.weapon)) return 3;
  return kind === "silver_key" || kind === "gold_key" ? 5 : 4;
}

/** A delayed 'forward' must not steer back toward an old, intermediate camera angle. */
function steeringFrame(observation, { realtime = false, heldCandidate = null } = {}) {
  const p = heldCandidate?.params;
  const heldCourse = realtime && heldCandidate?.category === "exploration" && p?.slot < 0 && p.fire === false &&
    Number.isFinite(p.dx) && Number.isFinite(p.dy) && Math.hypot(p.dx, p.dy) > 0.001;
  return { source: heldCourse ? "held-course" : "view", heading: heldCourse ? wrap(heading([p.dx, p.dy])) : wrap(observation.player.yaw),
    viewHeading: observation.player.yaw, sourceDecisionId: heldCourse ? heldCandidate.decisionId ?? null : null };
}

export function situation(observation, memory = null, exploration = null, priorityOrder = DEFAULT_PRIORITY_ORDER) {
  if (observation.completed) return "Level complete: the engine confirmed the exit. No further action is required.";
  const { player: p } = observation;
  const enemies = observation.enemies.filter((e) => e.visible === true);
  const pickups = observation.pickups.filter((e) => e.visible === true);
  const text = [
    goalPrompt(priorityOrder),
    `Player: ${p.health <= 30 ? "low" : "moderate or high"} health (${p.health}), armor ${p.armor}, ${p.weapon}, ${p.ammo} ammo. Keys: ${[p.silverKey && "silver", p.goldKey && "gold"].filter(Boolean).join(" and ") || "none"}. ${p.grounded ? "Grounded." : "Airborne; gravity and momentum apply."}${p.inWater ? " In water." : ""}`,
    enemies.length ? `Enemies observed: ${enemies.map((e) => `${readable(e.kind)} ${bearing(e.bearingRight)} ${range(e.distance)}`).join("; ")}.` : "No enemies are currently observed; unseen areas are unknown.",
    pickups.length ? `Visible pickups: ${pickups.map((e) => `${readable(e.kind)} ${bearing(e.bearingRight)} ${range(e.distance)}`).join("; ")}.` : "No pickups observed.",
  ];
  if (exploration) {
    text.push(`Exploration memory: ${exploration.rememberedCells} visited grid cells, ${exploration.currentCellEntries} entries into this cell; ${exploration.noProgressActions} actions without new area/contact, ${exploration.stationaryScans} consecutive stationary scans.`);
    if (exploration.recovery) text.push(underPressure(observation, memory) ? "Repeated area/contact observations are not a failure while defending or recovering." : "Loop detected: weigh a different route against the listed priorities.");
  }
  if (memory?.epoch === observation.epoch) {
    text.push(`Last action: ${memory.label}; ${memory.displacement < 5 ? "almost no displacement" : "changed position"}; lost ${memory.damage} health ${memory.realtime ? "in the observed interval after applying it" : "during that action"}.`);
    if (!exploration && memory.scansWithoutNewContacts > 0) text.push(`Scanned ${memory.scansWithoutNewContacts} consecutive times without observing a new enemy or pickup.`);
  }
  return text.join(" ");
}

/** Only observed telemetry and measured local history reach prose; never a hidden exit/map graph. */
export function candidates(observation, probe, memory = null, { realtime = false, heldAction = null, heldCandidate = null, navigation = null, priorityOrder = DEFAULT_PRIORITY_ORDER } = {}) {
  if (!observation.ready || !observation.alive || observation.completed) return [];
  const { player: p } = observation;
  const maxTicks = realtime ? LIVE_TICKS : ACTION_TICKS;
  const theta = p.yaw * Math.PI / 180;
  const forward = [Math.cos(theta), Math.sin(theta)], left = [-Math.sin(theta), Math.cos(theta)];
  const summary = navigation?.summary(observation);
  const steering = steeringFrame(observation, { realtime, heldCandidate });
  const context = situation(observation, memory, summary, priorityOrder) + (steering.source === "held-course" ? ` ${COURSE_CONTEXT}` : "");
  const options = [];
  function add(id, label, move, target = null, fire = false, yaw = p.yaw, category = "combat", ticks = maxTicks) {
    const params = {
      epoch: observation.epoch, tick: observation.tick, dx: move[0], dy: move[1],
      slot: target?.slot ?? -1, generation: target?.generation ?? 0,
      yaw: wrap(yaw), pitch: target ? p.pitch : 0, fire, ticks,
    };
    const isMoving = Math.hypot(...move) > 0.001;
    let geometry = probe(params);
    const initialTicks = ticks;
    // A long horizon hitting a distant wall must not remove a useful short approach/turn.
    if (isMoving && !geometry.error && !safe(geometry)) {
      for (const shorter of [24, 12, 6].filter((n) => n < initialTicks)) {
        params.ticks = shorter; geometry = probe(params);
        if (safe(geometry) || geometry.error) break;
      }
    }
    let reason = geometry.error || (isMoving ? (geometry.locked ? `Door requires ${geometry.requiredKey || "a missing key"}.` : geometry.blocked ? "Local swept hull is blocked." : !geometry.supported ? "Floor support is not established." : geometry.hazard ? "The tested route reaches a known hazard." : null) : null);
    let filterKind = reason ? "geometry" : null;
    if (fire && (p.ammo <= 0 || p.weapon === "axe")) { reason = "No supported ranged weapon with ammunition."; filterKind = "ammo"; }
    if (category === "pickup" && ((target.kind === "health" && p.health >= 100) || (target.kind === "mega_health" && p.health >= 250) || (target.kind === "silver_key" && p.silverKey) || (target.kind === "gold_key" && p.goldKey))) {
      reason = "This resource is already full or owned; approaching it adds no needed resource."; filterKind = "objective";
    }
    const route = isMoving && geometry.end && navigation ? navigation.route(p.position, geometry.end, ...move) : null;
    if (!reason && route?.coolingDown) { reason = "Loop guard: this route repeatedly produced no movement; try another direction temporarily."; filterKind = "loop"; }
    const facts = [];
    if (!isMoving) facts.push("No movement requested; gravity and momentum still apply.");
    else if (!reason) {
      facts.push(geometry.contact ? `Local probe reaches a touch-operated ${geometry.contact}; contact may open it, not guaranteed.` : "Tested walking route is clear, supported, and avoids detected lava/slime.");
      if (params.ticks < initialTicks) facts.push("Shorter step near an obstacle/edge; farther travel is not validated.");
    }
    if (route) facts.push(!route.destinationVisited ? "Endpoint is in a not-yet-visited grid cell; a possible exploration route, not a known exit." : route.sameCell ? "Endpoint stays in the current visited cell." : `Endpoint returns to a cell entered ${route.visits} times; revisiting may help retreat, cover or supplies.`);
    if (id === "continue-route") facts.push("Keeps the model-selected exploration direction while walkable; may pass the previous local waypoint. No scripted map route.");
    const headingInspected = category === "scan" && !!navigation?.inspected(p.position, yaw);
    if (category === "scan") facts.push(headingInspected ? "This heading was already inspected from this area; another turn reveals no guaranteed new information." : "This turn may reveal a threat, supply or route without committing to movement; it does not establish safety.");
    const threat = observation.enemies.find((e) => e.visible === true);
    if (threat) {
      const exposure = target === threat ? geometry : probe({ ...params, slot: threat.slot, generation: threat.generation });
      const separationDelta = geometry.end && threat.position ? distance(geometry.end, threat.position) - distance(p.position, threat.position) : null;
      geometry.threatExposure = { slot: threat.slot, generation: threat.generation, lineOfSightAtEndpoint: exposure.lineOfSightAtEndpoint, separationDelta };
      if (separationDelta > 5) facts.push("Endpoint is farther from the observed enemy's current position; escape is not guaranteed.");
      if (separationDelta < -5) facts.push("Endpoint is closer to the observed enemy's current position.");
      if (exposure.lineOfSightAtEndpoint !== null) facts.push(exposure.lineOfSightAtEndpoint ? "Endpoint remains exposed to the observed enemy." : "Endpoint blocks the observed enemy's current line of sight.");
      facts.push(fire ? "Tracks and fires when aim/line of fire permit; hits are not guaranteed." : "Does not fire at the observed enemy.");
    }
    const health = observation.pickups.find((item) => item.visible === true && item.kind === "health");
    if (health && geometry.end && p.health < 100) {
      const change = distance(geometry.end, health.position) - distance(p.position, health.position);
      facts.push(change < -5 ? "Closer to visible health; collection is not guaranteed." : change > 5 ? "Farther from visible health." : "Little progress toward visible health.");
    }
    const live = realtime ? ` Real-time: the world continues during scoring.${heldAction ? ` Currently holding: ${heldAction}.` : ""} Revalidate on arrival; replace sooner if needed.` : "";
    const state = `${context}${live} Candidate: ${label} for ${realtime ? "up to " : ""}${Math.round(params.ticks * 1000 / TICK_HZ)} ms. ${facts.join(" ")} Geometry is an estimate, not a rollout; future enemy movement, hits, and damage are unknown.`;
    // Short option descriptions avoid exhausting Laya's separate 192-token question head.
    let choiceText = label;
    if (category === "exploration") choiceText = id === "continue-route" ? "Continue the selected walking direction." : `Walk ${id.replaceAll("-", " ")}; face that direction.`;
    if (category === "scan") choiceText = `Look ${id === "scan-left" ? "left" : "right"} without walking.`;
    if (category === "wait") choiceText = "Wait and recheck blocked walking routes.";
    if (category === "pickup") choiceText = `Approach ${readable(target.kind)} ${bearing(target.bearingRight)}; no fire.`;
    if (fire) choiceText = `Fire at ${readable(target.kind)} ${bearing(target.bearingRight)}; ${isMoving ? `move ${id.replace("-fire", "")}` : "stand still"}.`;
    const candidate = { id, category, label, choiceText, headingInspected, params, geometry, route, pickupKind: category === "pickup" ? target.kind : null, allowed: !reason, reason, filterKind, state };
    options.push(candidate); return candidate;
  }
  const enemies = observation.enemies.filter((e) => e.visible === true).slice(0, 3);
  for (const e of enemies) add(`fire-${e.slot}`, `Track and fire at ${readable(e.kind)} ${bearing(e.bearingRight)}, without moving`, [0, 0], e, true);
  if (enemies.length) {
    const target = enemies[0];
    add("left-fire", "Strafe left while tracking and firing at the nearest visible enemy", left, target, true);
    add("right-fire", "Strafe right while tracking and firing at the nearest visible enemy", left.map((n) => -n), target, true);
    add("back-fire", "Backpedal while tracking and firing at the nearest visible enemy", forward.map((n) => -n), target, true);
  }
  for (const item of observation.pickups.filter((e) => e.visible === true).slice(0, 3)) add(`pickup-${item.slot}`, `Approach the visible ${readable(item.kind)} without firing`, toward(p.position, item.position), item, false, p.yaw, "pickup");
  if (navigation?.goal) {
    const move = toward(p.position, navigation.goal.position);
    const remaining = Math.hypot(navigation.goal.position[0] - p.position[0], navigation.goal.position[1] - p.position[1]);
    if (remaining > 24) add("continue-route", "Continue along the chosen exploration direction", move, null, false, heading(move), "exploration");
  }
  // Walking choices remain available during combat: killing every monster is not the goal.
  for (const [id, label, degrees] of [["forward", "forward", 0], ["forward-left", "forward-left", 45], ["forward-right", "forward-right", -45], ["left", "left", 90], ["right", "right", -90], ["back", "back to inspect another route", 180], ["back-left", "back-left", 135], ["back-right", "back-right", -135]]) {
    const yaw = steering.heading + degrees, radians = yaw * Math.PI / 180;
    const move = [Math.cos(radians), Math.sin(radians)].map((n) => Math.abs(n) < 1e-10 ? 0 : n);
    const description = steering.source === "held-course" ? `Walk ${id} relative to the held course` : `Walk ${label} and look along that route`;
    add(id, description, move, null, false, yaw, "exploration");
  }
  add("scan-left", "Turn left to inspect another heading without walking", [0, 0], null, false, p.yaw + (realtime ? 90 : 36), "scan");
  add("scan-right", "Turn right to inspect another heading without walking", [0, 0], null, false, p.yaw - (realtime ? 90 : 36), "scan");
  const hasWalkingRoute = options.some((c) => c.allowed && moving(c));
  if (!hasWalkingRoute && p.grounded && summary?.inspectedHeadings === 8 && summary.noProgressActions >= 6 && observation.tick - summary.lastScanTick < 120) {
    for (const c of options.filter((c) => c.category === "scan")) {
      c.allowed = false; c.filterKind = "loop";
      c.reason = "Blocked-route guard: all headings inspected; wait/recheck instead of continuously spinning.";
    }
    add("wait-route", "Wait briefly and recheck the blocked route; no safe walk is known", [0, 0], null, false, p.yaw, "wait");
  }
  if (summary?.recovery && hasWalkingRoute && !underPressure(observation, memory)) {
    for (const c of options.filter((c) => c.category === "scan")) {
      c.allowed = false; c.filterKind = "loop";
      c.reason = "Loop guard: repeated stationary scans with no observed threat or recent damage; recheck a walkable route.";
    }
  }
  // Never leave no choices solely because of historical cooldowns; current geometry still wins.
  if (!options.some((c) => c.allowed)) for (const c of options.filter((c) => c.category === "scan")) { c.allowed = true; c.reason = null; c.filterKind = null; }
  return options;
}

export function prepareDecision(observation, probe, memory, options = {}) {
  const decisionFormat = validateDecisionFormat(options.decisionFormat ?? DEFAULT_DECISION_FORMAT);
  const priorityOrder = validatePriorityOrder(options.priorityOrder === undefined ? DEFAULT_PRIORITY_ORDER : options.priorityOrder);
  const decisionOptions = { ...options, priorityOrder };
  const all = candidates(observation, probe, memory, decisionOptions);
  const valid = all.filter((c) => c.allowed);
  const combat = valid.filter((c) => c.category === "combat");
  // Keep one stationary firing choice and a defensive moving-fire option, rather than
  // letting several stationary targets hide retreat. This only constructs the offers.
  const defensiveFire = combat.find(c => c.id === "back-fire") || combat.find(moving);
  const combatOffers = [...new Set([...combat.slice(0, 1), ...(defensiveFire ? [defensiveFire] : []), ...combat])];
  const resources = valid.filter((c) => c.category === "pickup").sort((a, b) => supplyPriority(a, observation.player) - supplyPriority(b, observation.player));
  const visibleThreat = observation.enemies.some(e => e.visible === true);
  const routes = valid.filter((c) => c.category === "exploration").sort((a, b) => {
    if (visibleThreat) {
      const exposure = c => c.geometry.threatExposure;
      const cover = Number(exposure(b)?.lineOfSightAtEndpoint === false) - Number(exposure(a)?.lineOfSightAtEndpoint === false);
      const separation = Math.round(exposure(b)?.separationDelta ?? 0) - Math.round(exposure(a)?.separationDelta ?? 0);
      if (cover || separation) return cover || separation;
    }
    return Number(b.id === "continue-route") - Number(a.id === "continue-route") ||
      (a.route?.failures || 0) - (b.route?.failures || 0) || (a.route?.visits || 0) - (b.route?.visits || 0);
  });
  const scans = valid.filter((c) => c.category === "scan" || c.category === "wait");
  // Disclosed candidate budgeting, not score adjustment or a rule-selected replacement action.
  const budget = options.realtime ? 6 : 8;
  const urgentSupplies = resources.filter(c => supplyPriority(c, observation.player) <= 2).length;
  const resourceSlots = visibleThreat ? Math.max(1, Math.min(2, urgentSupplies)) : 2;
  const chosen = [...combatOffers.slice(0, options.realtime ? 2 : 3), ...resources.slice(0, resourceSlots)];
  const scanBudget = Math.min(scans.length, Math.max(0, budget - chosen.length - Math.min(routes.length, 2)));
  chosen.push(...routes.slice(0, Math.max(0, budget - chosen.length - scanBudget)), ...scans.slice(0, scanBudget));
  for (const c of [...routes, ...resources, ...combat]) if (chosen.length < budget && !chosen.includes(c)) chosen.push(c);
  const eligible = chosen.slice(0, budget);
  for (const c of valid) if (!eligible.includes(c)) c.offerNote = "Not offered: survival-first action budget; defensive options and needed supplies take priority over keys and novelty.";
  const navigation = options.navigation?.summary(observation) || null;
  const steering = eligible.length ? steeringFrame(observation, options) : null;
  const sharedState = eligible.length ? choiceState(observation, eligible, memory, navigation, decisionOptions) : "";
  return { objective: PRIMARY_OBJECTIVE, priorityOrder, objectives: objectivesFor(priorityOrder), offerPolicy: OFFER_POLICY,
    candidates: all, eligible, navigation, steering, decisionFormat, sharedState, requests: requestsFor(eligible, sharedState, decisionFormat) };
}

/** One compact, whitelisted observation plus per-action measured facts, not six repeated states. */
function choiceState(observation, eligible, memory, navigation, { realtime = false, heldAction = null, heldCandidate = null, priorityOrder }) {
  const p = observation.player;
  const enemies = observation.enemies.filter((e) => e.visible === true).slice(0, 3);
  const pickups = observation.pickups.filter((e) => e.visible === true).slice(0, 3);
  const describe = (e) => `${readable(e.kind)} ${bearing(e.bearingRight).replace("to the ", "")} ${range(e.distance).replace("at ", "")}`;
  const text = [
    goalPrompt(priorityOrder),
    `Player: health ${p.health}, armor ${p.armor}, ${p.weapon}, ammo ${p.ammo}; keys ${[p.silverKey && "silver", p.goldKey && "gold"].filter(Boolean).join("+") || "none"}; ${p.grounded ? "grounded" : "airborne; gravity applies"}${p.inWater ? "; in water" : ""}.`,
    `Enemies: ${enemies.map(describe).join("; ") || "none observed"}; unseen areas are unknown.`,
    ...(pickups.length ? [`Pickups: ${pickups.map(describe).join("; ")}.`] : []),
  ];
  if (enemies.length) text.push("Enemy estimates use the nearest observed threat.");
  if (navigation) text.push(`Exploration: ${navigation.rememberedCells} cells, ${navigation.currentCellEntries} visits, ${navigation.noProgressActions} no-discovery actions, ${navigation.stationaryScans} stationary scans.${navigation.recovery && !underPressure(observation, memory) ? " Loop detected." : ""}`);
  if (steeringFrame(observation, { realtime, heldCandidate }).source === "held-course") text.push(COURSE_CONTEXT);
  text.push(`Actions up to ${realtime ? 750 : 200} ms; shorter limits below. Geometry is estimated; hits, cover and pickups are not guaranteed.`);
  for (const c of eligible) {
    const facts = c.params.ticks < (realtime ? LIVE_TICKS : ACTION_TICKS) ? [`${Math.round(c.params.ticks * 1000 / TICK_HZ)}ms`] : [];
    if (moving(c)) {
      facts.push(c.geometry.contact ? `touch ${c.geometry.contact}` : "clear floor");
      if (c.route) facts.push(!c.route.destinationVisited ? "new cell" : c.route.sameCell ? "same cell" : `visits ${c.route.visits}`);
      if (c.route?.failures) facts.push(`failed ${c.route.failures}`);
    } else facts.push("stationary input");
    if (c.category === "scan") facts.push(c.headingInspected ? "heading inspected" : "heading not inspected");
    const exposed = c.geometry.threatExposure?.lineOfSightAtEndpoint;
    if (exposed === true) facts.push("LOS clear");
    if (exposed === false) facts.push("LOS blocked");
    if (c.geometry.threatExposure?.separationDelta > 5) facts.push("enemy farther");
    if (c.geometry.threatExposure?.separationDelta < -5) facts.push("enemy closer");
    text.push(`${c.id}: ${facts.join(", ")}.`);
  }
  // Put core objective/state and every action's facts before optional recency/pacing context.
  if (memory?.epoch === observation.epoch) text.push(`Last observed: ${memory.label}; moved ${Math.round(memory.displacement)} units, lost ${memory.damage} health.`);
  if (realtime) text.push(`Live: world continues during scoring. Currently holding: ${heldAction || "neutral input"}. Revalidate before applying.`);
  return text.join("\n");
}

/** Exported for paired evaluation on identical saved observations/actions, without executing them. */
export function requestsFor(eligible, sharedState, decisionFormat = DEFAULT_DECISION_FORMAT) {
  validateDecisionFormat(decisionFormat);
  if (!eligible.length) return [];
  if (decisionFormat === "noul") return eligible.map((c) => ({ state: c.state, questions: structuredClone(NOUL_BASELINE_QUESTION) }));
  return [{ state: sharedState, questions: { action: {
    type: "choice",
    instructions: `Which action best helps you ${PRIMARY_OBJECTIVE}? Follow the listed priorities, highest first.`,
    criteria: Object.fromEntries(eligible.map((c) => [c.id, c.choiceText])),
  } } }];
}

/** Preserve the SDK's actual choice, including ties introduced by rounded public probabilities. */
export function rankResponses(responses, eligible, decisionFormat = DEFAULT_DECISION_FORMAT) {
  validateDecisionFormat(decisionFormat);
  if (!Array.isArray(responses) || responses.length !== (decisionFormat === "choice" ? 1 : eligible.length) || !eligible.length) throw new Error("Model returned an unexpected response count.");
  let selectedId = null, probabilities;
  if (decisionFormat === "choice") {
    const answer = responses[0]?.answers?.action;
    if (answer?.type !== "choice") throw new Error("Invalid action choice: expected a typed choice answer.");
    selectedId = answer.choice;
    if (typeof selectedId !== "string" || !eligible.some((c) => c.id === selectedId)) throw new Error("Invalid action choice: not one of the offered actions.");
    probabilities = answer.probabilities;
    if (!probabilities || Array.isArray(probabilities) || typeof probabilities !== "object" || Object.keys(probabilities).length !== eligible.length || eligible.some((c) => !Object.hasOwn(probabilities, c.id))) throw new Error("Invalid action probabilities: keys must match the offered actions.");
  }
  const ranking = eligible.map((candidate, index) => {
    const probability = decisionFormat === "choice" ? probabilities[candidate.id] : responses[index]?.answers?.favorable?.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Invalid ${decisionFormat} probability for candidate ${index}.`);
    return { index, id: candidate.id, probability };
  });
  if (decisionFormat === "choice") {
    // Kev rounds to 2 decimals and Laya to 4; do not reject a legitimate rounded distribution.
    const sum = ranking.reduce((n, r) => n + r.probability, 0);
    if (Math.abs(sum - 1) > eligible.length * 0.005 + 1e-8) throw new Error("Invalid action probabilities: distribution does not sum to one within rounding tolerance.");
    if (probabilities[selectedId] < Math.max(...ranking.map((r) => r.probability))) throw new Error("Invalid action choice: contradicts the public probabilities.");
  }
  return ranking.sort((a, b) => b.probability - a.probability || Number(b.id === selectedId) - Number(a.id === selectedId) || a.index - b.index);
}
