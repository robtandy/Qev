import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "f56b5e71e4be8effede29bae1785a5306dcc0249";
const source = resolve(root, "build/qwasm");
const sdk = resolve(root, "build/tools/emsdk");
const output = resolve(root, "build/engine");
function run(command, args, cwd = root) {
  const r = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}
if (!existsSync(`${sdk}/emsdk_env.sh`)) throw new Error("Run npm run setup:engine first.");
mkdirSync(output, { recursive: true });
if (!existsSync(`${source}/.git`)) {
  run("git", ["init", source]);
  run("git", ["remote", "add", "origin", "https://github.com/GMH-Code/Qwasm.git"], source);
  run("git", ["fetch", "--depth", "1", "origin", revision], source);
  run("git", ["checkout", "--detach", "FETCH_HEAD"], source);
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
if (head !== revision) throw new Error("Unexpected build/qwasm revision; refusing to overwrite another checkout.");
// Only reset the generated source copy, never a user's fork or the project working tree.
const patched = ["quakedef.h", "sys_sdl.c", "cl_main.c", "cl_input.c", "host.c", "pr_edict.c"];
run("git", ["restore", "--source=HEAD", "--", ...patched.map((f) => `WinQuake/${f}`)], source);
run("git", ["apply", resolve(root, "engine/qwasm.patch")], source);
for (const file of ["qev_bridge.c", "qev_bridge.h"]) cpSync(resolve(root, "engine", file), resolve(source, "WinQuake", file));
// No --preload-file: proprietary game assets are supplied locally in the browser, never built in.
const flags = [
  "-O2", "-sUSE_SDL=2", "-sINITIAL_MEMORY=64MB", "-sSTACK_SIZE=2MB", "-sALLOW_MEMORY_GROWTH=1",
  "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createQevEngine", "-sENVIRONMENT=web",
  "-sFORCE_FILESYSTEM=1", "-sEXPORTED_FUNCTIONS=_main", "-sEXPORTED_RUNTIME_METHODS=FS,callMain,UTF8ToString,ccall",
  "-sINCOMING_MODULE_JS_API=canvas,noInitialRun,keyboardListeningElement,print,printErr,locateFile,onAbort",
  "-sEXIT_RUNTIME=0", "-lidbfs.js",
].join(" ");
const makefile = readFileSync(resolve(source, "WinQuake/Makefile.emscripten"), "utf8")
  .replace("OBJS := $(SRCS:.c=.o)", "SRCS += qev_bridge.c\nqev_bridge.o: CFLAGS += -fno-fast-math -Werror=implicit-function-declaration\nOBJS := $(SRCS:.c=.o)");
writeFileSync(resolve(source, "WinQuake/Makefile.qev"), makefile);
run("bash", ["-c", 'source "$1/emsdk_env.sh" >/dev/null 2>&1; exec make -f Makefile.qev -j4 all "TARGET=$2/qwasm.mjs" "LDFLAGS=$3"', "qev-build", sdk, output, flags], resolve(source, "WinQuake"));
cpSync(resolve(source, "gnu.txt"), resolve(output, "QWASM-LICENSE.txt"));
writeFileSync(resolve(output, "build.json"), JSON.stringify({ qwasm: revision, emscripten: "3.1.74", renderer: "software", assetsEmbedded: false }, null, 2) + "\n");
console.log(`Engine built in ${output}. No game assets were embedded.`);
