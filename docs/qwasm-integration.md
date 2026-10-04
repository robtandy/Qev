# Qwasm integration notes

## Source inspected

Repository: <https://github.com/GMH-Code/Qwasm>

Reference commit: `f56b5e71e4be8effede29bae1785a5306dcc0249` (`master` when inspected).
These are the original source-research notes. Qev now fetches this revision into ignored
`build/qwasm`, applies `engine/qwasm.patch`, and compiles it with the new bridge. See
[the implementation notes](implementation.md) for the working API; proposed names and
future steps below are preserved as design context, not a description of current status.

Kevala's API reference for this proposal is the `0.1.3` source at
[`5f1a710`](https://github.com/bvolpato/kevala/tree/5f1a7104aa6213cbe52ff03f876b5198fe451595),
including its [integration guide](https://github.com/bvolpato/kevala/blob/5f1a7104aa6213cbe52ff03f876b5198fe451595/skills/kevala/SKILL.md)
and [browser API](https://github.com/bvolpato/kevala/blob/5f1a7104aa6213cbe52ff03f876b5198fe451595/js/src/index.js).
Pin dependencies deliberately when implementing; do not use an unversioned CDN `latest`
for a reproducible demonstration.

## What is present already

| Existing source | What it provides / implies |
| --- | --- |
| [`WinQuake/Makefile.emscripten`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/Makefile.emscripten) | Emscripten + SDL2 build; software renderer by default, WebGL via GL4ES; currently preloads `id1` |
| [`WinQuake/shell.html`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/shell.html) | Browser `Module`, canvas, startup arguments, pointer lock, console, file export; not a bot observation/action API |
| [`WinQuake/sys_sdl.c`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/sys_sdl.c) | Registers an Emscripten main loop; `main_loop` measures wall time and calls `Host_Frame` |
| [`WinQuake/client.h`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/client.h) | Player HUD stats/inventory, view angles, velocity, grounded/water state, client entity references, movement command structure |
| [`WinQuake/cl_main.c`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/cl_main.c) | `CL_SendCmd`: gathers keyboard/mouse movement and sends it to the local or remote server |
| [`WinQuake/cl_input.c`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/cl_input.c) | `CL_BaseMove`, `CL_SendMove`, view-angle handling, attack/jump bits and weapon impulse serialization |
| [`WinQuake/world.h`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/world.h) | `SV_Move` hull/point traces and `SV_PointContents`; building blocks for local collision, support, hazard, and line-of-sight probes |
| [`WinQuake/progdefs.q1`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/progdefs.q1) | Rich server entity fields, including privileged data that must be filtered out of model observations |
| [`WinQuake/host.c`](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/WinQuake/host.c) | Client/server frame order, frame-time filtering, and server physics pause checks |

The inspected build and shell do not define a ready-made JavaScript API for snapshots,
bot inputs, or controlled simulation steps. We should add explicit exports, rather than
hard-code offsets into a particular WASM heap or try to drive the whole agent with
synthetic browser keyboard events.

## Original bridge proposal

The implemented bridge is documented in [implementation.md](implementation.md).
The names below were design placeholders, not exports from unmodified Qwasm:

- `qev_get_observation`: emit a versioned, visibility-filtered snapshot at a tick boundary.
- `qev_probe_local_move`: run bounded, non-mutating geometry probes under the observation
  policy. A hull sweep alone is not a full Quake movement or combat simulation.
- `qev_set_action`: accept a validated primitive/target and a bounded tick lease.
- `qev_clear_input`: release movement, firing, jump edges, and pending weapon impulses.
- `qev_set_paused` / `qev_step_ticks`: control the actual simulation clock, not just inputs.

Expose the bridge through a deliberately configured Emscripten build. Validate readiness,
local-server status, schema version, numeric bounds, target generation, and tick budget
before touching engine state. Prefer observation copies over JS references into movable
WASM memory. Do not expose an arbitrary model-authored console command interface.

### Observation hook

Export a snapshot after a completed simulation update. Use player/HUD state and local
geometry, and explicitly filter entity-derived facts. The local server can see everything;
that does not mean the model should. A local-server trace API also does not imply these
observations will work against an arbitrary remote multiplayer server.

First target stock Quake single-player data. Mods may use different model names, entity
semantics, animations, and QuakeC behavior; require separate adapters rather than silently
assuming the stock mappings apply.

### Input hook

A suitable place to investigate is the `CL_SendCmd` path after human input gathering and
before `CL_SendMove`. Movement, aim, buttons, and weapon impulses must all be handled:

- `usercmd_t` has movement components, but that alone is not a complete bot action.
- `CL_SendMove` reads aim from `cl.viewangles`, attack/jump from input state, and weapons
  from `in_impulse`; simply assigning a similarly named `cmd.viewangles` is insufficient.
- Bound aim rate and only track the selected observable target. Clamp movement consistently
  with the game's input rules, including combined-axis movement.
- `+use` is registered, but the inspected `CL_SendMove` serializes attack/jump bits, not a
  generic use bit. Do not infer a working interaction action from the binding alone.
- Keep manual play and pointer lock confined to the canvas. Inspector focus must not
  steal control, fire a weapon, or cause the shell to recapture the pointer unexpectedly.

## Pause, slow motion, and step need clock work

The engine has pause support, but robust inspection requires more than releasing keys:

- `Host_FilterTime` has a 72 Hz upper-frequency filter and clamps ordinary frame deltas.
- `host_framerate` replaces simulation frame time; it is **not** a conventional speed
  multiplier. Merely passing smaller deltas may interact with the filter instead of giving
  the intended slower simulation.
- `_Host_Frame` calls `rand()` before its time filter. Calling extra background frames can
  change randomness even when those calls do not run physics.
- Single-player physics is also gated by whether input is directed at the game versus a
  console/menu. Step execution needs a deliberate path independent of inspector focus.

Implement a tested fixed-tick scheduler for Qev's debug mode. Freeze the world while the
model scores; execute the requested number of ticks through the proper client/server
input and physics sequence; pause again without wall-clock catch-up. Keep rendering/UI
responsive and handle audio while stopped. Validate clocks and RNG before promising
exact replay. Do not build a step API by calling `SV_Physics` in isolation.

## Assets and build strategy

The [upstream README](https://github.com/GMH-Code/Qwasm/blob/f56b5e71e4be8effede29bae1785a5306dcc0249/README.md)
explains that game resource files are separate from the engine and warns against hosting
extracted Quake PAKs without appropriate rights. It also describes software/WebGL builds
and notes that browser WebSocket multiplayer support has not been added in this reference.

Proposed setup:

1. Pin Qwasm as a submodule or source dependency, preserving its license/notices.
2. Keep Qev bridge changes in a reviewable patch or maintained fork with reproducible build
   instructions. Pin Emscripten and, if used, GL4ES rather than relying on `latest` builds.
3. Do not accidentally package game resources through the existing `--preload-file=id1`
   setting. Use only the reviewed, hash-pinned LibreQuake demo bundle and stage its files
   into the engine filesystem before game initialization. Qev does not offer custom imports.
4. Keep original assets out of Git, published build outputs, and remote logs. A `.gitignore`
   alone does not prevent a build script from publishing them.
5. Load Kevala on an explicit user action and show download progress. If the model cannot
   load, leave the game paused with retry guidance. The current app no longer exposes human
   play. A model pack is substantial and should not download unexpectedly.

No final distribution license has been selected. Qwasm's C files carry GPL-2.0-or-later
notices and Kevala carries Apache-2.0; review compatible distribution terms and preserve
all required source/notices before releasing a combined application. Game assets and
model weights have their own terms.

## Suggested implementation order

1. **Human play:** build and host Qwasm, load the verified LibreQuake demo, verify ordinary play.
2. **Telemetry:** display the permitted snapshot alongside the game; verify visibility,
   local probes, coordinate conventions, and that hidden state does not leak.
3. **Clock/input bridge:** pause, tick-step, and manually execute bounded primitives; test
   input release, focus handling, reset, death, map load, and stale target IDs.
4. **Decision sandbox:** render real candidate descriptions and exact Kevala requests and
   responses, without applying them automatically. Compare question formats on fixtures.
5. **Step agent:** score one snapshot, manually execute its chosen action, and inspect the
   observed outcome. Establish matched rule/random baselines.
6. **Real-time agent:** only after measuring latency and stale decisions under concurrent
   rendering; later add exploration, memory, weapon choices, and more complex navigation.
