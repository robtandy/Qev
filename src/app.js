import { Engine, DIFFICULTIES, DEFAULT_DIFFICULTY } from "./engine.js";
import { Agent } from "./agent.js";
import { Respawner } from "./respawn.js";
import { DecisionCards } from "./decision-cards.js";
import { Stepper } from "./stepper.js";
import { PRIMARY_OBJECTIVE, SURVIVAL_OBJECTIVES } from "./objective.js";
import { DEMO, DEMO_MAPS } from "./demo-manifest.js";
import { loadDemo } from "./demo.js";

const $ = (id) => document.getElementById(id);
const pageTitle = document.title;
const modelSelected = () => ["laya", "kev-0.8b"].includes($("model").value);
let engine = null, agent = null, model = null, snapshot = null, respawner = null, stepper = null;
let operation = "", loadingModel = null, autoToken = 0, auto = false, playMode = "inspection";
const engineLines = [];
let errorTimer;
const json = (value) => JSON.stringify(value, null, 2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(line) {
  engineLines.push(String(line));
  if (engineLines.length > 150) engineLines.shift();
}
function showError(error) {
  $("error").textContent = error?.message || String(error);
  $("error").hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { $("error").hidden = true; }, 12_000);
}
const decisionCards = new DecisionCards($("decisions"), { onError: showError });
function renderDecision() {
  decisionCards.render(agent?.history || []);
  updateControls();
}

// Use the actual space left after wrapped controls, not a small fixed canvas-height cap.
let layoutFrame = null;
function fitGame() {
  if (layoutFrame !== null) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = null;
    const screen = document.querySelector(".screen"), canvas = $("game");
    const top = screen.getBoundingClientRect().top + scrollY;
    const footerHeight = document.querySelector(".credits").getBoundingClientRect().height;
    const available = Math.max(160, innerHeight - top - footerHeight - 12);
    const height = `${Math.floor(Math.min(canvas.clientWidth * 3 / 4, available))}px`;
    const style = document.documentElement.style;
    if (style.getPropertyValue("--game-height") !== height) style.setProperty("--game-height", height);
  });
}
function updateControls() {
  const live = !!snapshot?.ready, alive = live && snapshot.alive && !snapshot.completed;
  const busy = !!agent?.busy || !!stepper?.busy || !!operation || !!snapshot?.remaining;
  const paused = live && snapshot.paused && !snapshot.remaining;
  const hasModel = !!(agent?.getModel() || model);
  $("pause").disabled = !engine;
  $("step").disabled = !alive || !paused || busy || !hasModel || auto;
  $("auto").disabled = !alive || busy || auto || !!loadingModel;
  $("auto").setAttribute("aria-pressed", String(auto));
  $("map").disabled = $("difficulty").disabled = !engine || !!operation;
  $("export").disabled = !agent?.history.length;
  $("load-model").disabled = !modelSelected() || !!loadingModel || !!operation;
  $("model").disabled = $("backend").disabled = !!loadingModel || !!operation;
  $("cancel-model").hidden = !loadingModel;
  if (operation) $("status").textContent = operation;
  else if (!live) $("status").textContent = engine ? "Waiting for the level…" : "Loading the demo automatically…";
  else if (snapshot.completed) $("status").textContent = "Level complete. Choose another map to load it stopped.";
  else if (!alive) $("status").textContent = "The player is dead. Choose a map to load a new episode.";
  else if (snapshot.remaining) $("status").textContent = `Stepping · ${snapshot.remaining} ticks left. Stop interrupts immediately.`;
  else if (auto) {
    const last = agent.history.findLast((r) => r.mode === "realtime" && r.ms !== null);
    $("status").textContent = `Running · ${PRIMARY_OBJECTIVE}${last ? ` · ${Math.round(last.ms)} ms / decision` : ""}. Stop to inspect.`;
  }
  else if (agent?.inflight) $("status").textContent = stepper?.busy ? "Choosing one action · world stopped. Stop cancels the step." : "Stopped · waiting for the previous model response to finish.";
  else if (!snapshot.paused) $("status").textContent = "Simulation running · P stops.";
  else $("status").textContent = hasModel ? "Stopped · Start runs continuously. Step runs one decision." : modelSelected() ? "Stopped · press Start to load the selected model." : "Stopped · choose Kev or Laya first.";
}
function poll() {
  if (!engine) return;
  try {
    snapshot = engine.snapshot();
    if (agent?.observeLive(snapshot)) snapshot = engine.snapshot();
    triggerRespawn(snapshot);
    $("clock").textContent = `${DIFFICULTIES[snapshot.difficulty] || "Loading"} · epoch ${snapshot.epoch} · tick ${snapshot.tick}`;
    if (snapshot.ready && !operation) $("asset-status").textContent = `${DEMO_MAPS.find(m => m.name === snapshot.map)?.label || snapshot.map} · ${DIFFICULTIES[snapshot.difficulty]}`;
    if (auto && (!snapshot.ready || !snapshot.alive || snapshot.completed || snapshot.paused || snapshot.controlSession !== agent.liveSession)) stop();
    updateControls();
  } catch (error) { stop(); showError(error); }
}
function triggerRespawn(observation) {
  if (!respawner || operation) return;
  const pending = respawner.observe(observation);
  if (pending) void pending.catch(error => { stop(); showError(error); });
}
function stop({ cancelResume = true } = {}) {
  if (cancelResume) respawner?.cancelResume();
  auto = false; autoToken++; playMode = "inspection";
  try {
    if (agent) { if (!stepper?.cancel()) agent.pause(); } else engine?.pause();
    if (engine) snapshot = engine.snapshot();
  } catch { snapshot = null; } // an aborted WASM instance cannot be queried again
  if (document.pointerLockElement) document.exitPointerLock();
  updateControls();
}
async function guard(fn) {
  try { $("error").hidden = true; await fn(); }
  catch (error) { stop(); showError(error); }
  finally { if (engine) poll(); else updateControls(); }
}
async function score() { await agent.score(); }
async function step() { return stepper.step(); }
function promptForModel() {
  const selected = modelSelected();
  $("model-required-title").textContent = selected ? "Load a model first" : "Choose a decision model";
  $("model-required-message").textContent = selected
    ? `${$("model").selectedOptions[0].textContent}. Load this model to enable play. If it is not cached, it will download first; inference runs on this device. The game stays stopped—press Start again when loading finishes.`
    : "Choose Kev or Laya in the Model dropdown first, then load it to enable play. Nothing has been downloaded.";
  $("confirm-model-prompt").textContent = selected ? "Load model" : "Choose model";
  if (!$("model-required").open) $("model-required").showModal();
}
async function runAuto() {
  if (auto) return;
  stop();
  if (!(agent?.getModel() || model)) {
    promptForModel();
    return;
  }
  agent.startLive();
  const token = ++autoToken;
  auto = true; playMode = "auto";
  updateControls();
  try {
    while (auto && token === autoToken) {
      const current = engine.snapshot();
      triggerRespawn(current); // Preserve Auto intent even if death occurs between UI polls.
      if (!auto || token !== autoToken) break;
      if (!current.ready || !current.alive || current.completed || current.paused || current.controlSession !== agent.liveSession) break;
      const started = performance.now();
      const record = await agent.score({ realtime: true });
      if (!auto || token !== autoToken) break;
      if (record) agent.applyLive();
      // One request at a time; no queue of obsolete frames. Yield even with an instant test model.
      await sleep(Math.max(0, 120 - (performance.now() - started)));
    }
  } finally { if (token === autoToken) stop(); }
}

