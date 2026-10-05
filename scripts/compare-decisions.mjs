// Invoked by browser-smoke --compare. Real model, identical saved offers for paired scoring;
// separate live episodes for behavioral observations (not deterministic, matched rollouts).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const round = (n) => n === null ? null : Math.round(n * 10) / 10;
export function summarizeTrial(report) {
  const applied = report.records.filter(r => r.appliedAt);
  const scans = applied.filter(r => r.eligible[r.selectedIndex].category === "scan");
  let current = 0, longestScanStreak = 0;
  for (const r of applied) {
    const end = r.after?.player?.position, start = r.appliedAt.player.position;
    const stationary = end && r.after.epoch === r.appliedAt.epoch && Math.hypot(...end.map((n, i) => n - start[i])) < 8;
    current = r.eligible[r.selectedIndex].category === "scan" && stationary ? current + 1 : 0;
    longestScanStreak = Math.max(current, longestScanStreak);
  }
  return {
    map: report.map, format: report.format, wallMs: round(report.wallMs), alive: report.end.alive, completed: report.end.completed,
    health: report.end.player.health, rememberedCells: report.exploration.rememberedCells, distanceMoved: report.exploration.distanceMoved,
    simulationTicks: report.end.tick - report.start.tick, decisions: report.records.length, applied: applied.length,
    discarded: report.records.filter(r => r.status === "discarded").length, // Includes the intentionally cancelled request at the trial deadline.
    medianInferenceMs: round(median(report.records.filter(r => r.ms !== null).map(r => r.ms))),
    scanActions: scans.length, scanInputTicks: scans.reduce((n, r) => n + (r.execution?.ticksApplied || 0), 0), longestScanStreak,
    tokenLimitWarnings: report.records.filter(r => r.warnings?.length).length,
  };
}

// Serialized into the real browser by CDP. Do not close over Node variables.
async function runTrial(map, format, durationMs) {
  const { Agent } = await import("/src/agent.js");
  qev.pause(); qev.agent.invalidate();
  const engine = qev.engine;
  await engine.loadMap(map); engine.speed(1);
  const retryDeaths = qev.respawner.enabled;
  qev.respawner.enabled = false; // A measured trial ends at death instead of silently becoming another episode.
  const records = new Map();
  const agent = new Agent({ engine, getModel: () => qev.model, decisionFormat: format,
    onChange: () => { if (agent.current) records.set(agent.current.id, agent.current); } });
  agent.observeLive(engine.snapshot());
  const start = engine.snapshot(), started = performance.now();
  agent.startLive();
  const observer = setInterval(() => agent.observeLive(engine.snapshot()), 100);
  const deadline = setTimeout(() => agent.pause(), durationMs);
  try {
    while (performance.now() - started < durationMs && agent.liveSession !== null) {
      agent.observeLive(engine.snapshot());
      const now = engine.snapshot();
      if (!now.ready || !now.alive || now.completed || now.paused || now.controlSession !== agent.liveSession) break;
      const began = performance.now();
      const record = await agent.score({ realtime: true });
      if (record && performance.now() - started < durationMs && agent.liveSession !== null) agent.applyLive();
      await new Promise(r => setTimeout(r, Math.max(0, 120 - (performance.now() - began))));
    }
  } finally {
    clearTimeout(deadline); clearInterval(observer); agent.pause(); qev.respawner.enabled = retryDeaths;
  }
  return { map, format, durationMs, wallMs: performance.now() - started, start, end: engine.snapshot(), exploration: agent.navigation.inspect(), records: [...records.values()] };
}

async function scorePairs(samples) {
  const { requestsFor, rankResponses } = await import("/src/decisions.js");
  qev.pause();
  const results = [];
  for (const [index, sample] of samples.entries()) {
    const requests = Object.fromEntries(["choice", "noul"].map(format => [format, requestsFor(sample.eligible, sample.sharedState, format)]));
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      // Alternate order to avoid always charging one format for the first/cold dispatch.
      for (const format of ((index + repeat) % 2 ? ["choice", "noul"] : ["noul", "choice"])) {
        const started = performance.now();
        const responses = await qev.model.decideMany(requests[format]);
        const ms = performance.now() - started;
        const ranking = rankResponses(responses, sample.eligible, format);
        runs.push({ format, repeat, ms, tokens: responses.reduce((n, r) => n + r.usage.input_tokens, 0),
          largestInput: Math.max(...responses.map(r => r.usage.input_tokens)), selected: ranking[0].id, ranking, responses });
      }
    }
    results.push({ id: sample.id, before: sample.before, eligible: sample.eligible, requests, runs });
  }
  return results;
}

