# Implemented vertical slice

This document describes the working implementation. `state-and-actions.md` and
`qwasm-integration.md` preserve the initial proposal and source research; their broader
navigation, memory, rollout, and evaluation goals are not all implemented.

## Reproducible source boundary

- Qwasm: `f56b5e71e4be8effede29bae1785a5306dcc0249`.
- Emscripten SDK: 3.1.74, SDK source `3d6d8ee910466516a53e665b86458faa81dae9ba`.
- Kevala: npm `0.1.3`, locked in `package-lock.json`.
- `engine/qwasm.patch` adds narrow hooks to six upstream files. The complete upstream
  source is fetched under ignored `build/qwasm`, never copied into application modules.
- Engine artifacts go under `build/engine`. The build removes resource preloading and
  exports a modularized ES-module engine. It embeds **no PAKs or other game resources**.
- The bridge is compiled without fast-math so its finite-number checks cannot be optimized
  away. A browser regression explicitly checks NaN rejection at the WASM boundary.

## Default asset loading and privacy

`npm run setup:demo` installs the hash-pinned LibreQuake v0.09-beta Lite ZIP, preserves its
notices, and generates a small encounter overlay. The output is ignored under
`build/demo/librequake-v0.09-beta-lite/`; no original Quake game data is included.

Opening `/` automatically retrieves the matching `pak0.pak`, `pak1.pak`, and `pak2.pak`
from the localhost server. The browser verifies exact lengths and SHA-256, validates the
combined PAK set, and starts map 6, **Great Greek Grinder (`lq_e0m6`)**, paused and silent. The selector lists
Episode Zero maps and the hub, plus the explicitly labeled `qev_encounter` regression
arena; brush-model BSPs and development maps are not offered. The model is **not** loaded
until requested. The app is demo-only, with progress, setup errors, and a reload link;
there is no file picker, import mode, or asset-mode query handling.

The only PAK-serving exception is the explicit `/demo/` allowlist in the server. It checks
the complete bundle **and license notice** against constants in `src/demo-manifest.js`,
then retains verified bytes in memory. It never sends a newly reopened/unverified file
or takes a bundle manifest from disk/the client. Missing, modified, or escaping-symlink
assets fail closed. Arbitrary PAKs still cannot be served via the static mounts.

The loader validates the demo's PAK directories and required resources before WASM
startup, including `gfx/pop.lmp` from LibreQuake's `pak1.pak`. Missing data points to
`npm run setup:demo` and a page reload. There is no original-shareware compatibility
branch or file-selection lifecycle to maintain. Fatal legacy `Error:`/`Host_Error:`
output also reaches the UI immediately, not just a generic 30-second timeout. No
registration marker is injected or bypassed.

This is a local development setup, not a public redistribution package; corresponding
The public repository contains source only, including engine license/modification notices
in `engine/README.md` and `engine/COPYING`. Corresponding-source and asset obligations still
need attention before a compiled runtime or game-data release.

## Bridge API

These exports now exist in the Qev build, not in unmodified Qwasm:

| Export | Contract |
| --- | --- |
| `qev_snapshot()` | JSON copy of ready/pause/epoch/tick/action state and permitted player/entity observations |
| `qev_probe(dx, dy, slot, generation, ticks)` | Non-mutating swept-hull/support/hazard probe over the specified 1–45 tick horizon, plus endpoint line of sight to a currently observable target |
| `qev_pause()` | Clear action/input leases, cancel remaining requested ticks, freeze world time |
| `qev_play()` | Return to ordinary keyboard/mouse input and resume simulation |
| `qev_speed(scale)` | Set wall-time pacing in the range 0.05–1; physics tick size is unchanged |
| `qev_action(epoch, tick, dx, dy, slot, generation, yaw, pitch, attack, ticks)` | Validate and execute a numeric, bounded action from the exact paused observation; 1–12 ticks maximum |
| `qev_auto()` | Resume simulation with controller-owned input; return a new control-session token |
| `qev_live_action(epoch, observedTick, session, dx, dy, slot, generation, yaw, pitch, attack, ticks)` | Atomically revalidate and replace an input lease while simulation runs; 1–45 ticks, observation age at most 60 ticks, matching session/epoch |
| `qev_step_frame(epoch, tick)` | Advance one fixed tick with no agent input |
| `qev_new_game(name, difficulty)` | Validate a map name and integer difficulty 0–3; queue skill before spawning the new world, then pause when ready |
| `qev_load_map(name)` | Compatibility entry point preserving the currently active difficulty |