async function loadSelectedMap() {
  if (!engine || operation) return;
  const map = $("map").value, difficulty = Number($("difficulty").value);
  stop(); agent.invalidate(); operation = "Loading the selected map · stopped…"; updateControls();
  try { await engine.loadMap(map, difficulty); }
  finally { operation = ""; }
}

async function startDemo() {
  operation = "Loading the LibreQuake demo…";
  $("asset-progress").hidden = false;
  let startingEngine = false;
  updateControls();
  try {
    const data = await loadDemo({ onProgress: ({ name, loaded, total }) => {
      $("asset-progress").max = total; $("asset-progress").value = loaded;
      $("asset-status").textContent = `Loading LibreQuake · ${Math.floor(loaded / total * 100)}% · ${name}…`;
    } });
    $("map").replaceChildren(...DEMO_MAPS.filter((entry) => data.maps.includes(entry.name)).map((entry) => new Option(entry.label, entry.name)));
    $("map").value = DEMO.map;
    startingEngine = true;
    operation = "Starting the Quake engine…";
    $("asset-progress").hidden = true;
    $("asset-status").textContent = operation;
    updateControls();
    engine = await Engine.start({ canvas: $("game"), data, map: DEMO.map, difficulty: Number($("difficulty").value), onLog: log });
    document.title = pageTitle; // SDL initializes its own window title; keep the site's branding.
    agent = new Agent({ engine, getModel: () => model, onChange: renderDecision });
    stepper = new Stepper(agent, updateControls);
    respawner = new Respawner({ engine, agent, getMode: () => playMode,
      onState(stage, job) {
        if (stage === "starting") {
          operation = "Respawning after death…";
          stop({ cancelResume: false });
          log(`Death in ${job.map} (${DIFFICULTIES[job.difficulty]}). Restarting the same level.`);
        } else if (stage === "loading") operation = "Respawning at the start of the level…";
        else if (stage === "waiting") operation = "Respawned. Waiting for the previous inference to finish; Stop cancels automatic resume.";
        else if (stage === "done") {
          operation = "";
          if (job.success) log(`Respawn #${respawner.count}: ${job.resumedMode === "inspection" ? "paused" : `resuming ${job.resumedMode}`}.`);
        }
        updateControls();
      },
      onResume(mode) {
        if (document.hidden) return;
        if (mode === "auto") void guard(runAuto);
      },
    });
    engine.speed(Number($("speed").value));
    $("screen-empty").hidden = true;
    $("map").disabled = false;
    $("asset-status").textContent = "Ready · stopped";
    renderDecision();
  } catch (error) {
    $("asset-status").textContent = `${startingEngine ? "Engine startup failed" : "Could not prepare the demo"}: ${error.message}${startingEngine ? " Reload the page before retrying." : ""}`;
    $("retry-demo").hidden = false;
    $("empty-hint").textContent = "See the setup message above, then reload the demo.";
    throw error;
  } finally { $("asset-progress").hidden = true; operation = ""; }
}
$("load-model").addEventListener("click", () => guard(async () => {
  if (!modelSelected()) { promptForModel(); return; }
  const name = $("model").value;
  stop(); agent?.invalidate();
  model?.dispose(); model = null;
  const abort = new AbortController(); loadingModel = abort;
  $("model-progress").hidden = false;
  $("model-status").textContent = "Preparing model…";
  $("model").disabled = $("backend").disabled = true;
  updateControls();
  try {
    const { Kevala } = await import("/vendor/kevala/index.js");
    model = await Kevala.load({
      model: name, backend: $("backend").value, signal: abort.signal,
      onProgress: (p) => {
        $("model-status").textContent = p.message || `${p.phase}${p.total ? ` · ${Math.round(p.loaded / p.total * 100)}%` : "…"}`;
        if (p.total) { $("model-progress").max = p.total; $("model-progress").value = p.loaded; }
        else $("model-progress").removeAttribute("value");
      },
    });
    $("model-status").textContent = `${name} ready · ${model.info.backend}${model.info.gpuUnavailable ? " · GPU unavailable" : ""}`;
    $("model-status").title = model.info.gpuUnavailable || "Inference stays on this device.";
    $("load-model").textContent = "Reload";
  } catch (error) {
    $("model-status").textContent = abort.signal.aborted ? "Model download cancelled. Load a model to enable Start or Step." : `Model load failed: ${error.message}`;
    if (!abort.signal.aborted) throw error;
  } finally {
    loadingModel = null;
    $("model-progress").hidden = true;
    $("model").disabled = $("backend").disabled = false;
    updateControls();
  }
}));
$("cancel-model").addEventListener("click", () => loadingModel?.abort());
$("cancel-model-prompt").addEventListener("click", () => $("model-required").close());
$("confirm-model-prompt").addEventListener("click", () => {
  $("model-required").close();
  if (!modelSelected()) { $("model").focus(); return; }
  // The prompt never downloads or queues gameplay until the user explicitly confirms.
  if (!(agent?.getModel() || model) && !loadingModel && !operation) $("load-model").click();
});
$("model").addEventListener("change", updateControls);
$("pause").addEventListener("click", stop);
$("step").addEventListener("click", () => guard(step));
$("auto").addEventListener("click", () => guard(runAuto));
for (const id of ["map", "difficulty"]) $(id).addEventListener("change", () => guard(loadSelectedMap));
$("speed").addEventListener("change", () => guard(async () => engine?.speed(Number($("speed").value))));
$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([json({ version: 4, decisionFormat: agent.decisionFormat, respawns: respawner?.count || 0, activeLevel: snapshot?.ready ? { map: snapshot.map, difficulty: snapshot.difficulty } : null, observation: snapshot, engineLog: engineLines.slice(), objective: PRIMARY_OBJECTIVE, objectives: SURVIVAL_OBJECTIVES, exploration: agent.navigation.inspect(), observationPolicy: "visibility-limited telemetry", controller: "200 units/s, 180 deg/s aim, 60 Hz; inspection 12 ticks; real-time leases up to 45 ticks / 1500 ms wall time; decisions at most 60 ticks / 1500 ms old", records: agent.history })], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "qev-trace.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
addEventListener("keydown", (event) => {
  if ($("model-required").open) return; // Let the dialog own focus and Escape.
  if (event.target.closest("input, select, textarea, button, summary, a") || event.ctrlKey || event.metaKey || event.altKey) return;
  let button;
  if (event.code === "KeyP" || event.code === "Escape") button = $("pause");
  if (snapshot?.paused && event.code === "KeyN") button = $("step");
  if (button && !button.disabled) {
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) button.click();
  }
}, { capture: true });
addEventListener("blur", () => engine && stop());
document.addEventListener("visibilitychange", () => { if (document.hidden && engine) stop(); });
const layoutObserver = new ResizeObserver(fitGame);
for (const selector of [".masthead", ".setup", ".playback", ".game-column", ".credits"]) layoutObserver.observe(document.querySelector(selector));
addEventListener("resize", fitGame);
setInterval(poll, 100);
$("difficulty").value = String(DEFAULT_DIFFICULTY);
$("model").value = "";
renderDecision();
fitGame();
// Diagnostic handles, not an externally supported API. Tests use the same engine/agent as the UI.
window.qev = { get engine() { return engine; }, get agent() { return agent; }, get model() { return model; }, get respawner() { return respawner; }, get playMode() { return playMode; }, get engineLog() { return engineLines.slice(); }, pause: stop, score, step };
void guard(startDemo);
