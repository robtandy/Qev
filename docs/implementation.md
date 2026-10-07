# Implemented vertical slice

This document describes the working implementation. `state-and-actions.md` and
`qwasm-integration.md` preserve the initial proposal and source research; their broader
navigation, memory, rollout, and evaluation goals are not all implemented.

## Reproducible source boundary

- Qwasm: `f56b5e71e4be8effede29bae1785a5306dcc0249`.
- Emscripten SDK: 3.1.74, SDK source `3d6d8ee910466516a53e665b86458faa81dae9ba`.
- Kevala: npm `0.1.3`, locked in `package-lock.json`.
- `engine/qwasm.patch` adds input/lifecycle hooks to six upstream files and pixel-attribution
  hooks to six software-renderer files. The complete upstream source is fetched under
  ignored `build/qwasm`, never copied into application modules.
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
| `qev_snapshot()` | Version-3 JSON copy of ready/pause/epoch/tick/action state, assistance mode, and mode-specific player/entity observations |
| `qev_screen_version()` | Required capability version `1` for renderer-visible-pixel observations; older engine builds fail with rebuild guidance |
| `qev_assistance(enabled)` | Switch assisted (`1`) / raw-input (`0`) mode, stop input, and advance the observation epoch without restarting the map; persists across level loads |
| `qev_probe(dx, dy, slot, generation, ticks)` | Assisted mode only: non-mutating swept-hull/support/hazard probe over 1–45 ticks, plus hypothetical endpoint line of sight; returns an error when assistance is off |
| `qev_pause()` | Clear action/input leases, cancel remaining requested ticks, freeze world time |
| `qev_play()` | Return to ordinary keyboard/mouse input and resume simulation |
| `qev_speed(scale)` | Set wall-time pacing in the range 0.05–1; physics tick size is unchanged |
| `qev_action(epoch, tick, dx, dy, slot, generation, yaw, pitch, attack, ticks)` | Assisted mode only: validate and execute a bounded action from the exact paused observation; 1–12 ticks maximum |
| `qev_input_action(epoch, tick, forward, side, yawRate, pitchRate, attack, ticks)` | Assistance off only: execute relative inputs from the exact paused observation; 1–12 ticks, no target/probe/ammo/danger veto |
| `qev_auto()` | Resume simulation with controller-owned input; return a new control-session token |
| `qev_live_action(epoch, observedTick, session, dx, dy, slot, generation, yaw, pitch, attack, ticks)` | Assisted mode only: revalidate and replace a lease while simulation runs; 1–45 ticks, observation age at most 60 ticks, matching session/epoch |
| `qev_live_input(epoch, observedTick, session, forward, side, yawRate, pitchRate, attack, ticks)` | Assistance off only: relative input replacement with the same age/session/lease bounds, without tactical validation |
| `qev_step_frame(epoch, tick)` | Advance one fixed tick with no agent input |
| `qev_new_game(name, difficulty)` | Validate a map name and integer difficulty 0–3; queue skill before spawning the new world, then pause when ready |
| `qev_load_map(name)` | Compatibility entry point preserving the currently active difficulty |

`src/engine.js` converts returned UTF-8 JSON to owned JS objects immediately. No mutable
WASM heap views escape into UI/history. It provides typed calls, map-name validation,
bounded operation waits, and startup error reporting. The new-game export is required at
startup so an older WASM build fails with rebuild guidance, not a mismatched call. Snapshots
report `difficulty` from Quake's `current_skill` (the loaded level's setting), not a pending
UI selection or a cvar that has not yet been applied.

Assisted inputs are normalized world-space directions. The bridge projects them into the
current view's forward/side axes each tick, so tracking does not silently rotate a requested
strafe into a different world direction. Assistance-off inputs instead use forward/side
controls relative to the current view, yaw/pitch rates, and an attack button. Neither path
fakes DOM events: both use Quake's ordinary user-command/physics path.

## Observation policy and guards

Only local single-player sessions are supported. Both modes use engine labels for stock
monsters/pickups; corpse filtering reads engine death/solid state. Enemy health and QuakeC
enemy/goal fields are not serialized. At most three enemies and three pickups are returned.
No audio or RGB images reach the text-only decision models.

