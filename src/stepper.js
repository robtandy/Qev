import { assistanceOf } from "./assistance.js";

/** One stopped-world decision plus its bounded action. Stop cancels both phases. */
export class Stepper {
  constructor(agent, onChange = () => {}) {
    this.agent = agent;
    this.onChange = onChange;
    this.active = null;
  }
  get busy() { return this.active !== null; }
  cancel() {
    if (!this.active) return false;
    this.active = null;
    this.agent.invalidate(); // A late inspection reply must not start an action after Stop.
    this.onChange();
    return true;
  }
  async step() {
    const agent = this.agent, before = agent.engine.snapshot();
    if (this.busy || agent.busy) throw new Error("Wait for the current decision to finish.");
    if (!before.ready || !before.alive || before.completed || !before.paused || agent.liveSession !== null) throw new Error("Stop a live game before stepping.");
    const job = {};
    this.active = job;
    this.onChange();
    try {
      let record = agent.current;
      const fresh = record?.status === "scored" && record.mode === "inspection" &&
        record.before.epoch === before.epoch && record.before.tick === before.tick &&
        record.generation === agent.generation && agent.scoredModel === agent.getModel() && record.assistance === assistanceOf(before);
      if (!fresh) record = await agent.score();
      if (this.active !== job || !record) return null;
      // Agent.step independently rechecks world/model/generation freshness at application.
      return await agent.step();
    } finally {
      if (this.active === job) this.active = null;
      this.onChange();
    }
  }
}
