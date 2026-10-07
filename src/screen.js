/** Renderer-assisted segmentation, NOT RGB-only vision or metric depth estimation.
 * Only 2D visible extents/counts and labels enter here. No engine IDs, pose or range.
 */
export const SCREEN_SOURCE = "renderer-visible-pixels";
const MAX_SAMPLES = 8, MAX_AGE_TICKS = 45, MIN_SAMPLE_TICKS = 4;
const unit = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const sameViewport = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
const readable = kind => kind === "monster_army" ? "armed grunt" : kind.replace(/^monster_|^weapon_/, "").replaceAll("_", " ");
const round = n => Math.round(n * 1000) / 1000;

export function screenFrame(observation) {
  const s = observation.screen;
  const unknown = { source: SCREEN_SOURCE, available: false, entities: [] };
  if (!observation.ready || !observation.alive || observation.completed || s?.source !== SCREEN_SOURCE || s.available !== true ||
      !integer(s.frame) || s.frame < 1 || !integer(s.tick) || s.tick !== observation.tick || !integer(observation.epoch) ||
      !Array.isArray(s.viewport) || s.viewport.length !== 4 || !s.viewport.every(integer) || s.viewport[2] < 1 || s.viewport[3] < 1 ||
      s.viewport[2] * s.viewport[3] > 1280 * 1024 || typeof s.distorted !== "boolean") return unknown;
  const entities = [];
  for (const [group, list] of [["enemy", observation.enemies], ["pickup", observation.pickups]]) {
    for (const e of (Array.isArray(list) ? list : []).slice(0, 3)) {
      const p = e.screen, b = p?.bounds;
      if (e.visible !== true || typeof e.kind !== "string" || !/^[a-zA-Z0-9_]{1,64}$/.test(e.kind) ||
          !Array.isArray(b) || b.length !== 4 || !b.every(unit) || b[2] <= b[0] || b[3] <= b[1] ||
          !integer(p.pixels) || p.pixels < 1 || p.pixels > s.viewport[2] * s.viewport[3] ||
          typeof p.aimOverlap !== "boolean" || typeof p.clipped !== "boolean" || !integer(p.sameKindCount) || p.sameKindCount < 1) continue;
      const width = b[2] - b[0], height = b[3] - b[1];
      // Bounds are rounded by the native JSON serializer; allow one pixel of rounding.
      if (p.pixels > (width * s.viewport[2] + 1) * (height * s.viewport[3] + 1) ||
          (p.aimOverlap && !(b[0] <= 0.5 && b[2] >= 0.5 && b[1] <= 0.5 && b[3] >= 0.5))) continue;
      entities.push({ group, kind: e.kind, bounds: b.slice(), pixels: p.pixels, width, height,
        x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2,
        aimOverlap: p.aimOverlap, clipped: p.clipped, sameKindCount: p.sameKindCount });
    }
  }
  return { source: SCREEN_SOURCE, available: true, epoch: observation.epoch, frame: s.frame, tick: s.tick,
    viewport: s.viewport.slice(), distorted: s.distorted, entities };
}

