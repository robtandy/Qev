import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DECISION_CARD_LIMIT, decisionStatus, latestDecisions, decisionView, decisionOutcome, modelState } from "../src/decision-cards.js";

function record(overrides = {}) {
  const choice = { id: "forward", label: "Walk forward relative to the held course", choiceText: "Walk forward; face that direction.", params: { ticks: 45 } };
  return { id: 1, status: "scoring", mode: "realtime", decisionFormat: "choice", selectedIndex: null,
    eligible: [choice], candidates: [choice], ranking: [], model: { arch: "laya", backend: "webgpu" },
    ms: null, before: { epoch: 2, tick: 30, player: { health: 100, position: [0, 0, 24] } },
    requests: [{ state: "Goal: SURVIVE", questions: { action: { type: "choice", criteria: { forward: "Walk forward." } } } }],
    responses: null, appliedAt: null, after: null, error: null, ...overrides };
}

for (const status of ["scored", "stepping", "acting", "executed", "replaced", "interrupted"]) {
  test(`${status} is presented as accepted, without changing the lifecycle`, () => {
    const r = record({ status, selectedIndex: 0 });
    assert.equal(decisionStatus(r), "accepted");
    assert.equal(r.status, status);
  });
}
for (const status of ["rejected", "discarded", "cancelled", "error", "unknown-status"]) {
  test(`${status} without an applied action is presented as rejected`, () => {
    const r = record({ status });
    assert.equal(decisionStatus(r), "rejected");
    assert.equal(r.status, status);
  });
}

test("an in-flight request does not get a premature verdict or a third status label", () => {
  const r = record();
  assert.equal(decisionStatus(r), null);
  assert.equal(decisionStatus(null), null);
  assert.equal(decisionView(r).status, null);
  assert.match(decisionView(r).action, /Waiting for the model/);
  assert.equal(decisionView(r).meta, "tick 30");
});

test("once applied, a command remains accepted even if later interrupted or cancelled", () => {
  for (const status of ["replaced", "interrupted", "cancelled", "error"]) {
    assert.equal(decisionStatus(record({ status, appliedAt: { epoch: 2, tick: 31 } })), "accepted");
  }
});

test("only the five latest records are returned, newest first, without truncating history", () => {
  const history = Object.freeze(Array.from({ length: 50 }, (_, id) => Object.freeze({ id: id + 1 })));
  const latest = latestDecisions(history);
  assert.equal(DECISION_CARD_LIMIT, 5);
  assert.deepEqual(latest.map(r => r.id), [50, 49, 48, 47, 46]);
  assert.equal(latest[0], history[49]);
  assert.equal(history.length, 50);
  assert.equal(history[0].id, 1);
  assert.deepEqual(latestDecisions([]), []);
  assert.deepEqual(latestDecisions(history.slice(0, 2)).map(r => r.id), [2, 1]);
});

test("new decisions push older cards down and evict only the sixth", () => {
  const history = Array.from({ length: 5 }, (_, id) => ({ id: id + 1 }));
  assert.deepEqual(latestDecisions(history).map(r => r.id), [5, 4, 3, 2, 1]);
  history.push({ id: 6 });
  assert.deepEqual(latestDecisions(history).map(r => r.id), [6, 5, 4, 3, 2]);
});

test("accepted inspection decisions do not imply their action has already executed", () => {
  const r = record({ status: "scored", mode: "inspection", selectedIndex: 0, ms: 123.8 });
  const view = decisionView(r);
  assert.equal(view.status, "accepted");
  assert.equal(view.meta, "tick 30 · 124 ms");
  assert.equal(Object.hasOwn(view, "note"), false);
  assert.equal(decisionOutcome(r).appliedAt, null);
  assert.match(decisionOutcome(r).after, /does not imply it has executed/);
});

test("replaced commands show their actual input ticks, including zero", () => {
  for (const ticksApplied of [0, 9, 30]) {
    const r = record({ status: "replaced", selectedIndex: 0, appliedAt: { epoch: 2, tick: 39 }, ms: 145, execution: { ticksApplied } });
    const view = decisionView(r);
    assert.equal(view.status, "accepted");
    assert.equal(view.meta, `tick 30 → 39 · 145 ms · ${ticksApplied}/45 ticks`);
    assert.doesNotMatch(view.meta, /replaced|executed|acting/);
    assert.equal(decisionOutcome(r).execution.ticksApplied, ticksApplied);
  }
});

