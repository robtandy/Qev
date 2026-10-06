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

Setup downloads the toolchain and verified LibreQuake assets into ignored `build/`;
game files are not included in the repo. Models download only on request and cache locally.
After initial setup, just run `npm run serve`.

## How it works

The goal is **SURVIVE**. Default priorities: avoid harm, get supplies, handle threats, then explore.
Reorder **Priorities** beside Decisions to change the model's prompt. Reordering stops play;
safety checks and the action shortlist stay fixed.
Qwasm runs Quake in WebAssembly. A decision model chooses short actions in a browser worker
using visible game state and exploration memory—not screenshots or hidden map data.
Qev revalidates each choice and applies bounded movement, aiming, and firing while the game
keeps running between responses.

The five newest decision cards show the exact model input, response, and action probabilities.
Experimental: it can get stuck and cannot automatically jump or swim.

See [implementation details](docs/implementation.md) for the full design.
