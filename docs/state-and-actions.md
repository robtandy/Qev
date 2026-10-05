# State and actions: initial proposal

This document preserves the initial design and broader experiments. A first vertical slice
is now implemented with **SURVIVE** as the primary goal and exploration secondary; see
[the implementation notes](implementation.md) and the repository README for its exact
priorities, current shared-state choice protocol, and remaining limits. The sample encounter and candidate
estimates in `examples/combat-decision.json` are still synthetic, not captured gameplay.

## 1. Where the model belongs

Tetris has a small set of discrete placements whose resulting boards can be calculated
exactly. Quake is continuous, partially observed, and includes moving enemies, projectiles,
triggers, and randomness. We should transfer the **describe candidate consequences, then
classify them** pattern, not pretend we have the same exact look-ahead.

Proposed division of work:

| Code owns | Model owns |
| --- | --- |
| Reading and filtering telemetry | Judging the described tactical trade-offs |
| Relative bearings, distances, collision/support tests | Ranking the feasible candidate actions |
| Compact descriptions of measured facts | Returning probabilities for the supplied questions |
| Bounded target tracking and translating primitives to inputs | No generated commands, coordinates, or explanations |
| Input limits, action expiry, and stale-result rejection | No engine internals or access to unobserved facts |

Bounded aiming is meaningful assistance and must be shown in the UI and held constant
across baselines. It must not silently pick a new target, weapon, or tactical goal for the
model. A model-only discrete aiming/input mode is a possible later comparison, not the
recommended first demo.

## 2. Keep three representations separate

1. **Raw snapshot:** typed numbers and IDs for the adapter, controller, diagnostics, and
   reproducible traces. Do not dump the whole engine state into the prompt.
2. **Allowed observation:** a visibility-limited subset plus a bounded memory of prior
   observations. This is the only source for candidate descriptions and model input.
3. **Model request:** a short natural-language situation and one candidate's measured or
   estimated consequences, plus the same typed question for every candidate.

Record the actual final request object, not a reconstruction made after the action.
Raw private engine facts that the observation policy excludes must not leak back through
candidate generation, target selection, outcome estimates, or prose.

### Observation fields

| Group | Useful information | Important boundary |
| --- | --- | --- |
| Player | Health, armor, owned weapons, selected weapon, ammo by type, power-ups, grounded/water status | Use actual HUD/player data; do not invent a magazine or reload state |
| Threats | Up to a few visible enemies: stable observation ID, recognized kind, relative bearing/range, clear shot, observed motion | Enemy health and internal AI intent are unknown by default |
| Projectiles | Nearby observed projectile direction, velocity, and local intersection estimate | Any impact time is an estimate, not a guaranteed future hit |
| Pickups | A few visible or remembered health/ammo/armor items, relative direction, observed accessibility | No omniscient list of all items in the level |
| Local space | Short directional hull sweeps, nearby floor support, lava/slime/water contents, obstructions | Local geometry probes are disclosed sensor assistance, not human-equivalent vision |
| Objective | Current local goal, known doorway/frontier/exit, required key if previously observed | Do not supply a pre-solved route through an unexplored map |
| Memory | Last action, displacement/progress, recent observed damage, recent sightings, visited local areas | Old sightings have ages; positions do not keep updating through walls |

Use Quake world units internally. Compute relative bearings in code; for example, define
positive bearing as right of the current view and test the convention against engine
vectors. Convert facts to words such as "nearby on the left", "health is low", or "the
move ends beside lava". Keep the raw measurements visible in the inspector.

"No enemies observed" is not "there are no enemies". A clear short sweep is not proof of
a complete route. Unknown fields should stay unknown, not become reassuring false values.

### Visibility policy

Default to **visibility-limited telemetry**, explicitly labelled as such:

- Filter threats and pickups by view frustum and line of sight. A network/PVS entity list
  alone does not establish visibility.
- Base remembered facts only on earlier permitted observations, with game-time timestamps.
- Do not expose server-side enemy health, `enemy`/`goalentity`, hidden triggers, or global
  monster locations. Classifying visible model/animation types is still telemetry assistance.
- Any future omniscient/debug mode must be conspicuously labelled and evaluated separately.

### Memory is supplied, not learned automatically