**Assisted sensing** uses a 90° horizontal / 60° vertical view-cone check, a 1,024-unit range
cap, and a collision-ray line-of-sight test, returning nearest first. Lighting and actual
rendered pixels are not checked on that path. **Off sensing** instead requires nonzero
visible pixel coverage in the rendered viewport and sorts by that coverage, not distance.
It does not reuse the assisted range/cone/ray tests. Neither path is human-equivalent
perception: automatic engine classification remains a significant concession.

Health/ammo/armor and silver/gold key inventory are HUD facts. In assisted mode, snapshots
also expose precise positions, bearings, and actor IDs/generations. The controller uses GPS
memory and privileged geometry queries in all walking directions, including off screen, plus
hypothetical destination-cover tests and door/key metadata. Actor filtering does not make
those geometry queries human-equivalent or restrict them to visibly known terrain.

In assistance-off mode the native snapshot removes world coordinates, yaw/pitch, ground/water
flags, ranges/bearings and stable actor IDs. The previous engine-derived nearby/medium/far bins
are gone. Contacts contain a kind, visibility flag and visible-pixel measurements described
below. Unavailable or malformed screen data stays unknown; there is no geometry-based
fallback. Native probe calls fail in this mode.

Both modes require exact epoch/tick for inspection, or an active matching session/epoch and
an observation at most 60 ticks old for live input. Finite numeric bounds and action durations
are always enforced. **Only assisted input** additionally validates target identity, visibility,
ammo and local routes, repeats movement/target checks each tick, tracks at up to 180°/s, and
fires only when aligned with a clear shot. Relative inputs have none of those tactical guards:
fire can miss or run without a visible target/ammo, movement can hit walls or enter hazards,
and ordinary game physics/damage decides the result. Stock Quake weapon behavior remains;
no god mode, noclip, or extra ammunition is introduced. Neither path substitutes another model choice.

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

## Toggleable assistance-off experiment

The **Assistance** selector defaults to **On**, preserving the established demo. **Off · visible
telemetry** is an explicit experiment, not a claim of screen-only or human-equivalent play.
`src/assistance.js` centralizes both policies. `src/unassisted.js` always offers the same 14
relative primitives: forward/back/left/right; turn left/right; look up/down; fire; each of
the four movements with fire; and release all inputs. There is no movement/cover look-ahead
query, resource/loop filter, nearest-target macro, tactical shortlist, or post-application probe.
Engine labels/corpse filtering remain part of the sensing concession; visible-pixel coverage,
not an extra visibility ray, determines which objects are described. Health/ammo, screen cues,
enemies and pickups do not change which inputs are offered or their order.

Movement is 200 units/s, turn primitives 60°/s, look primitives 45°/s. The native boundary
caps turn/look rates at 180°/s and uses the same 12-tick inspection / 45-tick live lease limits.
The model must choose its own turns and shots; no entity reference reaches raw input.
Unassisted outcome memory records the last applied input and HUD health/ammo changes,
not displacement, cell visits, contact identity or waypoints. A separate short-lived visual
memory compares image extents, without stable actor IDs or GPS (below). Both entering and
leaving this mode discard old navigation/memory. Priorities still change the actual prompt
in both modes.

Changing the selector stops Auto/Step, cancels pending respawn continuation, and invalidates
old model responses. The native setter clears leases and advances the observation epoch,
even across an on/off/on sequence, while preserving position, game time, health, map and
skill. The wrong mode's native action entry points reject calls. The setting persists across
map/difficulty changes, deaths and model/backend reloads, but a page reload defaults to On.
Weights are not reloaded just to switch assistance. Every record/card/export identifies its
mode and retains the exact original request; switching cannot rewrite old decisions.

Off removes aids but also lacks a human's scene understanding: walls/floor are not described,
the decision models receive text rather than screenshots/audio, and engine object
classification remains a concession.
There are no jump/swim/weapon-selection primitives in this first experiment. Stop, focus-loss
handling, death recovery and bounded leases remain. Step and slow playback still pause/slow
the world; use **Start at 1×** for real-time experiments. This is a package ablation with a
different observation/action interface, not an isolated measurement of any one assistance.

### Visible-screen size and depth cues

