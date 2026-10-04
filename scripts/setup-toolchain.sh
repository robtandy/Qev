#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/build/tools/emsdk"
VERSION=3.1.74
COMMIT=3d6d8ee910466516a53e665b86458faa81dae9ba
mkdir -p "$ROOT/build/tools"
if [ ! -d "$SDK/.git" ]; then
  git clone --depth 1 --branch "$VERSION" https://github.com/emscripten-core/emsdk.git "$SDK"
fi
if [ "$(git -C "$SDK" rev-parse HEAD)" != "$COMMIT" ]; then
  echo "Unexpected SDK checkout in $SDK; refusing to change it." >&2
  exit 1
fi
"$SDK/emsdk" install "$VERSION"
"$SDK/emsdk" activate "$VERSION"
printf '\nToolchain installed locally in %s (no shell profile changes).\n' "$SDK"