These model calls are not a persistent conversation or an online training loop. Keep a
small explicit memory in code. "Moved forward twice but made almost no progress" is more
useful than an ever-growing history of frames. Clear or version memory on death, load,
teleport, and map changes as appropriate.

## 3. Actions should be short combinations, not isolated keys

Start with a horizon of **12 fixed 1/60-second simulation ticks (200 ms)**. This is a
proposed Qev clock contract requiring engine work, not an existing Qwasm step API.

Generate a small menu appropriate to the current observation, rather than the entire
Cartesian product of movement, aim, fire, weapons, and jump.

| Primitive | Example | Preconditions / controller limits |
| --- | --- | --- |
| Track and fire | Fire the selected shotgun at visible target A | Ammo available; target still observable; finite turn rate; fire only with a clear shot |
| Strafe and fire | Strafe left/right while tracking target A | Short movement/support probes pass; action expires after its tick budget |
| Backpedal and fire | Increase separation while tracking target A | The tested rear path has support and no known hazard |
| Advance and fire | Reduce distance to a visible target | Local path tested; weapon and target explicitly attached to the candidate |
| Move toward a pickup | Approach the health pack on the left | Observed or explicitly remembered target; only short validated progress, not guaranteed acquisition |
| Move toward cover | Approach a nearby point whose geometry blocks the current threat's line of sight | Cover is relative to observed threats, not a guarantee against all damage |
| Explore or scan | Approach an observed doorway; rotate to inspect the left passage | Bounded heading/distance; do not claim the unexplored passage is safe |
| Jump / change weapon | Jump a verified small obstacle; switch to an owned loaded weapon | Add when supported and tested; one-shot input, not a held/repeated impulse |

A candidate can carry `targetId`, `pickupId`, `weapon`, movement mode, and a tick lease
outside the model request. The returned batch index selects that candidate; the model
never has to invent those parameters. Use episode-scoped IDs with generations so reused
engine entity slots cannot accidentally identify a different target.

Vanilla Quake is not a modern shooter: do not add reload or crouch actions. Pickups and
many doors operate by contact; other switches may require shooting. Do not assume a
generic `use` command works just because a binding is registered in the input code.

### Candidate facts versus predictions

Safe examples to calculate or estimate with a stated method:

- How a short move changes distance to an observed pickup or enemy.
- Whether a swept player hull collides along that local segment.
- Whether the endpoint has floor support or hazardous contents.
- Whether the endpoint retains a shot or blocks a ray from an observed threat.

Do **not** state "kills the grunt", "takes no damage", "collects the pack", or "survives
five seconds" unless actually measured under a valid simulation model. Enemy movement,
weapon spread, triggers, and damage remain uncertain. An endpoint projection must specify
assumptions and must not mutate the live world to test candidates.

A full snapshot/rollback rollout would be a separate project: entity/VM state, clocks,
RNG, input, and side effects must all be isolated. Copying positions alone is not enough.

Filter mechanically invalid actions in code: no ammo, blocked movement, lost target,
unsupported landing, or a known lava path. Show rejected candidates and their reasons in
the inspector. Do not pre-rank all remaining tactics in code and then credit the model.

## 4. Proposed model input

Use the existing Kevala `decideMany` API, as in the Tetris demo:

```js
const questions = {
  favorable: {
    type: "noul",
    instructions: "Is the described short action favorable for the player's immediate situation?",
    criteria: {
      true: "addresses a stated need or threat with limited exposure and useful progress",
      false: "adds avoidable exposure, wastes scarce resources, or makes no useful progress",
    },
  },
};

const requests = candidates.map((candidate) => ({
  state: describe(observation, candidate),
  questions,
}));
const responses = await kevala.decideMany(requests);
```

Each `state` has the same situation briefing followed by that candidate's description and
geometric estimates. `responses[i]` corresponds to `candidates[i]` even after a separately
constructed score table is sorted. The synthetic fixture demonstrates the exact shape.

Initially rank valid candidates by `answers.favorable.noul`, with an explicit, documented
tie rule. Preserve full returned probabilities; if using a model-specific raw field for
ranking, decode its documented option order rather than assuming array positions. The
model's score is **not a calibrated probability of survival or of winning Quake**.