`engine/qev_pixels.c` is a standalone 2D tag-mask reducer. Renderer hooks tag only ordinary
opaque fragment writes that win the existing rendering tests; surface spans cover brush
pickups as well as alias-model monsters/items. Unknown objects, the foreground weapon and
particles overwrite labels behind them. Transparent sprite texels do not. Water warp copies
tags using the **same source-pixel mapping** as the image. The reducer receives no world
coordinates, camera pose, Z values, projected 3D bounding boxes or collision queries.
Internal tags associate visible pixels with the explicitly allowed engine labels; they are
never exposed as actor IDs or used for temporal matching.

For each retained object the native snapshot supplies normalized visible bounds, final pixel
count, whether a labelled pixel occupies the exact viewport-center aim point, edge clipping,
and the number of currently visible objects of that kind. `screen` records the source,
render-frame number, simulation tick, viewport and image-warp status. Measurements are from
the 3D viewport, not the HUD. Both modes capture frames so switching Off while stopped reads
the existing image without advancing physics, RNG, animation or game time. Stale/incomplete
frames, covered views (console, center text, scoreboard, pause/loading/dialog), and unsupported
debug/stereo rendering are unavailable, rather than replaced by geometric estimates.

`src/screen.js` validates/copies these measurements and derives screen-relative direction,
center `(x,y)%` from the top-left, and apparent size. The prompt uses **visible height %**
plus tiny/small/medium/large to stay compact; width, exact bounds, counts and cue evidence
remain in the record's `visual`/outcome `screenCues` payload. `aim on/off` is image overlap,
**not a hit prediction, line-of-fire test or firing gate**. No controller aims or fires on
behalf of the model, and all 14 raw inputs remain available regardless of the cues.

`ScreenMemory` holds at most eight permitted image samples over 45 game ticks, normally at
least four ticks apart. Growing/shrinking requires three consistent images spanning at least
12 ticks, comparable widths/heights and silhouette fill, small image displacement, and a
unique visible object of that kind. Duplicates, loss, clipping, tiny silhouettes, large detected
silhouette changes, warped views, gaps, viewport/epoch changes and invalidation withhold or reset the
trend. Even a brief observed disappearance between regular samples breaks continuity.
Evidence contains only frame/tick, visible bounds and pixel counts; historical requests and
cue evidence are never recomputed. This is short-lived image matching, not GPS or identity
tracking through walls.

**Depth remains uncertain.** Larger/growing images can suggest nearer/approaching objects,
but object size, animation, occlusion, camera movement and zoom can also change them. A
partially visible object has no known full extent or occlusion percentage. Darkness and
human recognizability are not independently assessed; labels come from the engine, not a
learned RGB detector. Walls, floor, hazards and unseen space are still unknown. No vision
weights are downloaded and this does not turn Kev/Laya into image-input models.

## Level selection, layout, and death recovery

The default is `lq_e0m6` on Hard (`skill 2`), in both the engine API and initial selector. Compact top controls offer Easy/Normal/Hard/Nightmare along
with the map. Changing either selector immediately loads a fresh episode with both selected
values and leaves it stopped; there is no separate restart/apply button. Selection stops
continuous control and invalidates outstanding decisions before the engine load. Selectors
are disabled during loading to prevent overlapping map commands. Model downloads remain explicit.

