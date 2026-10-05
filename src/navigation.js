// Bounded, observed-only exploration memory. No BSP graph, hidden exits, or global actors.
export const CELL_SIZE = 64;
export const MAX_CELLS = 1024;
export const MAX_ROUTES = 2048;
const sector = (yaw) => ((Math.round(yaw / 45) % 8) + 8) % 8;
const cell = (position) => position.map((n) => Math.floor(n / CELL_SIZE)).join(",");
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const routeKey = (position, dx, dy) => `${cell(position)}:${sector(Math.atan2(dy, dx) * 180 / Math.PI)}`;
function bound(map, limit) { while (map.size > limit) map.delete(map.keys().next().value); }

export class ExplorationMemory {
  constructor() { this.reset(); }
  reset() {
    this.map = null; this.epoch = null; this.last = null;
    this.cells = new Map(); this.routes = new Map(); this.contacts = new Set();
    this.newAreaEvents = 0; this.newContacts = 0; this.actions = 0;
    this.noProgressActions = 0; this.stationaryScans = 0; this.travel = 0;
    this.lastProgressTick = 0; this.lastScanTick = -120; this.completed = false; this.goal = null;
  }
  observe(observation) {
    if (!observation.ready || !observation.player) return;
    const sameMap = this.map === (observation.map || "");
    const terminalOrTeleport = observation.completed || !observation.alive || observation.stopReason === "Player teleported.";
    if (!sameMap || (this.epoch !== observation.epoch && !terminalOrTeleport)) this.reset();
    if (this.epoch !== observation.epoch) this.goal = null;
    this.map = observation.map || ""; this.epoch = observation.epoch;
    this.completed = observation.completed === true;
    const position = observation.player.position, key = cell(position);
    let entry = this.cells.get(key);
    if (!entry) {
      entry = { key, entries: 0, looks: 0, lastTick: observation.tick };
      this.cells.set(key, entry); bound(this.cells, MAX_CELLS);
      this.newAreaEvents++; this.lastProgressTick = observation.tick; this.noProgressActions = 0;
    }
    if (!this.last || this.last.key !== key) entry.entries++;
    // A heading has been inspected, not proven empty: occluded space remains unknown.
    for (let i = 0; i < 8; i++) {
      const delta = ((i * 45 - observation.player.yaw + 540) % 360 + 360) % 360 - 180;
      if (Math.abs(delta) <= 45) entry.looks |= 1 << i;
    }
    entry.lastTick = observation.tick;
    if (this.last && this.last.epoch === observation.epoch && observation.tick > this.last.tick) {
      const moved = distance(this.last.position, position);
      if (moved < 256) this.travel += moved; // Teleports are not walked distance.
    }
    this.last = { key, position: [...position], tick: observation.tick, epoch: observation.epoch };
    if (this.completed || !observation.alive || (this.goal && distance(position, this.goal.position) <= 24)) this.goal = null;
    for (const actor of [...observation.enemies, ...observation.pickups]) {
      if (actor.visible !== true) continue;
      const id = `${actor.slot}:${actor.generation}`;
      if (!this.contacts.has(id)) { this.contacts.add(id); this.newContacts++; }
    }
    while (this.contacts.size > 512) this.contacts.delete(this.contacts.values().next().value);
  }
  summary(observation) {
    const entry = observation?.player ? this.cells.get(cell(observation.player.position)) : this.cells.get(this.last?.key);
    return {
      map: this.map, epoch: this.epoch, cellSize: CELL_SIZE, rememberedCells: this.cells.size,
      currentCellEntries: entry?.entries || 0, inspectedHeadings: entry ? [...Array(8)].filter((_, i) => entry.looks & (1 << i)).length : 0,
      newAreaEvents: this.newAreaEvents, newContacts: this.newContacts, actions: this.actions,
      noProgressActions: this.noProgressActions, stationaryScans: this.stationaryScans,
      recovery: this.stationaryScans >= 2 || this.noProgressActions >= 6,
      distanceMoved: Math.round(this.travel), lastProgressTick: this.lastProgressTick, lastScanTick: this.lastScanTick,
      // Legacy name: engine-confirmed level completion, not a survival score.
      goalComplete: this.completed, waypoint: this.goal ? { position: [...this.goal.position], label: this.goal.label } : null,
    };
  }
  route(position, endpoint, dx, dy) {
    const destination = this.cells.get(cell(endpoint));
    const edge = this.routes.get(routeKey(position, dx, dy));
    return {
      destinationVisited: !!destination, visits: destination?.entries || 0,
      sameCell: cell(endpoint) === cell(position), failures: edge?.failures || 0,
      coolingDown: !!edge && edge.failures >= 2 && this.actions < edge.retryAfter,
    };
  }
  inspected(position, yaw) {
    return !!(this.cells.get(cell(position))?.looks & (1 << sector(yaw)));
  }
  chosen(choice, geometry = choice.geometry) {
    if (choice.category === "exploration" && geometry?.end) {
      this.goal = { position: [...geometry.end], label: choice.label };
    }
  }
  outcome(choice, before, after, started, ticksApplied) {
    if (before.epoch !== after.epoch || !after.player) return;
    this.observe(after);
    if (ticksApplied !== null && ticksApplied <= 0) return;
    this.actions++;
    if (choice.id.startsWith("scan-")) this.lastScanTick = after.tick;
    const discovery = this.newAreaEvents > (started?.newAreaEvents ?? this.newAreaEvents) || this.newContacts > (started?.newContacts ?? this.newContacts);
    const gainedKey = (!before.player.silverKey && after.player.silverKey) || (!before.player.goldKey && after.player.goldKey);
    const moved = distance(before.player.position, after.player.position);
    this.noProgressActions = discovery || gainedKey ? 0 : this.noProgressActions + 1;
    this.stationaryScans = choice.id.startsWith("scan-") && moved < 16 && !discovery ? this.stationaryScans + 1 : 0;
    if (Math.hypot(choice.params.dx, choice.params.dy) > 0.001) {
      const key = routeKey(before.player.position, choice.params.dx, choice.params.dy);
      const entry = this.routes.get(key) || { failures: 0, attempts: 0, retryAfter: 0 };
      entry.attempts++;
      // Do not call a two-tick interruption or a stale response a failed walking route.
      if (moved < 8 && ticksApplied >= 6) {
        entry.failures++; entry.retryAfter = this.actions + 6;
        if (entry.failures >= 2) this.goal = null;
      } else if (moved >= 16) { entry.failures = 0; entry.retryAfter = 0; }
      this.routes.delete(key); this.routes.set(key, entry); bound(this.routes, MAX_ROUTES);
    }
  }
  inspect() {
    return { ...this.summary(), recentCells: [...this.cells.values()].slice(-32), failedRoutes: [...this.routes].filter(([, value]) => value.failures).slice(-16).map(([route, value]) => ({ route, ...value })) };
  }
}
