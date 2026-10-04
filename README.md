# Qev

An inspectable browser experiment: **Kevala** (Laya or Kev) chooses short tactical actions
in the classic **Quake engine**, built from [Qwasm](https://github.com/GMH-Code/Qwasm).

Source: **[robtandy/Qev](https://github.com/robtandy/Qev)**.

The first vertical slice is implemented: an automatically loaded LibreQuake demo,
a C/WASM observation/input bridge, fixed-tick pause/step, candidate scoring,
and asynchronous real-time Auto with exploration memory. This is an experimental
controller, **not a trained Quake expert or a reliable full-level solver**. It uses
telemetry and bounded aim assistance, not screenshots.

## Run locally

Requires Node.js 22+, Git, and `unzip` (for the demo installer). The engine setup downloads
a project-local Emscripten 3.1.74 SDK; it does not change your shell profile. The
software-rendered engine build has been verified on macOS/Apple Silicon with Chrome.

```sh
# First checkout (skip if you already have this repository):
git clone https://github.com/robtandy/Qev.git ~/github/Qev
cd ~/github/Qev
npm ci --ignore-scripts
npm run setup:engine       # first time: installs the pinned SDK under ignored build/
npm run build:engine       # builds Qwasm + the bridge, without embedding any game assets
npm run setup:demo         # one time: installs verified LibreQuake data + notices under build/
npm run serve              # http://127.0.0.1:8090
```

If the engine and demo are already installed, only `npm run serve` is needed.

1. Open **http://127.0.0.1:8090**. **Map 6 · Great Greek Grinder (`lq_e0m6`)**, a full
   LibreQuake level, loads **paused and silent**, with all three matching PAKs. No file picker or purchase is required.
2. Click **Load model**. Laya downloads approximately 479 MB; Kev approximately 857 MB.
   Weights run locally and cache in the browser. These downloads are **never automatic**.
   You can also click **Start** before loading: it prompts you to load the selected model,
   showing its download size. **Cancel** or Escape leaves the game stopped without a download.
   Confirm **Load model**, then press **Start** again once loading finishes.
3. Click **Start** for continuous real-time model control. **Stop** freezes the world.
   For inspection, **Step** chooses and runs one short action, then stops again.

Qev is **demo-only**: there is no game-data picker or custom-archive mode. It starts on
**Hard**, with sound disabled. Changing the **Map** immediately loads that map in the
**stopped** state. Changing **Difficulty** (Easy / Normal / Hard / Nightmare) similarly
reloads the selected map stopped. There is no Restart / load map button. Click **Start**
when ready to run. The active map/difficulty are shown below the selectors. Maps include Episode Zero, the hub,
and the one-grunt test arena. A spawn may initially be airborne; gravity advances during play.

The game has a larger, viewport-fitted canvas and a compact **five-decision card feed**.
The newest card appears at the top and pushes older cards down. There is no history picker,
Play yourself button, or stats/explanation/log panel beneath the game. The complete game
fits above the fold on tested 1366×768 laptop and 390×844 mobile viewports; the decision
feed sits beside it on desktop and stacks below it on narrow screens.

The upper-right GitHub link opens this source repository. The **𝕏** icon is reserved
for the forthcoming post and deliberately has no URL yet. When the post exists, add its
URL as `href` on `#x-post-link` in `public/index.html`, remove `aria-disabled`, and update
its accessible label/title. Do not substitute a made-up post URL.

## Controls

| Control | Behavior |
| --- | --- |
| Start | Run continuously; if no model is loaded, prompt to load one first. Disabled while loading or already running |
| Stop / `P` / `Esc` | Freeze the whole world, release inputs, and cancel a pending or executing Step |
| Step / `N` while stopped | Score a frozen observation, execute one action for **up to 12 ticks / 200 ms of game time**, then stop |
| Speed | 1×, ¼×, or ⅒× wall-clock playback; physics ticks stay fixed at 1/60 second |
| Map / Difficulty | Changing either immediately loads a fresh episode using both selected values and leaves it stopped |
| Decision cards | Expand any of the newest five decisions to inspect/copy its exact request, response, candidate scores, filters, and outcome |
| Export trace | Download the last 50 full records, exploration memory, current observation, and engine log |

Switching tabs/windows pauses the game. Buttons and inspector controls retain normal
keyboard behavior. Historical decisions cannot be executed on the current world.

An action may end early because its target disappeared, its path became invalid, its
lease expired, a newer decision replaced it, the player died, or the user paused. The trace records the actual ticks and controller stop
reason rather than claiming that the full planned interval happened.

## Decision cards

Decision badges use only **Accepted** or **Rejected**. Accepted means a validated decision
available for inspection/stepping, or an action already applied; replacing or interrupting an
applied action does not turn it into a rejection. Rejected covers invalid responses and
unapplied choices discarded/cancelled by freshness, safety, or controller checks. An in-flight
card has no verdict until there is one—it is not prematurely labeled accepted or rejected.
Acceptance is not a claim that the action ran for its full duration or completed a level.

Expand a card to see its relative probabilities, visible controller filters, and measured
outcome. **State sent to model** sits above the weighted actions with an expansion arrow,
collapsed by default. It shows/copies the exact `state` from the recorded request—not a
reconstructed observation or unsent candidate text. Full request/response inspection remains
available below the actions. Expansion, payload scroll position, and focus survive new
cards arriving until that card ages out of the latest five. Pause to inspect without the feed
advancing. The underlying 50-record history and detailed lifecycle reasons remain intact in
**Export trace**; the binary badges are presentation only. **Step** uses a fresh current
decision (or an already-scored, still-valid diagnostic decision), never an older card being viewed.

## Automatic respawn

When the bridge reports death, Qev waits 750 ms, then restarts the **active map at its active
difficulty**, with a fresh player and level state (single-player restart, not a checkpoint).
Unapplied map/difficulty selections are not used. Auto resumes with a new control session;
inspection stays paused. The app no longer exposes a human-play mode.

The old decision is invalidated immediately. If a worker is still scoring, the new life
waits stopped until its obsolete result is discarded. **Stop or tab/focus loss during
respawn prevents automatic continuation**; the restarted life remains paused. Completion
never triggers a death restart, duplicate death polls cannot queue reloads, and failed
respawns report an error instead of retrying in a loop. Old decision history is retained;
exploration memory resets for the new episode.

## Real-time control versus inspection

**Start** runs the fixed 60 Hz simulation continuously while Kevala performs inference in
its existing worker. There is only one decision request in flight: each new request uses
the latest observation, rather than queueing old frames. Between replies the last accepted
command continues with per-tick collision, visibility, aim, and ammunition guards.

Real-time candidates describe **up to 45 ticks / 750 ms of game time**, including probes
for that horizon. Replies replace the held command without resetting the simulation clock.
Before application, Qev checks controller session, map epoch, observation age, current
target/generation/visibility, ammunition, and the route from the player's **current** position.
Observations older than **60 simulation ticks or 1,500 ms wall time** are discarded.

Commands expire after their tick lease or a **1,500 ms wall-time watchdog**, whichever
comes first. Expiry releases inputs but **does not freeze the world**; the player can be
idle if inference is too slow. Pause, reset, death, completion, human takeover, and leaving
the tab invalidate pending real-time decisions so late replies cannot resume control.

**Step** freezes the whole world during inference and then advances at most 12 ticks / 200 ms.
Repeated clicks make fresh decisions. Stop, map/difficulty changes, model changes, and tab/focus
loss cancel the pending step so a late reply cannot execute. This is useful for slow CPU
backends and close inspection. Standalone scoring and one-frame advancement remain diagnostic
APIs, not additional playback buttons.
The inspector/export distinguishes observation time from application time, original model
choice from revalidation failure, and actual input ticks from a later observation window.

A Chromium/WebGPU comparison on this machine measured a median **145 ms** for one shared
`choice` request versus **721 ms** for the previous per-candidate `noul` batch, using the
same saved observations and action offers. Simulation ticks continue during live requests.
This is local evidence, not a guaranteed frame rate or latency on other devices. Faster
inference does not make the zero-shot policy a trained Quake player.

### Stable travel direction

While an exploration command is held, walking directions are relative to its accepted
world-space course—not the camera angle partway through turning toward it. Otherwise,
repeated “forward” decisions made during asynchronous inference could steer back toward
old camera angles and oscillate left/right even without the model choosing a turn.

The reference is disclosed in the request, candidate labels, and trace `steering` metadata.
Looking and combat stay view-relative. Paused inspection, an expired/replaced command, or
a new controller session does not inherit an invalid held-command reference. Each selected
vector is still applied exactly as offered, with fresh native validation; no answer is
silently changed or smoothed after scoring. The model can still explicitly choose a different
course—this fixes a steering feedback loop, not all poor navigation decisions.

## Level objective and exploration assistance

Every candidate is evaluated against **complete the level by finding and reaching its
exit**. Combat clears a route or keeps the player alive; kills and empty rooms are not
victory. Only Quake's `completed` signal marks success.

`src/navigation.js` maintains an observed-only, bounded record of 64-unit position cells,
view headings, observed contacts, revisits, failed walking directions, and recent lack
of progress. It survives Pause, Auto restart, model reload, and same-level teleport;
a new map episode clears it. The UI displays remembered cells and distance moved, **not
a percentage of the level explored**. Movement includes gravity/inertia, not just input.

The controller contributes these disclosed navigation helpers:

- Walking choices in eight directions, including diagonals/backtracking, even during combat;
  movement also turns the view toward that route.
- A continuation option for the model's last chosen exploration direction. Its local
  waypoint comes from revalidated geometry, not a hand-authored route or hidden exit.
- Shorter 24/12/6-tick probes when a 45-tick walk would hit an obstacle or unsupported edge.
- Local touch-door/button detection and key requirements; visible keys and owned inventory.
  The probe uses partial step-up headroom like Quake's movement instead of requiring a full
  18-unit rise. It does not teleport the player, open doors, or bypass key checks.
- Explicit temporary filters for repeated stationary scans when a walkable alternative exists,
  failed movement directions, normal health when already full, and keys already owned.
  When all directions remain blocked after looking around, wait/recheck avoids perpetual
  spinning; occasional scans remain possible as obstacles change.

These filters and rejected candidates remain visible in the inspector. The model chooses
among the eligible actions together; code does not pick a different answer or fabricate
a score. Up to six choices are offered in real-time (eight in paused inspection), reserving
room for exploration rather than filling the offer with combat.

No global navigation mesh, exit coordinates, hidden monster state, or scripted level route
is supplied. This is still local exploration, not a complete planner. Same-level teleports
invalidate the old command and inference job, then resume Auto with a new neutral session;
manual Pause, completion, and unrelated map changes never trigger that teleport resume.
Death recovery is handled separately by the fresh-episode respawner described above.

## What reaches the model

```text
filtered Qwasm snapshot + observed exploration memory
  -> budgeted combat/navigation candidates + geometric estimates
  -> one compact shared state + short descriptions of the offered actions
  -> Kevala.decideMany([{ state, questions: { action: { type: "choice", ... } } }])
  -> revalidate the selected candidate against the current world
  -> replace a finite input lease without stopping real-time simulation
     (or explicitly step it while inspecting a paused world)
```

Observations contain player status and at most three nearby observable enemies and three
pickups, filtered by a **90° × 60° cone and line of sight**. Hidden enemy health, intentions,
and global level entity lists are not exposed. The agent also receives measured action
outcomes and compact exploration/revisit/loop context. Own keys are HUD information;
door/button facts are from actual local hull contacts, not a global list of objectives.

The model compares firing, strafing/backpedaling while firing, approaching needed pickups,
exploring or continuing a route, scanning, and waiting when blocked. Geometry, resource,
and loop filters are labeled explicitly; filtered candidates are not assigned model scores.
One request contains at most six eligible choices live, or eight during inspection. Aiming
is capped at 180°/s and movement at 200 Quake units/s. Code does **not** choose a replacement
enemy or weapon behind the model's back.

The shared state describes the exit goal, player condition, visible contacts, exploration
memory, and each action's duration/estimated endpoint facts. A single `action` question asks
**“Which action best helps find and reach the level exit?”** Its `type` is `choice`; the
`criteria` map uses stable action IDs with short action descriptions. The model sees the
alternatives together rather than rating each one independently.

Qev executes the public **`answers.action.choice`**. The inspector displays the corresponding
`answers.action.probabilities`, mapped by ID. If rounded probabilities tie, the SDK's actual
returned choice still wins—not whichever row appeared first. Unknown actions, missing or
invalid probabilities, and inconsistent choices fail closed; there is no silent `noul` fallback.
The **entire original response**, including extra fields and timing, remains inspectable.
These are relative probabilities among the offered actions, **not calibrated chances of
completing the level**, and no generated explanation is invented.

Laya has a 512-token input limit and a separate question/option budget. Descriptions are
compact; crowded-input tests consumed 465 tokens for inspection and 460 live (including the held-course reference). The inspector
warns if a Laya response reports reaching 512 tokens, since text may have been truncated.
The earlier `noul` scorer is retained only as an explicit evaluation baseline; the app defaults
to `choice` in both paused and real-time modes.

Movement probes are conservative local hull/floor/hazard tests, **not full physics or
combat rollouts**. All candidates describe exposure to the observed threat consistently,
including non-firing/scanning choices. Predicted geometry and observed outcomes are kept
separate.

## Automatic, freely licensed demo

`npm run setup:demo` downloads the official
[LibreQuake v0.09-beta Lite release](https://github.com/lavenderdotpet/LibreQuake/releases/tag/v0.09-beta)
(about 56 MB), verifies its pinned SHA-256, and installs a complete bundle under ignored
`build/demo/librequake-v0.09-beta-lite/`. An existing verified download is reused. It keeps
the upstream `docs/` and generates a combined `NOTICE.txt` with licenses, credits, source
links, and a description of the encounter modifications.

The two upstream PAKs are unchanged. The generated `pak2.pak` reuses LibreQuake `lq_e0m1`
geometry but places one player, one grunt, and a health pickup nearby. The pickup starts
off to the left and is only reported when observable. This is not an original Qev arena
or a gameplay-quality benchmark. The generator never operates on original Quake assets.

Opening Qev fetches these three files (about 49 MiB total) from **your local Qev server**,
checks each file's size and SHA-256 again, and boots `lq_e0m6` paused. The generated
`qev_encounter` remains available as an explicitly labeled regression arena. No remote
asset/model requests are made by default. Missing or invalid data gets an actionable
setup/reload message, not a partially loaded engine.

The server only serves the exact pinned files at `/demo/pak0.pak`, `/demo/pak1.pak`, and
`/demo/pak2.pak`, plus `/demo/NOTICE.txt`. It verifies the **whole bundle and its notices**
before returning any bytes. Other PAK paths remain blocked, including files accidentally
copied into static directories. No proprietary game data is hosted or committed.

The setup command uses `scripts/make-test-encounter.mjs` to generate the pinned overlay.
No file selection is needed in the browser.

**If you see “registered version required”:** the demo data is incomplete. Run
`npm run setup:demo`, then reload Qev. The complete bundle includes LibreQuake's required
`gfx/pop.lmp` from `pak1.pak`. You do not need to purchase Quake to use this demo.

## Validation

```sh
npm test                   # pure-JS lifecycle, observations, input payloads, PAK validation, server isolation
npm run check              # JavaScript syntax

# Real browser + real engine: automatic demo, loading failures, mocked control/race tests:
node scripts/browser-smoke.mjs

# Also download/load real Laya and score/execute actual game observations:
node scripts/browser-smoke.mjs --model

# Also run 30 seconds of real Laya exploration on each of two full levels:
node scripts/browser-smoke.mjs --explore

# Compare choice/noul: four 30-second episodes, plus paired scoring of saved observations:
node scripts/browser-smoke.mjs --compare
```

Scenario-dependent movement assertions are verified against the LibreQuake maps/encounter;
other maps may need a different test setup. The browser check uses a separate Chrome
profile under `build/`, ports 8091/9226, and keeps
model caches there for repeat runs. Set `CHROME_PATH` if Chrome is not at the default macOS
location. The integration check uses only the installed demo via its local test server;
it never downloads game data from external sources.
Screenshots and live traces are written under ignored `build/`.

Verified with real Qwasm, LibreQuake test data, and real Laya on WebGPU: pause freezes game
ticks, a frame step advances one tick, a bounded action advances its allotted ticks (or
stops early), movement changes player position, and tracking/fire consumes ammunition
against an observed enemy. Real-time checks verify simulation progress during actual
worker inference, continuous held input, session/age guards, tick and wall-time expiry,
and immediate Pause with late-response rejection. The suite also checks actual map/difficulty
changes, death/respawn in inspection and Auto modes, Pause during recovery, stale pre-death
replies, one-click Step and cancellation during both scoring and execution, immediate stopped
map/difficulty changes, larger above-the-fold game layout, five-card order/eviction, binary verdicts,
expanded-card/focus retention, exact per-card copying, and safe rendering of model output. Death tests set health to zero using a standard Quake console binding
in the isolated test session; no kill/cheat export was added to the app bridge. The inference
race checks separately use a mock model. No gameplay
quality benchmark or full-level completion claim is made.

The choice/noul comparison scored **12 saved observations twice per format**, alternating
execution order and preserving the same eligible actions. Median input volume was 354 tokens
for shared choice versus 2,189 tokens across the independent ratings; median latency was
145 ms versus 721 ms. These compare the complete compact-choice formulation with the original
per-candidate prose, not just the question-type flag.

Separate 30-second live trials produced:

| Map | Noul: remembered position cells | Choice: remembered position cells |
| --- | ---: | ---: |
| `lq_e0m1` | 43 | 67 |
| `lq_e0m2` | 47 | 97 |

All four players remained alive; **none completed the level**. Choice spent fewer input ticks
scanning in those runs, but looping is not eliminated. These are separate non-deterministic
trajectories, not matched replays, completion rates, or proof of general gameplay superiority.
Cells/displacement include gravity and inertia, not just purposeful walking.

`build/decision-comparison.json` contains the comparison summary and exact paired requests/
responses; `build/comparison-<map>-<format>.json` contains complete trial records. The existing
`--explore` traces are written to `build/exploration-*.json`. Test collectors retain complete
trials without enlarging the app's 50-decision history. Steering regressions additionally
check delayed repeated-forward commands in both unit tests and the real engine. New live
traces retained the held course in 169 applied forward replacements across two maps;
`build/steering-summary.json` records that specific check, not a claim of jitter-free play.

## Current limits

- Stock single-player rules only. Mission packs, remote multiplayer, and arbitrary mods
  need additional adapters; entity names/rules are not universal.
- Software rendering only in this build. WebGL/GL4ES is a later optimization.
- No automatic jumping, swimming, weapon selection, shot-operated switches, or global route
  planning. Touch interactions and local walking are not enough to solve every map.
  Conservative probes can still reject traversable terrain; waiting is not proof that a
  route is impossible or that the objective is finished.
- The model is zero-shot and can make poor tactical decisions. A good first action is not
  evidence of a reliable policy. Compare against matched rule/random baselines before
  making performance claims.
- Real-time Auto depends on inference keeping up. Slow backends can leave the player idle
  after a lease expires, or produce responses too old to apply. Use stopped Step for
  slower CPU inference; real-time rendering/inference still share device resources.
- Fixed ticks do not imply fully deterministic replay; Quake's startup, RNG, and asset
  behavior still need dedicated replay validation.
- A fatal legacy-engine/data error may require a page reload. Setup errors include repair
  guidance, and the engine log retains the underlying cause.

## Code and design

- `engine/qev_bridge.c`: observation filtering, local probes, finite action leases, fixed
  simulation clock, and guards.
- `engine/qwasm.patch`: small, auditable hooks into pinned upstream Qwasm.
- `src/decisions.js`: candidate generation, shared-state choice requests, explicit noul baseline,
  and response validation; no inference or hidden engine data.
- `src/agent.js`: frozen inspection and real-time lifecycles, stale-result/session handling,
  held-command outcomes, memory, and bounded history.
- `src/navigation.js`: bounded observed-position/contact memory, route continuity, and loop evidence.
- `src/respawn.js`: single-flight death recovery, active-setting preservation, and safe mode resumption.
- `src/decision-cards.js`: five newest keyed cards, binary presentation labels, and per-card exact-payload inspection/copy.
- `src/stepper.js`: single-click score/execute lifecycle with cancellation across inference and action execution.
- `scripts/compare-decisions.mjs`: real-browser paired input/latency checks and separate live trials.
- `src/engine.js`: browser/WASM adapter and game initialization, including immediate fatal-error reporting.
- `src/demo.js`, `src/demo-manifest.js`: automatic loading of the complete pinned LibreQuake bundle.
- `scripts/setup-demo.mjs`, `scripts/demo-assets.mjs`: reproducible local demo installation and verification.
- `docs/implementation.md`: implemented APIs and deliberate constraints.
- `docs/state-and-actions.md`: original design and further experiments.
- `docs/qwasm-integration.md`: upstream source research and integration rationale.
- `examples/combat-decision.json`: **synthetic design fixture**, not a captured live trace.

## Licensing and distribution

This repository publishes **source only**, not a compiled game distribution. Qwasm's
engine source and Qev's engine bridge/patch are GPL-2.0-or-later; see
[`engine/README.md`](engine/README.md) and the preserved [`engine/COPYING`](engine/COPYING).
Kevala is an Apache-2.0 dependency fetched by npm, not vendored here. The build fetches
pinned engine source and preserves its upstream notices. Qev has not selected a
project-wide license for the independent application code. Before distributing a compiled
or combined application, review the applicable terms and supply corresponding engine
source, patches, build scripts, and notices.

Quake game data is separately licensed and must not be embedded or hosted without rights.
LibreQuake also has multiple component licenses (including BSD and GPL); its notices and
source links are preserved with the generated local bundle and linked from the app. This
localhost demo is not a prepackaged public game release: supply corresponding GPL sources
and satisfy the component licenses before distributing its generated runtime or assets. Model weights have their own terms. The repository
contains no game PAKs, model packs, generated engine binaries, or bundled third-party source.