The playback buttons are **Start**, **Stop**, and **Step** only. Start is one-way and disabled
while running or loading a model. The model selector initially says **Choose a decision
model**, with neither Kev nor Laya selected. A steady accent highlight marks the required
choice from first paint, with an associated hint explaining that selection downloads the
model if needed. Changing the dropdown loads that model immediately; there is no Load button
or confirmation dialog. Empty/unknown choices never fall back to the SDK default. Start
without a model focuses the dropdown without choosing or downloading anything. Changing the
backend reloads an already selected model, but a backend preference alone downloads nothing.
Loading stops playback, invalidates outstanding decisions, and disposes the previous model.
The model/backend selectors stay disabled during the single-flight load; Cancel aborts it.
Cancelled or failed loads reset and re-highlight the placeholder so the same model can be
selected again. Late progress is ignored and a model that finishes after cancellation is
disposed, never installed. Successful loading leaves play stopped until Start or Step.
Stop freezes the simulation without resetting the map. `src/stepper.js` owns
a single-click frozen-score/bounded-action job. It can reuse only a still-fresh inspection
score; otherwise it gets a new observation and choice, executes at most 12 ticks, and stops.
Its cancel operation invalidates the agent generation and releases inputs, so Stop during
inference or execution cannot be undone by a late reply. Map/model/assistance changes and tab/focus loss
use the same cancellation path. Busy checks prevent concurrent step or start jobs. The old
frozen Score and single-frame engine methods remain diagnostic APIs, not UI buttons. The game gets the larger left column and all the available
viewport height after the compact controls and credits footer. A ResizeObserver recomputes
its fitted height when controls wrap or loading UI changes, preserving the renderer's 4:3
content. It stays fully visible at tested 1366×768 and 390×844 initial viewports. Stats,
navigation/explanation panels, the engine-log panel, and Play yourself button have been
removed. A compact **Thanks to:** footer links Kev, Laya, Kevala, Qwasm, and LibreQuake.
Two compact columns sit beside the game: **Priorities** (210 px) and **Decisions** (270 px,
reduced from 340 px). Both match the game height, with bounded list scrolling. Tablets put
the columns side by side beneath the game; phones stack them with larger reorder buttons.

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
Text is never interpreted as HTML. The masthead uses the steel **QEV** SVG wordmark with
**quake played by a local decision model** to its right, replacing the old boxed Q and
heading. The logo has QEV alternative text and fixed intrinsic dimensions; the tagline
wraps beside it on narrow screens without overlapping the project links. SVG assets are
served as `image/svg+xml`. The browser title is **QEV - quake played by a local decision
model**; startup restores it after SDL initializes its own window caption. The masthead
keeps the GitHub repository link and inactive 𝕏 post-link slot on the right. The X icon has no
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

## Survival objective, reorderable priorities, and disclosed controller rules

The overall model goal remains **SURVIVE**. `src/objective.js` defines stable priority IDs and
shared wording for the UI, choice/noul requests, decision inspection, and trace exports.
The default order is:

1. Avoid damage and hazards; use cover or retreat.
2. Recover needed health, armor, and ammunition without reckless exposure.
3. Handle immediate threats while conserving ammunition.
4. Explore for supplies, routes, and the exit.

`src/priorities.js` shows the exact prompt wording beside Decisions. Drag/drop, up/down
buttons, or Alt+Up/Down on a focused reorder button change the order; Reset restores the
default. Keyboard focus is retained and changes are announced through a live status region.
The order must be a complete permutation of the four known IDs; malformed, duplicate,
unknown, or missing entries fail closed rather than being silently repaired. No custom text
or new actions are introduced. Choices persist across map changes, deaths, and model loads
for this page session; reloading the page returns to defaults.

Both prompt formats now say to follow the listed order, highest first. Wording that always
put exploration last (including "only after survival needs" and a permanently secondary
exploration question) has been removed, so moving it up actually changes the prompt's
ranking. SURVIVE remains the overall goal, not a reorderable fifth entry. **Priority order
changes the prompt, not the selected assistance policy.** On retains its survival-biased
action shortlist and tactical guards; Off keeps all fixed raw primitives. The panel explicitly
discloses the current policy; model compliance or better play is not guaranteed.

An `Agent` owns an immutable `priorityOrder` snapshot. `setPriorities()` validates before
changing anything and invalidates the controller even for a previously scored frozen state.
The UI also stops Auto/Step, releases input, and cancels any pending respawn resume. Replies
scored under the old order cannot execute or restart play. Start or Step then sends the new
order, without reloading model weights. A no-op move does not interrupt control. Records keep
independent priority IDs, ordered objective text, and exact original requests; inspecting an
old card never reconstructs it from the current list.

Survival is ongoing, not a completed-goal flag. Enemy absence, kills, movement, and new cells do not prove safety
or success. Only the engine's `completed` flag establishes secondary level completion; the
legacy `exploration.goalComplete` field still means that flag, not a survival score. No
hidden exit coordinates or unexplored-map percentage are inferred.

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
  only when a walking option is available, no enemy is observed, and the last same-episode
  outcome records no health loss. Known pressure must not force exploration merely to
  increase novelty. Repetition during defense/recovery is not described as tactical failure.
- Temporarily cool down a cell/direction after two attempted walks with negligible movement;
  short interruptions and unexecuted commands are not treated as failed walking.