`src/engine.js` converts returned UTF-8 JSON to owned JS objects immediately. No mutable
WASM heap views escape into UI/history. It provides typed calls, map-name validation,
bounded operation waits, and startup error reporting. The new-game export is required at
startup so an older WASM build fails with rebuild guidance, not a mismatched call. Snapshots
report `difficulty` from Quake's `current_skill` (the loaded level's setting), not a pending
UI selection or a cvar that has not yet been applied.

Inputs are normalized world-space directions. The bridge projects them into the current
view's forward/side axes each tick, so target tracking does not silently rotate a requested
strafe into a different world direction. It writes Quake's actual view-angle, movement,
and attack state; it does not fake DOM keyboard events for the agent.

## Observation policy and guards

Only local single-player sessions are supported. Exported entity records are restricted
to recognizable stock monsters/pickups with models, a view-cone check, and line of sight.
At most three of each, nearest first, are returned. Enemy health, QuakeC enemy/goal fields,
and hidden actors are never serialized. Entity slots have generation counters on free,
and map changes reset observation epochs.

Own health/ammo/armor and silver/gold key inventory are permitted HUD facts. Visible key
pickups and megahealth are distinguished from ordinary health. Own position and local
geometry queries are explicitly disclosed telemetry assistance. Corpse filtering uses engine death/solid
state; this is not claimed to be perception from rendered pixels. The formatter also
excludes actors marked unobserved as a defensive check.

For inspection actions the bridge requires an exact epoch/tick and a paused world. For
real-time actions it requires an active controller session, a matching epoch, and an
observation no more than 60 ticks old (never a future tick). Both paths enforce finite
numeric bounds, action duration, current target identity/generation/visibility, ammo, and
a new route probe from the current player position. During execution it checks visibility,
ammo, and local movement each tick. Aim is bounded to 180°/s; attack is only pressed when
aim is close and the shot is clear. It never tracks through walls or silently substitutes
a different target/candidate.

The pause flag describes debug mode; while `remaining > 0`, an explicitly requested step
is in progress. Real-time mode instead has `paused=false`, `owned=true`, and `remaining=0`.
A real-time lease lasts at most 45 ticks and also has a 1.5-second wall-clock watchdog.
Expiry or failed per-tick guards release inputs without stopping real-time simulation.
Death, completion, teleport/map transition, human takeover, and Pause invalidate ownership
or pause the world. A recognized same-level teleport during Auto starts a fresh neutral
control session after discarding the old pending job; it never carries a command across
the jump or overrides a manual Pause. Snapshots include `controlSession`, `actionSerial`, `actionTicks`,
`actionTicksLeft`, and `stopReason`; `actionTicks` counts actual input applications.
Stationary actions may execute while airborne, but their prompts explicitly acknowledge
that gravity/momentum still apply; they do not claim floor support or zero displacement.

## Level selection, layout, and death recovery

The default is `lq_e0m6` on Hard (`skill 2`), in both the engine API and initial selector. Compact top controls offer Easy/Normal/Hard/Nightmare along
with the map. Changing either selector immediately loads a fresh episode with both selected
values and leaves it stopped; there is no separate restart/apply button. Selection stops
continuous control and invalidates outstanding decisions before the engine load. Selectors
are disabled during loading to prevent overlapping map commands. Model downloads remain explicit.

