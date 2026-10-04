import { validateDifficulty } from "./engine.js";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Single-player death restarts the active level; never carries an old command into a new life. */
export class Respawner {
  constructor({ engine, agent, getMode, onState = () => {}, onResume = () => {}, delay = 750, wait = sleep }) {
    Object.assign(this, { engine, agent, getMode, onState, onResume, delay, wait });
    this.pending = null;
    this.enabled = true; // Diagnostic trial harnesses may suspend retries to measure one episode.
    this.lastDeathEpoch = null;
    this.count = 0;
  }
  cancelResume() { if (this.pending) this.pending.resume = false; }
  observe(snapshot) {
    if (!this.enabled || this.pending || !snapshot.ready || snapshot.alive || snapshot.completed || snapshot.epoch === this.lastDeathEpoch) return null;
    const job = { epoch: snapshot.epoch, map: snapshot.map, difficulty: snapshot.difficulty,
      mode: this.getMode(), resume: true };
    this.lastDeathEpoch = snapshot.epoch;
    this.pending = job;
    return this.run(job);
  }
  async run(job) {
    let resumedMode = "inspection", success = false;
    try {
      validateDifficulty(job.difficulty);
      this.onState("starting", job);
      this.agent.invalidate();
      const generation = this.agent.generation, model = this.agent.getModel();
      await this.wait(this.delay);
      const before = this.engine.snapshot();
      // A manual/external map transition must not be overwritten by a queued respawn.
      if (!before.ready || before.epoch !== job.epoch || before.alive || before.completed || before.map !== job.map) return false;
      this.onState("loading", job);
      await this.engine.loadMap(job.map, job.difficulty);
      const fresh = this.engine.snapshot();
      if (!fresh.ready || !fresh.alive || fresh.completed || fresh.epoch === job.epoch || fresh.map !== job.map || fresh.difficulty !== job.difficulty) throw new Error("Respawn did not produce a live player on the requested map and difficulty.");
      success = true; this.count++;
      if (job.mode === "auto" && job.resume && this.agent.busy) this.onState("waiting", job);
      // A worker call cannot be forcibly cancelled. Discard its old result before resuming Auto.
      while (job.mode === "auto" && job.resume && this.agent.busy && this.agent.generation === generation && this.agent.getModel() === model) await this.wait(25);
      const now = this.engine.snapshot();
      if (job.resume && this.agent.generation === generation && now.ready && now.alive && !now.completed && now.paused && now.epoch === fresh.epoch && now.map === job.map && now.difficulty === job.difficulty &&
          (job.mode !== "auto" || (model && this.agent.getModel() === model))) resumedMode = job.mode;
      return true;
    } catch (error) {
      // No reload storm if a map/load/respawn fails. A later manual restart gets a new epoch.
      try { this.lastDeathEpoch = this.engine.snapshot().epoch; } catch { /* exited WASM */ }
      throw error;
    } finally {
      if (this.pending === job) this.pending = null;
      this.onState("done", { ...job, success, resumedMode });
      if (success && resumedMode !== "inspection") this.onResume(resumedMode);
    }
  }
}