- Do not pursue full ordinary health or already-owned keys; megahealth has its own cap.
- If every walking option is blocked and all headings have been inspected, offer wait/recheck
  rather than constant spinning, with scanning eligible again after a 120-game-tick cooldown.

The six-candidate live budget (eight during inspection) keeps validated defensive options
available instead of automatically putting keys/novelty first. It reserves firing choices
including backpedal-and-fire (or another valid moving-fire option), up to two needed supplies,
and walking alternatives. Visible health below 100 (especially at 30 or less), current-weapon
ammo at five or less, and armor below 100 have shortlist priority over keys. Armor type/upgrade
value is unknown; this is a disclosed offer heuristic, not a promised improvement.

With a visible threat, walking offers favor projected blocked line of sight to the nearest
observed enemy, then increased separation, before route continuation, visits, or failed-route
counts. This can retain a known retreat rather than a novel forward path. These estimates
refer to that enemy's observed position, not future movement or all enemies, and cannot
promise cover or escape. Without a visible threat, route continuity and measured novelty
still help offer exploration. Scan/wait options fill the remaining budget.

These are **pre-score shortlist rules**, retained as `offerPolicy` in every record and its
observation/outcome disclosure; a budget-omitted candidate has an `offerNote`, not a fake
geometry rejection or model score. The model still chooses among offered options using its
returned action ID and untouched probabilities. Nothing substitutes a different action after
scoring. No global actor list, navigation mesh, or hand-authored route is used. This remains
local control, not a full survival planner.

## Shared-state action choice

The default protocol in both modes is **one state, one `choice` question**, containing all
up to six live/eight inspection offers together. `prepareDecision` constructs the candidate
pool and applies the disclosed survival-first filters/budget identically for both formats. It then builds a compact
whitelisted state (objective, own condition, visible contacts, measured exploration, action
limits/endpoint estimates, and recent action/pacing context). `questions.action.criteria`
maps each offered action ID to a short description of its mechanics.

`Agent.score()` sends `decideMany([request])`: a one-item batch, retained for consistent exact
request/response capture. It does not repeat the state once per option. Laya's pinned pack
has a 512-token sequence limit and a 192-token question/option head; short criteria leave
space for useful observations. The state specifies the common maximum action duration once
and lists shorter bounds where applicable, instead of spending that budget repeating identical
durations. Crowded synthetic tests exercise the token budget separately
from real gameplay evidence. A response reporting 512 input tokens produces a visible
possible-truncation warning rather than silently claiming every word was read.

Validation requires one typed choice response, an offered action ID, exactly one finite
0–1 probability per offered ID, a distribution summing to one within public rounding error,
and a chosen action consistent with those probabilities. The chosen ID is authoritative
when public probabilities tie after rounding. The displayed ranking puts that actual SDK
winner first among tied values; it never replaces it with an input-order tie-breaker or
interprets a raw array using guessed ordering. Unknown/malformed choices fail closed while
retaining the complete original response. Relative choice probabilities are not calibrated
survival/level-completion probabilities or generated explanations.

The independent `favorable`/`noul` protocol remains an **explicit comparison baseline**, now
using the same overall survival goal and the order captured in each request rather than the previous exit-first question.
An `Agent`'s `decisionFormat` is fixed at construction; there is no runtime fallback that
reinterprets an invalid choice as a noul answer. `requestsFor` can produce either formulation
from an identical saved offer for passive paired evaluation, without querying or moving the
world. Legacy `candidates[].state` prose remains in records for that baseline; it is not sent
by the default choice controller. The exact `requests` array is authoritative.

## Sound

Quake's sound system is enabled; the old `-nosound` launch flag disabled it entirely.
The pinned SDL 2.30.9 backend sends the bundled LibreQuake effects and ambience through
Web Audio. Start and Step (including N) call `Engine.resumeAudio()` synchronously in the
user gesture, before awaiting model inference, to satisfy browser autoplay policies.
The app reports audio-device/permission errors without blocking game control. An audio
resume promise never starts simulation, so completing after Stop cannot restart gameplay.