The playback buttons are **Start**, **Stop**, and **Step** only. Start is one-way and disabled
while running or loading a model. The model selector initially says **Choose a decision
model**, with neither Kev nor Laya selected. Load remains disabled until a valid choice;
its handler also rejects an empty/unknown selection instead of falling back to the SDK's
default. Start first prompts to choose a model, focusing the dropdown without downloading.
Once chosen, Start opens an accessible Load model dialog identifying the selection and
size. It starts no download or gameplay on its own. Cancel/Escape leave the world stopped; Load model explicitly
invokes the existing loader, then the user presses Start again. Stop freezes the simulation
without resetting the map. `src/stepper.js` owns
a single-click frozen-score/bounded-action job. It can reuse only a still-fresh inspection
score; otherwise it gets a new observation and choice, executes at most 12 ticks, and stops.
Its cancel operation invalidates the agent generation and releases inputs, so Stop during
inference or execution cannot be undone by a late reply. Map/model changes and tab/focus loss
use the same cancellation path. Busy checks prevent concurrent step or start jobs. The old
frozen Score and single-frame engine methods remain diagnostic APIs, not UI buttons. The game gets the larger left column and all the available
viewport height after the compact controls and credits footer. A ResizeObserver recomputes
its fitted height when controls wrap or loading UI changes, preserving the renderer's 4:3
content. It stays fully visible at tested 1366×768 and 390×844 initial viewports. Stats,
navigation/explanation panels, the engine-log panel, and Play yourself button have been
removed. A compact **Thanks to:** footer links Kev, Laya, Kevala, Qwasm, and LibreQuake.
Desktop cards scroll within an inspector matched to the game height; narrow screens stack
the feed.

`src/decision-cards.js` displays only the latest five records, newest first. Cards are keyed
by decision ID: adding one at the top preserves older expanded details, payload scroll, and
focus until eviction. There is no history selector. Clicking a card does not change the
agent's current decision or enable execution of history. Each card retains exact requests,
untouched responses, all candidate probabilities/filters, and observation/outcome inspection
with scoped Copy controls. The old explanatory paragraph is replaced by **State sent to
model**, a native disclosure with an expansion arrow above the weighted actions, collapsed
by default.
Its content comes directly from `requests[].state`, not `sharedState`, current telemetry, or
candidate prose. A single shared-state request is displayed verbatim; a baseline batch shows
all request states as a JSON array in request order. Its Copy control uses the same text.
Text is never interpreted as HTML. The heading and browser title are **Qev - quake +
decision model**; startup restores that title after SDL initializes its own window caption.
The masthead shows this brand on the left, with a
GitHub repository link and an inactive 𝕏 post-link slot on the right. The X icon has no
fabricated URL; it will be enabled when the actual post exists. Pressed primary buttons
retain dark text and full opacity, so the disabled/running Start label stays readable.

The only decision badges are Accepted and Rejected. Valid inspection choices and applied
commands are accepted; replacement, expiry, and interruption of an applied command do not
become rejections. Unapplied discarded/cancelled/error/revalidation-failed choices are rejected.
Pending inference has no verdict badge. Acceptance is not completion or proof of input ticks.
The agent's lifecycle and 50-record history remain unchanged; full exports retain its detailed
statuses/reasons, plus current observation, exploration memory, and the bounded engine log.
`window.qev.engineLog` also exposes a diagnostic copy without restoring a below-game panel.

`Respawner` reacts once per observed death epoch, not to completion or merely unready state.
It captures the active map/difficulty and intended mode, invalidates old decisions, waits
750 ms, and starts a fresh single-player level. This resets the level and starting loadout;
there is no checkpoint system. New-game readiness is checked for map, difficulty, epoch,
and an alive player. Exploration resets for that episode; old traces remain available.

