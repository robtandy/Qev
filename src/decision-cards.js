export const DECISION_CARD_LIMIT = 5;

/** Presentation only. Keep the detailed controller lifecycle untouched in exported records. */
export function decisionStatus(record) {
  if (!record || record.status === "scoring") return null; // No verdict before the response arrives.
  if (record.appliedAt || ["scored", "stepping", "acting", "executed", "replaced", "interrupted"].includes(record.status)) return "accepted";
  return "rejected";
}

export function latestDecisions(history) {
  return history.slice(-DECISION_CARD_LIMIT).reverse();
}

/** Read the actual request payload, never a reconstructed observation or unsent candidate prose. */
export function modelState(record) {
  const states = record.requests.map(request => request.state);
  return states.length === 1 ? states[0] : JSON.stringify(states, null, 2);
}

export function decisionView(record) {
  const status = decisionStatus(record);
  const choice = record.selectedIndex == null ? null : record.eligible[record.selectedIndex];
  const ticks = record.execution?.ticksApplied;
  const meta = [...(record.assistance ? [`aids ${record.assistance === "assisted" ? "on" : "off"}`] : []), `tick ${record.before.tick}${record.appliedAt ? ` → ${record.appliedAt.tick}` : ""}`];
  if (record.ms !== null) meta.push(`${Math.round(record.ms)} ms`);
  if (Number.isFinite(ticks)) meta.push(`${ticks}/${choice?.params.ticks ?? "?"} ticks`);
  return {
    status,
    action: choice?.choiceText || choice?.label || (status === null ? "Waiting for the model…" : "No action selected."),
    meta: meta.join(" · "),
    state: modelState(record),
  };
}

export function decisionOutcome(record) {
  const before = record.appliedAt || record.before, after = record.after;
  return {
    status: decisionStatus(record), mode: record.mode, assistance: record.assistance,
    observationPolicy: record.observationPolicy, controller: record.controller,
    objective: record.objective, priorityOrder: record.priorityOrder, objectives: record.objectives, offerPolicy: record.offerPolicy,
    observationTick: record.before.tick, appliedTick: record.appliedAt?.tick,
    ageTicksAtApply: record.ageTicksAtApply, ageMsAtApply: record.ageMsAtApply,
    observedTicksSinceApply: after?.epoch === before.epoch ? after.tick - before.tick : null,
    execution: record.execution, selectedAction: record.eligible[record.selectedIndex]?.id,
    steeringFrame: record.steering, explorationBefore: record.navigation, explorationAfter: record.navigationAfter,
    screenCues: record.visual,
    appliedGeometry: record.appliedGeometry, observation: record.before, appliedAt: record.appliedAt,
    after: after || "No final outcome recorded. Accepting a decision does not imply it has executed.",
    error: record.error,
  };
}

const json = (value) => JSON.stringify(value, null, 2);
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