Startup pauses SDL immediately after engine initialization and before yielding, including
when the browser already permits autoplay. Native pause, finished/interrupted stepping,
focus/tab loss, death, and world loading silence the mixer. The AudioContext can remain
unlocked while SDL outputs zeros; automatic respawn can therefore restore sound when play
resumes. Inspection stays silent while scoring, whereas continuous play keeps sound during
inference. Slow playback changes physics pacing, not audio pitch. Audio is for the observer;
no sound-derived enemy locations are added to model input. CD soundtrack playback is not
implemented (`cd_null.c`); no additional game or music files are distributed.

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
stopped on Hard, with sound enabled during play; difficulty changes apply on map restart.
Deterministic replay across sessions is not yet certified.
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

A record contains its assistance mode, observation/controller policy, primary objective,
captured priority IDs/order, ordered supporting objectives, shortlist policy,
before observation, mode, decision format, shared state, steering
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

History is bounded to 50 records and can be exported as version-7 JSON. The top level contains
the current assistance policy, `priorityOrder` and `objectives`; each record separately retains
its own mode, order, objective text, exact request, and decision format. Current exploration
is null when Off, as are raw records' navigation/geometry fields. Historical assisted records
remain labelled and inspectable; their privileged telemetry never feeds new raw decisions. Browsing an old record does not make it executable. Default
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
newest-five selection, preservation of raw lifecycle/protocol data, the shared survival
default hierarchy, all 24 priority permutations in both protocols, immutable priority snapshots,
invalid/no-op reorder handling, priority-change cancellation during scoring/held input/Step,
unchanged candidate offers, needed supplies ahead of keys, retreat/cover offers, pressure-aware scan guards,
unchanged model-choice authority, browser audio resume/error handling, and late audio
completion that cannot undo Stop.

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
real-time inference and a pending Step. Model-selection checks verify the initial unfocused
highlight, direct loading on choice, backend reloads, absence of a Load button/dialog and
unsolicited network requests, and Start focusing the empty selector without downloading.
A delayed fake loader exercises single-flight loading, cancellation (including a late success),
failures, same-model retries, ignored late progress, and model changes during pending real-time
inference. With `--model`, dropdown selection loads real Laya and leaves the world stopped.
`scripts/browser-priorities.mjs` checks button/keyboard reordering and native pointer drag/drop,
focus/boundary controls, current versus historical request text, stale-reply rejection in
inspection/Auto, interrupted Step execution, map-change persistence, and version-7 exports.
Additional checks cover configuration before engine startup, page-reset defaults, and
priority retention across model/backend changes.
Desktop/tablet/phone checks verify the new columns and usable touch controls. A real Laya
Step also sends a reordered priority list before the live trials return to defaults.
Test-only console key binding sets health to zero: LibreQuake's
`kill` command itself restarts immediately inside QuakeC and would bypass the observed-death
path being tested. No diagnostic kill export is added to the production bridge.

All Chromium tests launch with **`--mute-audio`**, verified through CDP before any checks,
so test playback is silent on the host. This does not disable normal gameplay sound.
`scripts/browser-audio.mjs` still checks the real SDL buffers internally under Chromium's
activation-required autoplay policy. Trusted Start/Step clicks and the N shortcut resume a suspended context.
The check samples buffers after the native callback, observing actual nonzero firing audio
and zero output during Stop, inspection inference, map loading, and focus loss. It generates
no test tones and injects no replacement samples. A simulated browser refusal verifies that
game control and Stop remain usable. The main suite also runs live Laya with audio enabled.

The optional LibreQuake encounter overlay keeps existing geometry and changes entity
placement to put a single grunt and health pickup near the player. Its source resource
hash is checked before generation; the original archives are unchanged. This is a small
functional encounter, not a controlled published gameplay benchmark.

`scripts/browser-assistance.mjs` verifies native snapshot redaction, disabled probe/assisted
APIs while Off, raw numeric/lease bounds, actual angular rates without target lock, real
ammunition spent without a visible target, and acceptance of a route vetoed by assisted
geometry. A throwing probe stub covers raw scoring, application and outcome collection.
It also checks Step/Auto cancellation on mode switches, historical-mode labelling, version-7
exports, and assistance persistence across map loading and death; model-loader checks cover
backend/model changes. Node tests poison privileged fields/probes/navigation to prove the
raw formatter avoids them, and verify the invariant 14-input set regardless of tactical state.