Auto continuation waits for a prior worker job to settle, then starts a fresh ownership
session. Its result cannot cross the invalidated generation/epoch. Inspection stays paused;
the current app exposes no human-play mode. Pause, focus/tab loss, changed model/generation,
or intervening world changes prevent stale continuation. Pause can also
release a recovery UI waiting on slow inference while leaving the new life frozen. Duplicate
polls cannot schedule duplicate respawns; failure marks the current epoch handled and reports
an error rather than causing an endless reload storm. A manual restart creates a new epoch.

Both the UI poll and the Auto loop detect death, so a fast inference reply cannot clear Auto
intent before recovery captures it. Controlled comparison trials suspend automatic retries
to keep their metrics scoped to one episode. These are diagnostic handles, not asset/import
modes or user-facing bypasses of the game rules.

## Level objective, local navigation, and disclosed loop rules

Every request and its `action` choice question explicitly prioritize finding/reaching the level
exit. Enemy absence and kills are not victory. Only the engine's `completed` flag ends the
goal; the app makes no inferred completion or explored-map-percentage claim.

`ExplorationMemory` stores only sampled player positions/headings, observed contacts,
model-selected route hints, and action outcomes. It uses 64-unit 3D cells (up to 1,024),
up to 2,048 failed-route records, and up to 512 observed entity identities. Polling the
same paused position does not inflate visits. Reacquiring an already seen entity is not
counted as a new discovery. Distances include gravity/inertia but exclude teleport jumps.
The exported exploration snapshot includes at most 32 recent cells and 16 failed routes;
these are not a BSP map. Per-decision exploration summaries remain in card outcomes.

Pause, model reload, and Auto restart preserve this memory. A fresh map episode resets
it; same-map teleport preserves visited cells but clears the old local waypoint. A route
hint is created only after the model's exploration choice is accepted. In live mode its
endpoint comes from a fresh local probe at application, not the older scoring position.
A continuation candidate explicitly means continuing that exploration direction while
walkable, possibly beyond the prior probe endpoint; it is not an exact-arrival command.

Candidate construction now offers eight walking directions (including diagonals and
backtracking) even during combat, and faces the travel direction. A blocked 45-tick route
is retried at 24, 12, and 6 ticks; only the selected, validated horizon enters the request
and native command. Local hull probes recognize standard touch-operated doors/buttons,
including missing-key doors, only when the proposed hull trace actually contacts them.
The probe follows Quake's `SV_FlyMove` escape-from-startsolid behavior and uses the actual
partial step-up under low ceilings like `SV_WalkMove`/`SV_PushEntity`; it still checks hull
collision, floor support, and hazards. It never moves entities, opens doors, supplies keys,
or bypasses normal game physics. Shot-operated switches and arbitrary puzzles are not solved.

The following policy filters are **controller assistance**, not model probabilities:

- After repeated stationary scans/no new area or contact, suppress more stationary scans
  when at least one walking option is available.
- Temporarily cool down a cell/direction after two attempted walks with negligible movement;
  short interruptions and unexecuted commands are not treated as failed walking.
- Do not pursue full ordinary health or already-owned keys; megahealth has its own cap.
- If every walking option is blocked and all headings have been inspected, offer wait/recheck
  rather than constant spinning, with scanning eligible again after a 120-game-tick cooldown.

The six-candidate live budget (eight during inspection) reserves exploration alongside
combat/resources; candidate shortlisting considers route continuation and measured visits/
failures. Every filter has a visible reason and remains in the trace. The model chooses
among eligible options using its returned action ID and unchanged public probabilities:
there is no post-score rule that substitutes another move. No hidden exit coordinates, global actor lists, navigation
mesh, or hand-authored route is used. This is local exploration, not a full planner.

## Shared-state action choice

The default protocol in both modes is **one state, one `choice` question**, containing all
six live/eight inspection offers together. `prepareDecision` still constructs the same
candidate pool and applies the existing pre-score filters/budget. It then builds a compact
whitelisted state (objective, own condition, visible contacts, measured exploration, action
limits/endpoint estimates, and recent action/pacing context). `questions.action.criteria`
maps each offered action ID to a short description of its mechanics.