/** Keyed cards preserve expanded details, payload scrolling, and focus as new entries arrive. */
export class DecisionCards {
  constructor(container, { onError = () => {} } = {}) {
    this.container = container;
    this.document = container.ownerDocument;
    this.cards = new Map();
    container.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-copy]");
      if (!button || !container.contains(button)) return;
      const card = button.closest(".decision-card");
      const payload = card.querySelector(`[data-payload="${button.dataset.copy}"]`);
      try {
        await navigator.clipboard.writeText(payload.textContent);
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy"; }, 1000);
      } catch (error) { onError(error); }
    });
  }
  element(tag, className = "", text) {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  create(record) {
    const root = this.element("li", "decision-card");
    root.dataset.decisionId = String(record.id);
    const details = this.element("details", "decision-details");
    const summary = this.element("summary", "decision-summary");
    summary.title = "Expand to inspect exact inputs, responses, and outcomes";
    const heading = this.element("span", "decision-heading");
    const number = this.element("span", "decision-number", `Decision #${record.id}`);
    const status = this.element("span", "decision-status");
    heading.append(number, status);
    const action = this.element("strong", "decision-action"), meta = this.element("span", "decision-meta");
    summary.append(heading, action, meta);
    const body = this.element("div", "decision-body");
    const error = this.element("p", "decision-error"), warning = this.element("p", "decision-warning");
    const candidates = this.element("ol", "candidates");
    candidates.setAttribute("aria-label", "Offered actions, probabilities, and controller filters");
    const payloads = {};
    for (const [key, title] of [["state", record.requests.length > 1 ? "States sent to model" : "State sent to model"], ["request", "Exact request"], ["response", "Exact response"], ["outcome", "Observation & outcome"]]) {
      const section = this.element("details", key === "state" ? "payload model-state" : "payload");
      section.dataset.section = key;
      const label = this.element("summary", "", title), copy = this.element("button", "", "Copy");
      copy.type = "button"; copy.dataset.copy = key;
      copy.setAttribute("aria-label", `Copy ${title.toLowerCase()} for decision ${record.id}`);
      const pre = this.element("pre"); pre.tabIndex = 0; pre.dataset.payload = key;
      payloads[key] = pre;
      section.append(label, copy, pre); body.append(section);
      if (key === "state") body.append(error, warning, candidates);
    }
    details.append(summary, body); root.append(details);
    return { root, status, action, meta, error, warning, candidates, payloads };
  }
  update(card, record) {
    const view = decisionView(record);
    card.root.setAttribute("aria-busy", String(view.status === null));
    card.status.hidden = view.status === null;
    card.status.className = `decision-status${view.status ? ` ${view.status}` : ""}`;
    setText(card.status, view.status === "accepted" ? "Accepted" : view.status === "rejected" ? "Rejected" : "");
    setText(card.action, view.action);
    setText(card.meta, view.meta);
    setText(card.payloads.state, view.state);
    card.error.hidden = !record.error; setText(card.error, record.error || "");
    card.warning.hidden = !record.warnings?.length; setText(card.warning, record.warnings?.join(" ") || "");
    // The text is never interpreted as HTML, and complete protocol payloads are never rewritten.
    if (card.requests !== record.requests) setText(card.payloads.request, json(record.requests));
    if (card.responses !== record.responses || card.lifecycle !== record.status) {
      setText(card.payloads.response, record.responses ? json(record.responses) : record.error ? `Error: ${record.error}` : view.status === null ? "Waiting for the model…" : "No response was received.");
    }
    setText(card.payloads.outcome, json(decisionOutcome(record)));
    if (card.ranking !== record.ranking || card.options !== record.candidates) {
      const rows = record.candidates.map((candidate) => {
        const index = record.eligible.findIndex((entry) => entry.id === candidate.id);
        const score = record.ranking.find((entry) => entry.index === index);
        const chosen = record.selectedIndex !== null && index === record.selectedIndex;
        const row = this.element("li", chosen ? "chosen" : !candidate.allowed ? "filtered" : "");
        const top = this.element("div", "candidate-top");
        top.append(this.element("span", "", `${chosen ? "→ " : ""}${candidate.label}`), this.element("b", "", score ? `${(score.probability * 100).toFixed(1)}%` : "—"));
        const text = candidate.reason || candidate.offerNote || (index >= 0 ? `${record.decisionFormat === "choice" ? `Request [0] · choice “${candidate.id}”` : `Request [${index}]`} · up to ${candidate.params.ticks} ticks · ${record.assistance === "unassisted" ? "relative inputs; no control aids" : "bounded aim/movement assistance"}` : "Not offered: action budget limit");
        row.append(top, this.element("small", "", text));
        return row;
      });
      card.candidates.replaceChildren(...rows);
    }
    Object.assign(card, { requests: record.requests, responses: record.responses, lifecycle: record.status, ranking: record.ranking, options: record.candidates });
  }
  render(history) {
    const records = latestDecisions(history), ids = new Set(records.map((record) => record.id));
    for (const [id, card] of this.cards) if (!ids.has(id)) { card.root.remove(); this.cards.delete(id); }
    if (!records.length) {
      if (!this.container.querySelector(".empty")) this.container.replaceChildren(this.element("li", "empty", "Choose a model above to load it, then Start or Step. Decisions will appear here."));
      return;
    }
    this.container.querySelector(".empty")?.remove();
    records.forEach((record, index) => {
      let card = this.cards.get(record.id);
      if (!card) { card = this.create(record); this.cards.set(record.id, card); }
      this.update(card, record);
      const current = this.container.children[index];
      if (current !== card.root) this.container.insertBefore(card.root, current || null);
    });
  }
}