Visible-pixel reducer tests compile the standalone C module with AddressSanitizer and
UndefinedBehaviorSanitizer (explicitly skipped if no C compiler is installed). They check
final coverage rather than overdraw, partial/full occlusion, holes at the aim point,
viewport/HUD clipping, invalid inputs, reset, and exact warp remapping. JS tests poison
world/actor/range fields, cover ambiguous and stale image matching, bound memory, and retain
historical state/evidence. `scripts/browser-screen.mjs` checks real rendered extents, a one-tick
FOV change, brush pickups, draw-disabled actors versus still-visible privileged LOS telemetry,
and covered/debug-frame abstention. Test-only console settings are restored before the
normal gameplay checks; no render-control/cheat export is added to the engine API.

A separately labelled synthetic six-object request stresses Laya's 512-token input window.
The first verbose format hit that limit, so the model text uses height (full 2D extents remain
inspectable), compact timing and non-duplicated recency wording. The revised stress case
used 489 input tokens; a real 12-second Off trial used 414–435, without truncation warnings.
This checks input size, not depth accuracy or competent play. The real-mode trials still preserve model choices,
including repeated firing despite off-center targets; richer sensing is not proof of better
control or survival.

With `--assistance`, the muted browser harness loads real Laya and runs one fresh 12-second
map-6/Hard episode per mode at 1×, without auto-respawn. Full inputs/responses/outcomes go to
ignored `build/assistance-trials.json`; screenshots are saved per mode. The first illustrative
**pre-pixel-cue** run ended alive at 100 health in both modes, with neither complete. On applied 42 decisions
mixing movement/fire/pickups and ended with 12 shells; Off applied 82 decisions, all stationary
fire, and ended with 1 shell (both started with 25). Maximum reported input tokens were
454/393, with no truncation warnings. These are **single, non-matched-RNG trials with different
interfaces**, not evidence of a reliable performance advantage or human-equivalent play.
Reproduce with `node scripts/browser-smoke.mjs --assistance` after building/installing the demo.

With `--explore`, the browser check additionally runs 30 seconds of real Laya control on
`lq_e0m1` and `lq_e0m2`, exporting observations, exploration summaries, requests/responses,
and outcomes. Holding cover can be appropriate; visited cells or walking distance are not
mandatory survival progress. Test collectors retain complete episodes without changing the
app's 50-record history limit.

With `--compare`, `scripts/compare-decisions.mjs` runs separate 30-second choice/noul episodes
on both maps, alternating format order. Both use the same model, maps, candidate construction,
loop rules, input limits, 100 ms observation polling, and single-flight control lifecycle.
It then samples the exact saved offers for passive paired scoring: 12 observations, twice per
format with alternating execution order. These paired requests share observation/action
facts and the same survival hierarchy, but compare compact joint prose against detailed
per-candidate wording—not a pure ablation of the `type` field. No paired response is executed on an unrelated world.

A historical **exit-first** WebGPU run measured median paired latency of 145 ms / 354 tokens for choice versus
721 ms / 2,189 batch tokens for noul. Crowded synthetic choice inputs used 465 tokens for
inspection and 460 live (with a held-course reference), below Laya's cap. Live runs recorded
67 vs 43 remembered cells on `lq_e0m1`, and 97 vs 47 on `lq_e0m2` (choice vs noul).
All four remained alive; none completed.
The live trajectories are not deterministic/matched replays, and positions/displacement
include gravity/inertia. These are development observations, not a general quality benchmark.

The survival-first revision passes 214 Node tests plus real-engine/Laya browser regressions.
Six crowded choice cases (inspection/live, ordinary offers, needed supplies, and empty ammo)
used 481–500 tokens, below the pinned 512-token limit. Four separate 30-second choice/noul
smoke episodes on those two maps remained alive without input-limit warnings; none completed.
This validates the new request/control path, **not** an improvement in survival rate or a
controlled comparison against the old objective.

`build/decision-comparison.json` stores summaries and paired requests/responses; the four
`build/comparison-<map>-<format>.json` files retain full live episodes. Scan input ticks and
stationary scan streaks are separate metrics; falling is not stationary. Discarded replies
include intentional deadline cancellation and are not all mislabeled as stale inference.

The steering regression faces the open side of the arena to isolate course construction
from threat-aware shortlisting, which may legitimately prefer a different cover/retreat option.
It deliberately scores forward while a previous turn is unfinished,
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
