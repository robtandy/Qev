/** Ordered priorities shared by prompts, UI, and trace exports. Survival is ongoing. */
export const PRIMARY_OBJECTIVE = "SURVIVE";
export const SURVIVAL_OBJECTIVES = Object.freeze([
  "Avoid damage/hazards; use cover or retreat.",
  "Get needed health, armor and ammo without reckless exposure.",
  "Fight immediate threats; conserve ammo.",
  "Explore for supplies, routes and the exit only after survival needs.",
]);
export const GOAL_PROMPT = `Goal: ${PRIMARY_OBJECTIVE}. Priorities (highest first): ${SURVIVAL_OBJECTIVES.map((goal, i) => `${i + 1}. ${goal}`).join(" ")} Never risk life for novelty, keys or kills.`;
export const OFFER_POLICY = "Pre-score shortlist (6 live / 8 inspection): retain stationary and retreat/moving fire when valid; offer up to two supplies, prioritizing missing health (especially <=30), current-weapon ammo <=5, and armor <100 over keys. Under visible threat, walking offers favor estimated blocked LOS to the nearest observed enemy, then separation, before route continuity/novelty. These are offer heuristics, not guaranteed cover or pickup upgrades. The model chooses an offered action; no post-score substitution.";