Optional later diagnostic questions can classify exposure or resource improvement. Do
not multiply their probabilities as if independent, or introduce arbitrary weighted sums
without evaluating them. The model does not provide a generated explanation: explanations
in the UI must be labelled as measured facts or code-generated summaries.

### Alternative to benchmark: one `choice` question

A single request can put a brief action-and-consequence description under each entry in a
`choice.criteria` object. It gives a direct comparison among a short list and avoids
repeating the situation in every request, but may be sensitive to ordering or directive
wording. Compare it with candidate-wise `noul` on the same labelled scenarios; do not
assume either plays well before testing.

Start with the candidate-wise version because it matches the existing Tetris experiment.
Questions should classify the described position/trade-off, not ask the model to calculate
angles, infer collision geometry, or output a sequence of keys.

### Input and latency budgets

- Keep the state front-loaded and concise; Laya's documented input budget is 512 tokens.
  Include question/criteria/template overhead in budgeting and measure actual token usage.
- A working starting target is 4–8 candidates with short descriptions, not hundreds of
  entities or the whole map. The target is subject to latency and quality measurements.
- A 200 ms action horizon suggests up to five decisions per game second. It does **not**
  establish that the chosen model/device can sustain five decisions per wall-clock second.
- Benchmark with Qwasm rendering at the same time: WebGL and WebGPU still contend for GPU
  resources. CPU fallback may require pause/step or slow-motion operation.

## 5. Inspection and control loop

Make debugging the first mode, rather than an afterthought:

1. Pause the whole simulation, including enemies and projectiles, at a tick boundary.
2. **Score** captures the observation and exact request batch and runs inference without
   moving anything. Display the untouched response and candidate mapping.
3. **Step action** applies the chosen primitive for its bounded tick count, records what
   actually happened, and pauses again. **Step frame** optionally advances one physics tick.
4. Slow mode inserts wall-clock waits between fixed simulation ticks, rather than feeding
   large or arbitrarily tiny frame deltas into legacy physics.

Expose the observation policy, raw permitted telemetry, model name/backend, exact input,
complete response, selected candidate, controller assistance, rejected candidates,
measured consequences, timing, and token count. Keep each record tied to an episode,
map generation, observation ID, simulation tick, and request ID. Use bounded history with
an export option so users can review prior decisions without unbounded memory growth.

For real-time play:

- Only one inference is in flight; do not create a queue of obsolete observations.
- Revalidate the chosen action's target, visibility, ammo, support, and hazard constraints
  before executing. Allow a measured observation-age budget in game ticks; requiring exact
  tick equality in real time would discard practically every answer.
- Discard answers after death, reset, load, map change, or model switch. Pause cancels any
  queued execution, even if the current inference is allowed to finish for inspection.
- Inputs have a finite simulation-tick lease. Release movement, attack, and pending impulses
  on expiry, disable, error, or human takeover. Never retain a stale attack indefinitely.
- Unknown/invalid results trigger a fresh observation or an explicit no-input fallback.
  Do not let the fallback silently become a complete alternative tactical bot.

## 6. First experiment and success criteria

Recommended first slice: a reproducible local encounter with one visible enemy, a health
pickup, a nearby obstacle/cover point, and a hazard or blocked route. Support human play,
then the same controller driven by model decisions. It should be possible to pause and
understand every proposed and executed action.

Evaluate 50–100 small scenario snapshots before attempting a campaign. Include low health,
low ammo, blocked movement, no visible enemies, a lost target, nearby lava, a tempting but
unreachable pickup, and contradictory/unknown observations. Vary wording and candidate
order to expose brittle prompts.

Compare model decisions with random-valid and simple-rule baselines using identical
observations, aim assistance, candidate generation, action duration, and safety filters.
Measure health lost, kills, useful pickups, local goal progress, stuck time, hazard entries,
inference latency, and stale-result rate. Report game time separately from wall time.
Measure model contribution, not just whether an assisted bot can play.

Fixed-timestep replay and RNG control need explicit validation in the engine. A level name
and a seed alone are not proof of deterministic replay.

## Open choices before implementing the game

- Confirm the first target: a small encounter, or early single-player campaign navigation.
- Confirm bounded automatic aiming versus model-chosen discrete aim adjustments.
- Choose the permitted game assets and the distribution/license strategy.
- Measure candidate-wise `noul` versus a single `choice` request, on both Laya and Kev.