`Agent.score()` sends `decideMany([request])`: a one-item batch, retained for consistent exact
request/response capture. It does not repeat the state once per option. Laya's pinned pack
has a 512-token sequence limit and a 192-token question/option head; short criteria leave
space for useful observations. Crowded synthetic tests exercise the token budget separately
from real gameplay evidence. A response reporting 512 input tokens produces a visible
possible-truncation warning rather than silently claiming every word was read.

Validation requires one typed choice response, an offered action ID, exactly one finite
0–1 probability per offered ID, a distribution summing to one within public rounding error,
and a chosen action consistent with those probabilities. The chosen ID is authoritative
when public probabilities tie after rounding. The displayed ranking puts that actual SDK
winner first among tied values; it never replaces it with an input-order tie-breaker or
interprets a raw array using guessed ordering. Unknown/malformed choices fail closed while
retaining the complete original response. Relative choice probabilities are not calibrated
level-completion probabilities or generated explanations.

The old independent `favorable`/`noul` requests remain an **explicit comparison baseline**.
An `Agent`'s `decisionFormat` is fixed at construction; there is no runtime fallback that
reinterprets an invalid choice as a noul answer. `requestsFor` can produce either formulation
from an identical saved offer for passive paired evaluation, without querying or moving the
world. Legacy `candidates[].state` prose remains in records for that baseline; it is not sent
by the default choice controller. The exact `requests` array is authoritative.

## Clock and rendering

`Qev_MainLoop` owns a 60 Hz fixed-tick accumulator instead of the original wall-delta
main-loop call. Only explicit simulation ticks call `Host_Frame`; a paused browser frame
pumps input events but never runs physics, game clocks, or the host's RNG call. At ¼× or
⅒× playback, more wall time elapses between the same fixed ticks.

On startup/map load, bootstrap frames complete signon and the two input messages Quake
normally discards. Then the game pauses. The input-controlled render hook closes the
startup console immediately so the first paused observation is not obscured by its
half-finished slide animation. It does not run extra physics frames to achieve that.

Paused Score/Step inspection freezes the entire world during inference. **Real-time Auto
does not pause for model requests.** Kevala 0.1.3 already runs inference in its own worker;
Qev keeps the engine's frame loop running and holds the previous valid input lease while
awaiting the next result. Replacing a live command does not reset the fixed-tick accumulator.
There is one request in flight, with a 120 ms minimum interval between request starts;
there is no backlog of observations or overlapping model calls.

Exploratory walking uses a stable direction reference while a command is held. Previously,
new “forward” vectors used the observed camera yaw. Inference could finish after that view
had turned, so repeatedly choosing forward restored alternating old angles (for example,
153° and 180°) rather than continuing the accepted course. `Agent.score()` now supplies the
identified held exploration command when its epoch/action serial still match and its lease
is active. Walking options use that command's world-space movement heading; combat and scans
still use actual view direction. The basis and source decision ID are recorded in `steering`
and the distinction is disclosed in both input formulations and candidate labels.

This is pre-score action construction, not a post-score correction: the chosen parameters
remain untouched during application. In inspection or without a matching active exploration
command, walking uses the current view rather than an old travel vector. Realtime ownership
checks still reject invalid sessions. Geometry/age guards can reject a forward replacement
and leave the existing valid command alone. The model
can explicitly change course; this removes one feedback loop, not the need for persistent
semantic targets or better exploration policy. Jump/swim inputs are still unimplemented.

The JS agent rejects results older than 60 simulation ticks or 1.5 wall seconds, and native
code checks the tick age/session again at application. A slow or failed inference cannot
hold movement/fire indefinitely: leases expire to neutral input, not a world freeze.
Browser tab hiding and focus loss interrupt Auto and freeze the engine. The demo starts
on Hard with audio disabled; difficulty changes apply on map restart. Deterministic replay
across sessions is not yet certified.
These guarantees decouple policy cadence from simulation, not guarantee rendered FPS on
resource-constrained devices.