test("the card presents the selected candidate, not a guessed maximum from rounded scores", () => {
  const r = record({ status: "scored", selectedIndex: 1 });
  r.eligible.push({ id: "left", label: "Walk left", choiceText: "Walk left; face that direction.", params: { ticks: 45 } });
  r.ranking = [{ index: 0, probability: .5 }, { index: 1, probability: .5 }];
  assert.equal(decisionView(r).action, "Walk left; face that direction.");
  assert.equal(decisionOutcome(r).selectedAction, "left");
});

test("presentation preserves raw protocol payloads, errors, and internal lifecycle for export", () => {
  const r = record({ status: "rejected", selectedIndex: 0, error: "The route changed.",
    responses: [{ answers: { action: { choice: "forward", probabilities: { forward: 1 } } }, extra: '<img src=x onerror="window.injected=true">', raw: .123456789 }] });
  const before = JSON.stringify(r);
  decisionView(r); decisionOutcome(r); latestDecisions([r]);
  assert.equal(JSON.stringify(r), before);
  assert.equal(decisionOutcome(r).error, "The route changed.");
});

test("the state panel uses the exact submitted state, not reconstructed or unsent text", () => {
  const state = 'Goal: SURVIVE\n  Preserve spacing, Ω, and <img src=x onerror="window.injected=true">.';
  const r = record({ requests: [{ state }], sharedState: "UNSENT_SHARED_STATE" });
  r.candidates[0].state = "UNSENT_BASELINE_PROSE";
  const before = JSON.stringify(r);
  assert.equal(modelState(r), state);
  assert.equal(decisionView(r).state, state);
  assert.equal(JSON.stringify(r), before);
});

test("a baseline batch exposes every actual state in request order, not just the first", () => {
  const r = record({ decisionFormat: "noul", requests: [{ state: "First action's state\nA" }, { state: "Second action's state\nB" }] });
  assert.deepEqual(JSON.parse(modelState(r)), r.requests.map(request => request.state));
  assert.equal(modelState(record({ requests: [] })), "[]");
});

test("the steel wordmark is self-contained vector artwork, not a font or remote image", () => {
  const svg = readFileSync(new URL("../public/brand/qev-logo.svg", import.meta.url), "utf8");
  assert.match(svg, /<title id="qev-title">QEV — Quad-forged steel<\/title>/);
  assert.match(svg, /viewBox="0 0 1200 560"/);
  assert.match(svg, /id="qev-letters"/);
  assert.doesNotMatch(svg, /<(?:script|image|foreignObject|text)\b|(?:href|src)="(?:https?:|data:|\/\/)/i);
});

test("the HTML keeps the card feed and compact controls without the old game panels", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<ol id="decisions"/);
  assert.match(html, /Last 5 · newest first/);
  const masthead = html.match(/<header class="masthead">([\s\S]*?)<\/header>/)[1];
  assert.match(masthead, /<img class="brand-logo" src="\/brand\/qev-logo\.svg" width="120" height="56" alt="QEV">/);
  assert.match(masthead, /<h1>quake played by a local decision model<\/h1>/);
  assert.match(html, /<title>QEV - quake played by a local decision model<\/title>/);
  assert.doesNotMatch(masthead, /class="mark"|qev-logo-bronze/);
  assert.match(masthead, /id="repo-link" href="https:\/\/github\.com\/robtandy\/Qev"/);
  const xLink = masthead.match(/<a id="x-post-link"[^>]*>𝕏<\/a>/)[0];
  assert.match(xLink, /aria-disabled="true"/);
  assert.doesNotMatch(xLink, /href=/);
  assert.doesNotMatch(masthead, /kevala|Local experiment|software renderer|class="badge"/i);
  assert.doesNotMatch(html, /id="(?:history|human|stats|health|armor|weapon|threats|navigation-status|navigation|observation|engine-log|game-state)"/);
  assert.doesNotMatch(html, /Play yourself|class="screen-label"|id="(?:restart|score|frame)"/);
  const selector = html.match(/<select id="model"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(selector, /^<option value="" disabled selected>Choose a decision model<\/option>/);
  assert.match(selector, /value="laya"/);
  assert.match(selector, /value="kev-0.8b"/);
  const footer = html.match(/<footer class="credits"[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /Thanks to:/);
  assert.deepEqual([...footer.matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)].map(m => m[1]), ["kev", "laya", "kevala", "qwasm", "libre quake"]);
  const controls = html.match(/<div class="controls">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...controls.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(m => m[1]), ["Start", "Stop", "Step"]);
});