function trend(entity, current, history) {
  const unknown = { trend: "uncertain", evidence: [] };
  const usable = e => e && e.sameKindCount === 1 && !e.clipped && e.pixels >= 24 && e.height >= 0.025;
  if (current.distorted || !usable(entity)) return unknown;
  const samples = [{ frame: current.frame, tick: current.tick, entity }];
  for (const past of history.slice().reverse()) {
    if (past.tick >= current.tick) continue;
    if (current.tick - past.tick > MAX_AGE_TICKS || past.epoch !== current.epoch || past.distorted || !sameViewport(past.viewport, current.viewport)) break;
    const matches = past.entities.filter(e => e.group === entity.group && e.kind === entity.kind);
    if (matches.length !== 1 || !usable(matches[0])) break;
    const e = matches[0], newer = samples.at(-1).entity;
    const fill = o => o.pixels / (o.width * o.height);
    // Not a persistent identity: stop at loss, duplicates, large image motion,
    // changing silhouette proportions/fill, clipping or a gap. Do not bridge occlusion.
    if (Math.hypot(e.x - newer.x, e.y - newer.y) > 0.08 ||
        Math.abs(Math.log((e.width / e.height) / (newer.width / newer.height))) > 0.2 ||
        Math.abs(Math.log(fill(e) / fill(newer))) > 0.3) break;
    samples.push({ frame: past.frame, tick: past.tick, entity: e });
  }
  if (samples.length < 3 || current.tick - samples.at(-1).tick < 12) return unknown;
  const earlier = samples.at(-1).entity, dh = entity.height / earlier.height, dw = entity.width / earlier.width;
  const monotone = (up) => samples.slice(1).every((s, i) => up
    ? samples[i].entity.height >= s.entity.height * 0.98 && samples[i].entity.width >= s.entity.width * 0.97
    : samples[i].entity.height <= s.entity.height * 1.02 && samples[i].entity.width <= s.entity.width * 1.03);
  const stable = samples.every(s => Math.abs(Math.log(s.entity.height / entity.height)) < 0.07 && Math.abs(Math.log(s.entity.width / entity.width)) < 0.12);
  const value = dh >= 1.15 && dw >= 1.1 && monotone(true) ? "growing"
    : dh <= 1 / 1.15 && dw <= 1 / 1.1 && monotone(false) ? "shrinking" : stable ? "steady" : "uncertain";
  return { trend: value, heightChange: round(dh - 1), evidence: samples.reverse().map(s => ({ frame: s.frame, tick: s.tick,
    bounds: s.entity.bounds.slice(), pixels: s.entity.pixels })) };
}

export function screenCues(observation, history = []) {
  const frame = screenFrame(observation);
  return { ...frame, entities: frame.entities.map(e => ({ ...e, ...trend(e, frame, history) })) };
}

/** At most eight short-lived image samples, never a map or stable actor identity. */
export class ScreenMemory {
  constructor() { this.reset(); }
  reset() { this.samples = []; this.latest = null; }
  observe(observation) {
    const now = screenFrame(observation);
    if (!now.available) { this.reset(); return; }
    const previous = this.latest;
    if (previous && (now.epoch !== previous.epoch || now.frame < previous.frame || now.tick < previous.tick ||
        now.tick - previous.tick > MAX_AGE_TICKS || now.distorted !== previous.distorted || !sameViewport(now.viewport, previous.viewport))) this.reset();
    if (this.latest?.frame === now.frame) return;
    const signature = f => f.entities.map(e => `${e.group}:${e.kind}:${e.sameKindCount}:${e.clipped}`).sort().join("|");
    // Even a brief observed disappearance between regular samples breaks continuity.
    if (this.latest && signature(this.latest) !== signature(now)) this.samples = [];
    this.latest = now;
    this.samples = this.samples.filter(s => now.tick - s.tick <= MAX_AGE_TICKS);
    if (!this.samples.length || now.tick - this.samples.at(-1).tick >= MIN_SAMPLE_TICKS) this.samples.push(now);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }
  describe(observation) { return screenCues(observation, this.samples); }
}

const percent = n => Number((n * 100).toFixed(1));
export function describeScreenEntity(e) {
  const horizontal = e.bounds[2] < 0.5 ? "left" : e.bounds[0] > 0.5 ? "right" : "center";
  const vertical = e.bounds[3] < 0.5 ? "above" : e.bounds[1] > 0.5 ? "below" : "level";
  const size = e.height < 0.04 ? "tiny" : e.height < 0.12 ? "small" : e.height < 0.3 ? "medium" : "large";
  return `${readable(e.kind)} ${horizontal}/${vertical} (${Math.round(e.x * 100)},${Math.round(e.y * 100)}), ${size} h${percent(e.height)}%, aim ${e.aimOverlap ? "on" : "off"}${e.clipped ? ", edge-cut" : ""}${e.trend !== "uncertain" ? `, ${e.trend}` : ""}`;
}
