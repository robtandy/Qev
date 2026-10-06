# Qwasm integration source

Qev's engine bridge and the modifications in `qwasm.patch` are provided under the
**GNU General Public License, version 2 or (at your option) any later version**,
consistent with the Quake/Qwasm engine. They are provided without warranty.
[`COPYING`](COPYING) is the license text copied verbatim from the pinned Qwasm source.
The original Quake source is Copyright (C) 1996–1997 Id Software, Inc.; the build
retains upstream source headers and notices, including later Qwasm contributions.

## Reproduce the modified engine

- Upstream: <https://github.com/GMH-Code/Qwasm>
- Base commit: `f56b5e71e4be8effede29bae1785a5306dcc0249`
- Qev modification date: **2026-10-04** (subsequent changes are recorded in Git).
- Toolchain: Emscripten **3.1.74**.
- Source/build procedure: [`../scripts/build-engine.mjs`](../scripts/build-engine.mjs)
  and the setup instructions in [`../README.md`](../README.md).

The patch changes input ownership, world/entity lifecycle hooks, and the main loop
in six upstream `WinQuake` files. The added `qev_bridge.c` and `qev_bridge.h` provide
view-cone/LOS-filtered observations, assisted movement/aim and privileged geometry probes,
an optional coarse-telemetry/raw-input mode with those aids disabled, fixed simulation ticks,
pause/step and real-time input leases, matching SDL audio pauses, and map/difficulty
loading. Off mode redacts coordinates/IDs and disables the probe API; mode changes invalidate
old observation epochs without restarting the map. Neither mode derives perception from pixels. The build script adds the bridge to the makefile and removes asset preloading.

This repository publishes integration source, not compiled engine releases or game
assets. The build fetches the specified upstream source into ignored `build/qwasm/`,
applies the patch, and compiles it locally. Distributing a compiled engine requires
the corresponding source (upstream source, these modifications, and build scripts),
applicable notices, and compliance with the licenses of any accompanying assets or
model weights. Publishing these files does not grant rights to proprietary Quake
assets or change the separate terms of Kevala, LibreQuake, or model weights.
