import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTrial } from "../scripts/compare-decisions.mjs";

function record(zBefore, zAfter) {
  return { status: "replaced", ms: 100, selectedIndex: 0, eligible: [{ category: "scan" }],
    appliedAt: { epoch: 1, player: { position: [0, 0, zBefore] } },
    after: { epoch: 1, player: { position: [0, 0, zAfter] } }, execution: { ticksApplied: 12 } };
}
function report(records) {
  return { map: "test", format: "choice", wallMs: 30000, start: { tick: 1 },
    end: { tick: 1801, alive: true, completed: false, player: { health: 100 } },
    exploration: { rememberedCells: 3, distanceMoved: 200 }, records };
}

test("trial summaries distinguish scans during falling from stationary scan streaks", () => {
  const summary = summarizeTrial(report([record(100, 60), record(60, 24), record(24, 24)]));
  assert.equal(summary.scanActions, 3);
  assert.equal(summary.scanInputTicks, 36);
  assert.equal(summary.longestScanStreak, 1);
  assert.equal(summary.rememberedCells, 3);
});

test("trial deadline cancellations are reported as discarded, not inferred to be stale", () => {
  const summary = summarizeTrial(report([{ status: "discarded", ms: 120 }]));
  assert.equal(summary.discarded, 1);
  assert.equal(summary.applied, 0);
  assert.equal(summary.stale, undefined);
  assert.equal(summary.completed, false);
});