## Decision records

`Agent.score()` freezes the engine for inspection, prepares its one-item choice batch, and retains exactly
the request array passed to `decideMany`. `Agent.step()` checks exact freshness again and
executes the corresponding original-index candidate.

`Agent.startLive()` establishes a new native control session. `score({realtime:true})`
uses the latest moving-world snapshot without pausing; `applyLive()` applies only the
selected candidate after fresh checks. Scoring itself still never executes an answer.
The selected live horizon (up to 750 ms, shorter near obstacles), currently held action,
and exploration/loop context are disclosed in each request. Live records cannot be executed through debug Step after pausing.

A record contains the before observation, mode, decision format, shared state, steering
reference/source decision, exploration summary, all candidates (including geometry, ammo, resource-objective, and loop rejection
reasons), eligible-ID-to-choice mapping, exact requests, untouched responses,
ranking, selection, duration, status/error, and measured after observation. Live records
also retain the checked/applied snapshots, decision age at application, action serial,
active input ticks, fresh applied geometry/navigation summary, and observed stop reason. The sampled outcome window can include idle
time after expiry and is not mislabeled as uninterrupted execution or a causal combat
rollout. Memory describes that observed interval explicitly.

Original arrays are not sorted to build the ranking. Invalid model shapes/probabilities
fail closed while preserving the response. Real-time Pause, reset, model change, death,
completion, and human takeover discard late results; native session tokens also prevent
old commands from crossing a pause/resume boundary in the same map.

History is bounded to 50 records and can be exported as version-4 JSON, including the
request's decision format. Browsing an old record does not make it executable. Default
selection uses `answers.action.choice`; displayed probabilities come from
`answers.action.probabilities` by stable action ID. Only the explicit noul baseline ranks
independent `answers.favorable.noul` values with input-order tie-breaking. Raw fields remain
untouched and visible in both cases.

Candidate descriptions distinguish geometry estimates from future combat outcomes. In
particular, non-firing scans also report exposure to the known enemy; omitting that fact
made the initial wording misleadingly attractive to the classifier. Short memory records
actual displacement and damage; persistent exploration adds observed novelty and loop
evidence. These are input facts, not hard-coded tactical scores. The explicit pre-score
loop/resource filters above are separately disclosed rather than masquerading as model choices.

## Verification and limits of the evidence

The Node tests cover candidate filtering, non-leakage, coordinate conventions, response
validation/index alignment, async lifecycle races, finite execution requests, bounded
history, PAK parsing/complete-set checks, demo progress/integrity/abort/error handling,
fatal-engine error propagation, HTTP filesystem/asset isolation, observed-only bounded
exploration, waypoint continuity, key/resource handling, adaptive horizons, scan/route
cooldowns, blocked-route waiting, teleport session invalidation, shared-state/choice mapping,
rounded choice ties, malformed or inconsistent distributions, immutable response protocols,
trial-metric handling of cancellation and gravity, delayed-forward steering stability,
view-relative combat/scans, rejection of expired or mismatched steering references, difficulty
validation, respawn completion/cancellation/failure races, binary decision presentation,
newest-five selection, and preservation of raw lifecycle/protocol data.