async function promptStressCases() {
  const { prepareDecision } = await import("/src/decisions.js");
  const observation = { ready: true, alive: true, completed: false, epoch: 1, tick: 100,
    player: { health: 25, armor: 100, ammo: 100, weapon: "super_nailgun", silverKey: false, goldKey: false, position: [0, 0, 24], yaw: 0, pitch: 0, grounded: true },
    enemies: ["monster_shambler", "monster_shalrath", "monster_hell_knight"].map((kind, i) => ({ kind, slot: 101 + i, generation: 1, visible: true, bearingRight: i * 20 - 20, distance: 350, position: [100, i * 20, 24] })),
    pickups: ["silver_key", "gold_key", "mega_health"].map((kind, i) => ({ kind, slot: 201 + i, generation: 1, visible: true, bearingRight: i * 20 - 20, distance: 100, position: [100, i * 20, 24] })),
  };
  const memory = { epoch: 1, label: "Strafe left while tracking and firing at the nearest visible enemy", displacement: 100, damage: 12 };
  const navigation = { summary: () => ({ rememberedCells: 1024, currentCellEntries: 99, noProgressActions: 5, stationaryScans: 1, recovery: false }),
    route: () => ({ destinationVisited: true, sameCell: false, visits: 99, failures: 1 }), inspected: () => true };
  const probe = p => ({ blocked: false, supported: true, hazard: false, end: [p.dx * 30, p.dy * 30, 24], lineOfSightAtEndpoint: false });
  const variants = [
    { name: "", armor: 100, ammo: 100, kinds: ["silver_key", "gold_key", "mega_health"] },
    { name: "-supplies", armor: 0, ammo: 2, kinds: ["armor", "spikes", "mega_health"] },
    { name: "-empty-ammo", armor: 0, ammo: 0, kinds: ["armor", "spikes", "mega_health"] },
  ];
  return variants.flatMap(variant => [false, true].map(realtime => {
    const before = structuredClone(observation);
    before.player.armor = variant.armor; before.player.ammo = variant.ammo;
    before.pickups.forEach((pickup, i) => { pickup.kind = variant.kinds[i]; });
    const heldCandidate = realtime ? { id: "forward-left", category: "exploration", decisionId: 7,
      label: "Walk forward-left relative to the held course", params: { dx: 0.7071067811865476, dy: 0.7071067811865476, slot: -1, fire: false } } : null;
    const prepared = prepareDecision(before, probe, memory, { realtime, navigation, heldAction: heldCandidate?.label, heldCandidate });
    return { id: `synthetic-token-budget-${realtime ? "live" : "inspection"}${variant.name}`, before, eligible: prepared.eligible, sharedState: prepared.sharedState };
  }));
}

export async function compareDecisions({ evaluate, root }) {
  // Check the crowded-input ceiling first, before spending minutes on live episodes.
  const stress = await evaluate(`(${promptStressCases.toString()})()`);
  const stressResults = await evaluate(`(${scorePairs.toString()})(${JSON.stringify(stress)})`);
  await writeFile(resolve(root, "build/choice-token-budget.json"), JSON.stringify(stressResults, null, 2));
  for (const sample of stressResults) {
    const tokens = sample.runs.filter(r => r.format === "choice").map(r => r.tokens);
    console.log("Choice token budget:", sample.id, tokens);
    assert.ok(tokens.every(n => n < 512), "even crowded choice prompts must fit the token budget");
  }
  const reports = [], samples = [];
  for (const [index, map] of ["lq_e0m1", "lq_e0m2"].entries()) {
    for (const format of (index % 2 ? ["choice", "noul"] : ["noul", "choice"])) {
      const report = await evaluate(`(${runTrial.toString()})(${JSON.stringify(map)},${JSON.stringify(format)},30000)`);
      reports.push(report);
      await writeFile(resolve(root, `build/comparison-${map}-${format}.json`), JSON.stringify(report, null, 2));
      assert.ok(report.records.some(r => r.appliedAt), "each trial must execute actual model decisions");
      assert.equal(report.exploration.goalComplete, report.end.completed, "only the engine marks secondary level completion");
      console.log("Live format comparison:", summarizeTrial(report));
      const usable = report.records.filter(r => r.before.player.grounded && r.eligible.length > 1);
      for (const fraction of [0, 0.5, 0.95]) {
        const record = usable[Math.floor((usable.length - 1) * fraction)];
        const id = `${map}-${format}-${record?.id}`;
        if (record && !samples.some(s => s.id === id)) samples.push({ id, before: record.before, eligible: record.eligible, sharedState: record.sharedState });
      }
    }
  }
  // Label stress cases separately: token-budget checks, not fabricated gameplay observations.
  const paired = (await evaluate(`(${scorePairs.toString()})(${JSON.stringify(samples)})`)).concat(stressResults);
  const actual = paired.filter(r => !r.id.startsWith("synthetic-"));
  const inference = Object.fromEntries(["choice", "noul"].map(format => {
    const runs = actual.flatMap(s => s.runs.filter(r => r.format === format));
    return [format, { runs: runs.length, medianMs: round(median(runs.map(r => r.ms))), medianTokens: median(runs.map(r => r.tokens)),
      largestInput: Math.max(...runs.map(r => r.largestInput)), tokenLimitHits: runs.filter(r => r.largestInput >= 512).length }];
  }));
  const summary = {
    objective: "SURVIVE", model: await evaluate("qev.model.info"), liveTrialMs: 30000, pairedStates: actual.length,
    matchingChoices: actual.filter(s => s.runs.find(r => r.format === "choice").selected === s.runs.find(r => r.format === "noul").selected).length,
    inference, trials: reports.map(summarizeTrial),
    stress: paired.filter(r => r.id.startsWith("synthetic-")).map(r => ({ id: r.id, choiceTokens: r.runs.filter(x => x.format === "choice").map(x => x.tokens) })),
    caveats: ["Same saved observation and eligible actions for each paired inference; compact joint choice vs original per-candidate prose, not an isolated question-type ablation.",
      "Live trials are separate non-deterministic episodes, not identical replayed trajectories or a completion-rate benchmark.",
      "Survival is primary; cells/displacement are secondary exploration metrics, include gravity/inertia, and do not measure safety or success.",
      "Discarded includes intentional deadline cancellation; stationary-scan streaks exclude scans while falling/moving at least eight units."],
  };
  await writeFile(resolve(root, "build/decision-comparison.json"), JSON.stringify({ summary, paired }, null, 2));
  console.log("Paired format comparison:", JSON.stringify(summary, null, 2));
  assert.equal(inference.choice.tokenLimitHits, 0, "joint choice prompts must fit without reaching Laya's token limit");
  assert.ok(summary.stress.every(r => r.choiceTokens.every(n => n < 512)), "even crowded choice prompts must fit the token budget");
  return summary;
}
