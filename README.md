# Qev

Decision models playing Quake in the browser through [Qwasm](https://github.com/GMH-Code/Qwasm).

## Build and run

Requires Node.js 22+, Python 3, Git, `make`, and `unzip`. Tested in Chrome.

```sh
git clone https://github.com/robtandy/Qev.git
cd Qev
npm ci --ignore-scripts
npm run setup:engine
npm run build:engine
npm run setup:demo
npm run serve
```

Open **http://127.0.0.1:8090/**. Choose **Kev** or **Laya** in the highlighted dropdown to load it, then press **Start**.
**Stop** freezes the game; **Step** runs one model-selected action and stops. Sound plays during gameplay.
Changing map or difficulty reloads the game stopped. The default is map 6 on Hard.
Use **Assistance → Off · visible telemetry** to experiment without control aids; switching stops play without reloading the model.

Setup downloads the toolchain and verified LibreQuake assets into ignored `build/`;
game files are not included in the repo. Models download only on request and cache locally.
After initial setup, just run `npm run serve`.

## How it works

The goal is **SURVIVE**. Default priorities: avoid harm, get supplies, handle threats, then explore.
Reorder **Priorities** beside Decisions to change the prompt; reordering stops play.
Qwasm runs Quake in WebAssembly; a local decision model chooses short actions in a browser worker.
**Assistance on** uses engine telemetry, geometry/GPS, aim assistance, and tactical shortlisting.
**Off** uses HUD facts and coarse engine-labelled visible objects with fixed movement/look/fire
inputs—no probes, GPS memory, target tracking, or hazard vetoes. It can miss and walk into danger.
Neither mode is screen/audio perception or human-equivalent play. Use **Start at 1×** for real-time comparisons.

The five newest decision cards show the exact model input, response, and action probabilities.
Experimental: it can get stuck and cannot automatically jump or swim.

See [implementation details](docs/implementation.md) for the full design.