The Chromium check runs the real compiled engine with the automatic local-server demo.
It checks the absence of an import UI (including at old asset-mode URLs), a real legacy
startup error, an interrupted demo fetch, reload recovery, and automatic startup without
file selection or remote/model requests. Mock inference is used to force race
conditions and deterministic control assertions. With `--model`, the same test loads
real Laya on WebGPU, scores live observations, executes its selection, and checks
successive real-time Auto decisions. It samples ticks during individual live worker requests,
verifies continuous held input and non-pausing replacements, rejects stale native sessions/
observations, and tests both tick-lease and wall-watchdog expiry. It writes live traces and screenshots to
`build/`, not into committed fixtures. Tests have used freely licensed LibreQuake data,
not commercial Quake PAKs. Browser checks also verify all four actual engine difficulty
settings, default map 6 on Hard, larger above-the-fold game layout, and native zero-health death
recovery in inspection/Auto modes. Card checks verify newest-first five-record eviction,
binary verdicts, no verdict during inference, untouched payloads, HTML-injection safety,
per-card Copy, and preservation of expansion, focus, and scrolling when new cards arrive.
Playback checks verify exactly three buttons, one-click Step with real Laya, Stop during
both scoring and execution, and immediate stopped map/difficulty changes—including during
real-time inference and a pending Step. The model prompt is checked for selected model/size,
Cancel and Escape dismissal, absence of unsolicited network requests, explicit confirmation
loading real Laya, and keeping the world stopped after loading. Test-only console key binding sets health to zero: LibreQuake's
`kill` command itself restarts immediately inside QuakeC and would bypass the observed-death
path being tested. No diagnostic kill export is added to the production bridge.

The optional LibreQuake encounter overlay keeps existing geometry and changes entity
placement to put a single grunt and health pickup near the player. Its source resource
hash is checked before generation; the original archives are unchanged. This is a small
functional encounter, not a controlled published gameplay benchmark.

With `--explore`, the browser check additionally runs 30 seconds of real Laya control on
`lq_e0m1` and `lq_e0m2`, exporting observations, exploration summaries, requests/responses,
and outcomes. Test collectors retain complete episodes without changing the app's 50-record
history limit.

With `--compare`, `scripts/compare-decisions.mjs` runs separate 30-second choice/noul episodes
on both maps, alternating format order. Both use the same model, maps, candidate construction,
loop rules, input limits, 100 ms observation polling, and single-flight control lifecycle.
It then samples the exact saved offers for passive paired scoring: 12 observations, twice per
format with alternating execution order. These paired requests share observation/action
facts, but compare compact joint prose against the original per-candidate wording—not a
pure ablation of the `type` field. No paired response is executed on an unrelated world.

One WebGPU run measured median paired latency of 145 ms / 354 tokens for choice versus
721 ms / 2,189 batch tokens for noul. Crowded synthetic choice inputs used 465 tokens for
inspection and 460 live (with a held-course reference), below Laya's cap. Live runs recorded
67 vs 43 remembered cells on `lq_e0m1`, and 97 vs 47 on `lq_e0m2` (choice vs noul).
All four remained alive; none completed.
The live trajectories are not deterministic/matched replays, and positions/displacement
include gravity/inertia. These are development observations, not a general quality benchmark.

`build/decision-comparison.json` stores summaries and paired requests/responses; the four
`build/comparison-<map>-<format>.json` files retain full live episodes. Scan input ticks and
stationary scan streaks are separate metrics; falling is not stationary. Discarded replies
include intentional deadline cancellation and are not all mislabeled as stale inference.

The steering regression deliberately scores forward while a previous turn is unfinished,
advances the actual engine during the delayed reply, and checks that repeated forward does
not reverse the view. It permits legitimate fresh-geometry rejection rather than bypassing
native guards. The two new choice trajectories also retained the prior held direction in
all 169 identified applied forward replacements. Saved older traces changed that direction
by more than 5° in 86 of 119 such replacements; these were different trajectories, not
paired replays. `build/steering-summary.json` records the metric definition and counts.

This does **not** establish robust gameplay skill. There are no trained-policy claims,
full-level completion claims, or fabricated model explanations. Jumping, swimming controls,
automatic weapon choice, shot-operated switches, global route/puzzle planning, and model/rule
comparisons remain future work. Legacy-engine failures may require a page reload. Mission packs and arbitrary mods need their own observation/action adapters.
