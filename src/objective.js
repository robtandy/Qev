/** Prompt priorities share stable IDs and exact wording across UI, requests, and traces. */
export const PRIMARY_OBJECTIVE = "SURVIVE";
export const PRIORITIES = Object.freeze([
  { id: "avoid-harm", label: "Avoid harm", prompt: "Avoid damage/hazards; use cover or retreat." },
  { id: "get-supplies", label: "Get supplies", prompt: "Get needed health, armor and ammo without reckless exposure." },
  { id: "handle-threats", label: "Handle threats", prompt: "Fight immediate threats; conserve ammo." },
  { id: "explore", label: "Explore / exit", prompt: "Explore for supplies, routes and the exit." },
].map(priority => Object.freeze(priority)));
export const DEFAULT_PRIORITY_ORDER = Object.freeze(PRIORITIES.map(priority => priority.id));

/** Only permutations of the four known priorities are accepted; never repair/drop entries. */
export function validatePriorityOrder(order) {
  if (!Array.isArray(order) || order.length !== DEFAULT_PRIORITY_ORDER.length ||
      !DEFAULT_PRIORITY_ORDER.every(id => order.includes(id))) throw new Error("Priorities must contain each known priority exactly once.");
  return Object.freeze([...order]);
}

export function objectivesFor(order = DEFAULT_PRIORITY_ORDER) {
  return Object.freeze(validatePriorityOrder(order).map(id => PRIORITIES.find(priority => priority.id === id).prompt));
}

export function goalPrompt(order = DEFAULT_PRIORITY_ORDER) {
  return `Goal: ${PRIMARY_OBJECTIVE}. Priorities (highest first): ${objectivesFor(order).map((goal, i) => `${i + 1}. ${goal}`).join(" ")} Follow this order when priorities compete.`;
}

/** Move to the target rank, shifting other entries rather than swapping or mutating history. */
export function movePriority(order, id, index) {
  const next = [...validatePriorityOrder(order)], from = next.indexOf(id);
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= next.length) throw new Error("Invalid priority move.");
  next.splice(index, 0, ...next.splice(from, 1));
  return Object.freeze(next);
}

// Default snapshots retained for diagnostics/tests; active requests build from their own order.
export const SURVIVAL_OBJECTIVES = objectivesFor();
export const GOAL_PROMPT = goalPrompt();
export const OFFER_POLICY = "Pre-score shortlist (6 live / 8 inspection): retain stationary and retreat/moving fire when valid; offer up to two supplies, prioritizing missing health (especially <=30), current-weapon ammo <=5, and armor <100 over keys. Under visible threat, walking offers favor estimated blocked LOS to the nearest observed enemy, then separation, before route continuity/novelty. These are offer heuristics, not guaranteed cover or pickup upgrades. The model chooses an offered action; no post-score substitution.";
