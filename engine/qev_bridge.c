/* SPDX-License-Identifier: GPL-2.0-or-later
 * Qev bridge for the Quake/Qwasm engine, 2026-10-04. No game data is embedded.
 * See COPYING and README.md for license, source, and modification notices.
 */
#include "quakedef.h"
#include <emscripten/emscripten.h>
#include <SDL.h>
#include <ctype.h>

#define QEV_DT (1.0 / 60.0)
#define QEV_SPEED 200.0f
#define QEV_TURN 180.0f
#define QEV_MAX_SEEN 3
#define QEV_LIVE_TICKS 45
#define QEV_MAX_AGE 60

static int epoch = 1, tick = 0, paused = 1, owned = 1, booting = 1;
static int remaining = 0, lease = 0, target_slot = -1, target_generation = 0, firing = 0;
static int control_session = 0, action_serial = 0, action_ticks = 0;
static int generations[MAX_EDICTS];
static const char *stop_reason = NULL;
static float move_x = 0, move_y = 0, aim_yaw = 0, aim_pitch = 0, speed_scale = 1;
static double last_wall = 0, accumulator = 0, lease_deadline = 0;
static char json[32768];
static size_t used;

static int ready(void) {
    return host_initialized && sv.active && svs.maxclients == 1 &&
        cls.state == ca_connected && cls.signon == SIGNONS && cl.movemessages >= 2 && sv.num_edicts > 1;
}
static edict_t *player(void) { return EDICT_NUM(1); }
static float length3(vec3_t v) { return sqrtf(DotProduct(v, v)); }
static float clampf(float x, float lo, float hi) { return x < lo ? lo : x > hi ? hi : x; }
static float angle_delta(float a, float b) {
    float d = fmodf(a - b + 540.0f, 360.0f) - 180.0f;
    return d < -180 ? d + 360 : d;
}
static void append(const char *format, ...) {
    int n;
    va_list args;
    if (used >= sizeof(json) - 1) return;
    va_start(args, format);
    n = vsnprintf(json + used, sizeof(json) - used, format, args);
    va_end(args);
    if (n > 0) used += (size_t)n < sizeof(json) - used ? (size_t)n : sizeof(json) - used - 1;
}
static void quoted(const char *s) {
    const unsigned char *p = (const unsigned char *)s;
    append("\"");
    for (; *p; p++) {
        if (*p == '"' || *p == '\\') append("\\%c", *p);
        else if (*p < 32 || *p >= 127) append("\\u%04x", *p);
        else append("%c", *p);
    }
    append("\"");
}
static void vector_json(vec3_t v) { append("[%.3f,%.3f,%.3f]", v[0], v[1], v[2]); }
static void eye_at(vec3_t origin, vec3_t out) { VectorAdd(origin, player()->v.view_ofs, out); }
static void center(edict_t *e, vec3_t out) {
    int i;
    for (i = 0; i < 3; i++) out[i] = e->v.origin[i] + (e->v.mins[i] + e->v.maxs[i]) * 0.5f;
}
static int has_los(vec3_t origin, edict_t *e) {
    vec3_t eye, dest;
    trace_t tr;
    eye_at(origin, eye);
    center(e, dest);
    tr = SV_Move(eye, vec3_origin, vec3_origin, dest, MOVE_NORMAL, player());
    return !tr.startsolid && !tr.allsolid && (tr.fraction >= 0.999f || tr.ent == e);
}
/* Deliberately narrower than the default view: 90 degrees horizontal, 60 vertical. */
static int visible(edict_t *e) {
    vec3_t eye, dest, d;
    float yaw, pitch, distance;
    if (e->free || !e->v.modelindex) return 0;
    eye_at(player()->v.origin, eye);
    center(e, dest);
    VectorSubtract(dest, eye, d);
    distance = length3(d);
    if (distance > 1024 || distance < 1) return 0;
    yaw = atan2f(d[1], d[0]) * 180 / M_PI;
    pitch = -atan2f(d[2], sqrtf(d[0]*d[0] + d[1]*d[1])) * 180 / M_PI;
    return fabsf(angle_delta(yaw, cl.viewangles[YAW])) <= 45 &&
        fabsf(angle_delta(pitch, cl.viewangles[PITCH])) <= 30 && has_los(player()->v.origin, e);
}
static const char *entity_kind(edict_t *e, int *threat) {
    const char *name = pr_strings + e->v.classname;
    *threat = !strncmp(name, "monster_", 8);
    if (*threat) {
        /* Corpse filtering only; never export enemy health or internal AI goals. */
        if (e->v.deadflag != DEAD_NO || e->v.solid == SOLID_NOT) return NULL;
        return name;
    }
    if (!strncmp(name, "item_health", 11)) return ((int)e->v.spawnflags & 2) ? "mega_health" : "health";
    if (!strncmp(name, "item_armor", 10)) return "armor";
    if (!strcmp(name, "item_key1")) return "silver_key";
    if (!strcmp(name, "item_key2")) return "gold_key";
    if (!strncmp(name, "item_shells", 11) || !strncmp(name, "item_spikes", 11) ||
        !strncmp(name, "item_rockets", 12) || !strncmp(name, "item_cells", 10)) return name + 5;
    if (!strncmp(name, "weapon_", 7)) return name;
    return NULL;
}
static edict_t *valid_target(int slot, int generation) {
    edict_t *e;
    int threat;
    if (!ready() || slot <= 1 || slot >= sv.num_edicts || slot >= MAX_EDICTS ||
        generations[slot] != generation) return NULL;
    e = EDICT_NUM(slot);
    return entity_kind(e, &threat) && visible(e) ? e : NULL;
}
static void clear_action(void) {
    lease = 0; lease_deadline = 0; target_slot = -1; firing = 0; move_x = move_y = 0;
    Qev_ClearKeys();
}
static void cancel_action(const char *reason) {
    clear_action(); remaining = 0; stop_reason = reason;
}
static void audio_pause(int stop) {
    if (SDL_WasInit(SDL_INIT_AUDIO)) SDL_PauseAudio(stop);
}
void Qev_WorldChanged(void) {
    epoch++; control_session++; tick = 0; paused = owned = booting = 1;
    remaining = 0; accumulator = 0; stop_reason = NULL;
    memset(generations, 0, sizeof(generations));
    clear_action(); audio_pause(1); /* No old-world audio during loading/bootstrap. */
}
void Qev_EntityFreed(edict_t *e) {
    int slot = NUM_FOR_EDICT(e);
    if (slot >= 0 && slot < MAX_EDICTS) generations[slot]++;
    if (slot == target_slot) cancel_action("Selected target was removed.");
}
int Qev_OwnsInput(void) { return owned; }
void Qev_PreRender(void) {
    if (owned && cls.signon == SIGNONS) {
        /* Do not freeze the startup console half-open over the first game observation. */
        scr_con_current = 0;
        Con_ClearNotify();
    }
}

typedef struct { int blocked, supported, hazard, contact, required_key, locked; vec3_t end; } probe_t;
/* Only a surface actually hit by a local hull probe; never enumerate hidden doors/exits.
   Standard touch-operated doors/buttons must be approachable, rather than treated as walls. */
static int touch_surface(edict_t *e, probe_t *out) {
    const char *name;
    if (!e || e->free || e->v.health > 0) return 0; /* Shot-operated surfaces are not touch controls. */
    name = pr_strings + e->v.classname;
    if (!strcmp(name, "func_door")) out->contact = 1;
    else if (!strcmp(name, "func_button")) out->contact = 2;
    else return 0;
    out->required_key = (int)e->v.items & (IT_KEY1 | IT_KEY2);
    out->locked = !!(out->required_key & ~(int)player()->v.items);
    return 1;
}
/* Conservative local swept-hull/support probes, not an enemy/physics rollout. */
static probe_t probe(float dx, float dy, float distance) {
    probe_t out;
    vec3_t start, dest, raised, down, foot;
    edict_t *p = player();
    trace_t tr, floor;
    float length = sqrtf(dx*dx + dy*dy);
    int i, contents;
    memset(&out, 0, sizeof(out));
    out.supported = 1;
    VectorCopy(p->v.origin, out.end);
    if (length < 0.001f) { out.supported = !!((int)p->v.flags & FL_ONGROUND); return out; }
    dx /= length; dy /= length;
    for (i = 0; i < 5; i++) {
        VectorCopy(out.end, start);
        VectorCopy(start, dest);
        dest[0] += dx * distance / 5; dest[1] += dy * distance / 5;
        tr = SV_Move(start, p->v.mins, p->v.maxs, dest, MOVE_NORMAL, p);
        /* Match SV_FlyMove: startsolid alone does not block a trace that escapes
           into free space. Never ignore allsolid or a blocked endpoint. */
        if (tr.allsolid || tr.fraction < 0.999f) {
            if (!tr.startsolid && !tr.allsolid && touch_surface(tr.ent, &out)) {
                VectorCopy(tr.endpos, out.end);
                VectorCopy(out.end, raised); raised[2] += 1;
                VectorCopy(out.end, down); down[2] -= 24;
                floor = SV_Move(raised, p->v.mins, p->v.maxs, down, MOVE_NORMAL, p);
                out.supported = !floor.allsolid && !floor.startsolid && floor.fraction < 0.999f;
                VectorCopy(out.end, foot); foot[2] += p->v.mins[2] + 1;
                contents = SV_PointContents(foot);
                out.hazard = contents == CONTENTS_LAVA || contents == CONTENTS_SLIME;
                out.blocked = out.locked;
                return out;
            }
            /* SV_WalkMove uses the actual partial rise from SV_PushEntity under
               low ceilings, not an all-or-nothing 18-unit rise. Probe only: no mutation. */
            VectorCopy(start, raised); raised[2] += 18;
            tr = SV_Move(start, p->v.mins, p->v.maxs, raised, MOVE_NORMAL, p);
            if (tr.allsolid || tr.fraction <= 0) { out.blocked = 1; break; }
            VectorCopy(tr.endpos, raised);
            dest[2] = raised[2];
            tr = SV_Move(raised, p->v.mins, p->v.maxs, dest, MOVE_NORMAL, p);
            if (tr.allsolid || tr.fraction < 0.999f) { out.blocked = 1; break; }
        }
        VectorCopy(dest, down); down[2] -= 24;
        floor = SV_Move(dest, p->v.mins, p->v.maxs, down, MOVE_NORMAL, p);
        if (floor.allsolid || floor.startsolid || floor.fraction >= 0.999f) { out.supported = 0; break; }
        VectorCopy(floor.endpos, out.end);
        VectorCopy(out.end, foot); foot[2] += p->v.mins[2] + 1;
        contents = SV_PointContents(foot);
        if (contents == CONTENTS_LAVA || contents == CONTENTS_SLIME) { out.hazard = contents; break; }
    }
    return out;
}
static const char *weapon_name(int weapon) {
    switch (weapon) {
        case IT_SHOTGUN: return "shotgun";
        case IT_SUPER_SHOTGUN: return "double shotgun";
        case IT_NAILGUN: return "nailgun";
        case IT_SUPER_NAILGUN: return "super nailgun";
        case IT_GRENADE_LAUNCHER: return "grenade launcher";
        case IT_ROCKET_LAUNCHER: return "rocket launcher";
        case IT_LIGHTNING: return "lightning";
        default: return "axe";
    }
}

typedef struct { int slot; float distance; const char *kind; } seen_t;
static void insert_seen(seen_t *list, int *count, int slot, float distance, const char *kind) {
    int pos = 0, i;
    while (pos < *count && list[pos].distance <= distance) pos++;
    if (pos >= QEV_MAX_SEEN) return;
    if (*count < QEV_MAX_SEEN) (*count)++;
    for (i = *count - 1; i > pos; i--) list[i] = list[i - 1];
    list[pos].slot = slot; list[pos].distance = distance; list[pos].kind = kind;
}
static void seen_json(seen_t *list, int count) {
    int i;
    vec3_t pos, eye, d;
    append("[");
    eye_at(player()->v.origin, eye);
    for (i = 0; i < count; i++) {
        int slot = list[i].slot;
        center(EDICT_NUM(slot), pos);
        VectorSubtract(pos, eye, d);
        if (i) append(",");
        append("{\"slot\":%d,\"generation\":%d,\"kind\":", slot, generations[slot]);
        quoted(list[i].kind);
        append(",\"position\":"); vector_json(pos);
        append(",\"distance\":%.2f,\"bearingRight\":%.2f,\"visible\":true}", list[i].distance,
            -angle_delta(atan2f(d[1], d[0])*180/M_PI, cl.viewangles[YAW]));
    }
    append("]");
}
EMSCRIPTEN_KEEPALIVE const char *qev_snapshot(void) {
    seen_t enemies[QEV_MAX_SEEN], pickups[QEV_MAX_SEEN];
    int ne = 0, np = 0, i, threat;
    const char *kind;
    vec3_t d, pos;
    used = 0;
    append("{\"version\":1,\"epoch\":%d,\"tick\":%d,\"ready\":%s,\"paused\":%s,\"remaining\":%d,\"owned\":%s",
        epoch, tick, ready() ? "true" : "false", paused ? "true" : "false", remaining, owned ? "true" : "false");
    append(",\"controlSession\":%d,\"actionSerial\":%d,\"actionTicks\":%d,\"actionTicksLeft\":%d,\"stopReason\":", control_session, action_serial, action_ticks, lease);
    if (stop_reason) quoted(stop_reason); else append("null");
    if (!ready()) { append("}"); return json; }
    append(",\"map\":"); quoted(sv.name);
    append(",\"difficulty\":%d", current_skill);
    append(",\"alive\":%s,\"completed\":%s,\"player\":{\"health\":%d,\"armor\":%d,\"ammo\":%d,\"weapon\":",
        player()->v.health > 0 ? "true" : "false", cl.intermission ? "true" : "false", cl.stats[STAT_HEALTH], cl.stats[STAT_ARMOR], cl.stats[STAT_AMMO]);
    quoted(weapon_name(cl.stats[STAT_ACTIVEWEAPON]));
    append(",\"shells\":%d,\"nails\":%d,\"rockets\":%d,\"cells\":%d,\"position\":",
        cl.stats[STAT_SHELLS], cl.stats[STAT_NAILS], cl.stats[STAT_ROCKETS], cl.stats[STAT_CELLS]);
    vector_json(player()->v.origin);
    append(",\"yaw\":%.3f,\"pitch\":%.3f,\"grounded\":%s,\"inWater\":%s,\"silverKey\":%s,\"goldKey\":%s}",
        cl.viewangles[YAW], cl.viewangles[PITCH], cl.onground ? "true" : "false", cl.inwater ? "true" : "false",
        cl.items & IT_KEY1 ? "true" : "false", cl.items & IT_KEY2 ? "true" : "false");
    for (i = 2; i < sv.num_edicts && i < MAX_EDICTS; i++) {
        edict_t *e = EDICT_NUM(i);
        if (e->free || !e->v.modelindex) continue;
        kind = entity_kind(e, &threat);
        if (!kind || !visible(e)) continue;
        center(e, pos); VectorSubtract(pos, player()->v.origin, d);
        insert_seen(threat ? enemies : pickups, threat ? &ne : &np, i, length3(d), kind);
    }
    append(",\"enemies\":"); seen_json(enemies, ne);
    append(",\"pickups\":"); seen_json(pickups, np);
    append("}");
    return json;
}
EMSCRIPTEN_KEEPALIVE const char *qev_probe(float dx, float dy, int slot, int generation, int ticks) {
    probe_t p;
    edict_t *target;
    used = 0;
    if (!ready() || ticks < 1 || ticks > QEV_LIVE_TICKS || !isfinite(dx) || !isfinite(dy) || fabsf(dx) > 1.01f || fabsf(dy) > 1.01f) return "{\"error\":\"Invalid probe\"}";
    p = probe(dx, dy, QEV_SPEED * ticks * QEV_DT);
    target = valid_target(slot, generation);
    append("{\"blocked\":%s,\"supported\":%s,\"hazard\":%s,\"end\":",
        p.blocked ? "true" : "false", p.supported ? "true" : "false", p.hazard ? "true" : "false");
    vector_json(p.end);
    append(",\"contact\":%s,\"locked\":%s,\"requiredKey\":%s",
        p.contact == 1 ? "\"door\"" : p.contact == 2 ? "\"button\"" : "null", p.locked ? "true" : "false",
        p.required_key == (IT_KEY1 | IT_KEY2) ? "\"both keys\"" : p.required_key & IT_KEY1 ? "\"silver key\"" : p.required_key & IT_KEY2 ? "\"gold key\"" : "null");
    append(",\"lineOfSightAtEndpoint\":%s}", target ? (has_los(p.end, target) ? "true" : "false") : "null");
    return json;
}
EMSCRIPTEN_KEEPALIVE void qev_pause(void) {
    if (remaining > 0 || lease > 0) stop_reason = "Interrupted by Pause.";
    control_session++;
    paused = owned = 1; remaining = 0; accumulator = 0; clear_action(); audio_pause(1);
}
EMSCRIPTEN_KEEPALIVE int qev_play(void) {
    if (!ready()) return 0;
    control_session++;
    clear_action(); remaining = 0; owned = paused = 0; accumulator = 0; stop_reason = NULL;
    key_dest = key_game;
    Cbuf_AddText("+mlook\n");
    audio_pause(0);
    return 1;
}
EMSCRIPTEN_KEEPALIVE int qev_speed(float scale) {
    if (!isfinite(scale) || scale < 0.05f || scale > 1) return 0;
    speed_scale = scale; accumulator = 0; return 1;
}
/* Inputs are numeric and bounded; no model-generated console strings are accepted. */
static int set_action(float dx, float dy, int slot, int generation, float yaw, float pitch, int attack, int ticks) {
    probe_t p;
    if (!ready() || player()->v.health <= 0 || cl.intermission ||
        ticks < 1 || ticks > QEV_LIVE_TICKS || !isfinite(dx) || !isfinite(dy) || !isfinite(yaw) || !isfinite(pitch) ||
        dx*dx + dy*dy > 1.001f || fabsf(yaw) > 720 || pitch < -70 || pitch > 80 || (attack != 0 && attack != 1)) return 0;
    if (slot >= 0 && !valid_target(slot, generation)) return 0;
    if (attack && (slot < 0 || cl.stats[STAT_AMMO] <= 0 || cl.stats[STAT_ACTIVEWEAPON] == IT_AXE)) return 0;
    p = probe(dx, dy, QEV_SPEED * ticks * QEV_DT);
    if ((dx != 0 || dy != 0) && (p.blocked || !p.supported || p.hazard)) return 0;
    clear_action();
    stop_reason = NULL;
    move_x = dx; move_y = dy; target_slot = slot; target_generation = generation;
    aim_yaw = yaw; aim_pitch = pitch; firing = attack;
    lease = ticks; action_serial++; action_ticks = 0; key_dest = key_game;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int qev_action(int expected_epoch, int expected_tick, float dx, float dy,
    int slot, int generation, float yaw, float pitch, int attack, int ticks) {
    if (!paused || remaining || epoch != expected_epoch || tick != expected_tick || ticks > 12) return 0;
    if (!set_action(dx, dy, slot, generation, yaw, pitch, attack, ticks)) return 0;
    remaining = ticks; owned = paused = 1; accumulator = 0; audio_pause(0);
    return 1;
}
/* Real-time controller ownership is separate from human play and debug stepping. */
EMSCRIPTEN_KEEPALIVE int qev_auto(void) {
    if (!ready() || !paused || remaining || player()->v.health <= 0 || cl.intermission) return 0;
    clear_action(); control_session++; owned = 1; paused = 0; remaining = 0;
    accumulator = 0; stop_reason = NULL; key_dest = key_game; audio_pause(0);
    return control_session;
}
EMSCRIPTEN_KEEPALIVE int qev_live_action(int expected_epoch, int observed_tick, int session, float dx, float dy,
    int slot, int generation, float yaw, float pitch, int attack, int ticks) {
    if (paused || !owned || remaining || session != control_session || epoch != expected_epoch ||
        observed_tick < 0 || observed_tick > tick || tick - observed_tick > QEV_MAX_AGE) return 0;
    if (!set_action(dx, dy, slot, generation, yaw, pitch, attack, ticks)) return 0;
    /* Replacing a command must NOT reset the simulation accumulator or freeze the world. */
    lease_deadline = Sys_FloatTime() + 1.5;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int qev_step_frame(int expected_epoch, int expected_tick) {
    if (!ready() || !paused || remaining || epoch != expected_epoch || tick != expected_tick || player()->v.health <= 0 || cl.intermission) return 0;
    clear_action(); stop_reason = NULL; owned = 1; remaining = 1; accumulator = 0; key_dest = key_game; audio_pause(0); return 1;
}
EMSCRIPTEN_KEEPALIVE int qev_new_game(const char *name, int difficulty) {
    char command[112];
    size_t i, len;
    if (!host_initialized || !name || difficulty < 0 || difficulty > 3) return 0;
    len = strlen(name);
    if (len < 1 || len > 40) return 0;
    for (i = 0; i < len; i++) if (!isalnum((unsigned char)name[i]) && name[i] != '_' && name[i] != '-') return 0;
    qev_pause(); booting = 1;
    /* Skill must be set before SV_SpawnServer filters entities and starts QuakeC. */
    snprintf(command, sizeof(command), "disconnect\nskill %d\nmap %s\n", difficulty, name);
    Cbuf_AddText(command);
    return 1;
}
EMSCRIPTEN_KEEPALIVE int qev_load_map(const char *name) {
    return qev_new_game(name, current_skill);
}
void Qev_ApplyInput(usercmd_t *cmd) {
    edict_t *target = NULL;
    vec3_t dest, eye, delta;
    float yaw = aim_yaw, pitch = aim_pitch, radians, dyaw, dpitch;
    probe_t p;
    Qev_Attack(0);
    if (!ready() || lease <= 0 || player()->v.health <= 0) return;
    if (firing && (cl.stats[STAT_AMMO] <= 0 || cl.stats[STAT_ACTIVEWEAPON] == IT_AXE)) { cancel_action("Firing action no longer has usable ammunition."); return; }
    if (target_slot >= 0) {
        target = valid_target(target_slot, target_generation);
        if (!target) { cancel_action("Selected target is no longer observable."); return; }
        eye_at(player()->v.origin, eye); center(target, dest); VectorSubtract(dest, eye, delta);
        yaw = atan2f(delta[1], delta[0]) * 180 / M_PI;
        pitch = -atan2f(delta[2], sqrtf(delta[0]*delta[0] + delta[1]*delta[1])) * 180 / M_PI;
    }
    p = probe(move_x, move_y, QEV_SPEED * QEV_DT);
    if ((move_x != 0 || move_y != 0) && (p.blocked || !p.supported || p.hazard)) { cancel_action("Movement guard stopped a changed or unsupported route."); return; }
    dyaw = angle_delta(yaw, cl.viewangles[YAW]);
    dpitch = angle_delta(pitch, cl.viewangles[PITCH]);
    cl.viewangles[YAW] = anglemod(cl.viewangles[YAW] + clampf(dyaw, -QEV_TURN*QEV_DT, QEV_TURN*QEV_DT));
    cl.viewangles[PITCH] = clampf(cl.viewangles[PITCH] + clampf(dpitch, -QEV_TURN*QEV_DT, QEV_TURN*QEV_DT), -70, 80);
    V_StopPitchDrift();
    radians = cl.viewangles[YAW] * M_PI / 180;
    cmd->forwardmove = QEV_SPEED * (move_x*cosf(radians) + move_y*sinf(radians));
    cmd->sidemove = QEV_SPEED * (move_x*sinf(radians) - move_y*cosf(radians));
    action_ticks++;
    if (firing && target && cl.stats[STAT_AMMO] > 0 && fabsf(dyaw) <= 3 && fabsf(dpitch) <= 3 && has_los(player()->v.origin, target)) Qev_Attack(1);
}
void Qev_MainLoop(void) {
    double wall = Sys_FloatTime(), elapsed = last_wall ? wall - last_wall : 0;
    int n = 0;
    last_wall = wall;
    if (!paused && owned && lease > 0 && lease_deadline > 0 && wall >= lease_deadline) cancel_action("Action wall-time watchdog expired.");
    if (ready() && !booting && paused && remaining == 0) {
        accumulator = 0;
        Sys_SendKeyEvents(); /* UI/input events only: no physics, game clocks, or RNG. */
        return;
    }
    accumulator += fmin(fmax(elapsed, 0), 0.1) * (booting ? 1 : speed_scale);
    while (accumulator >= QEV_DT && n++ < 6) {
        int before_epoch = epoch;
        vec3_t before;
        int was_ready = ready();
        if (was_ready) VectorCopy(player()->v.origin, before);
        accumulator -= QEV_DT;
        if (owned) key_dest = key_game;
        Host_Frame(QEV_DT);
        if (!ready()) continue;
        tick++;
        if (booting) { booting = 0; qev_pause(); break; }
        if (epoch != before_epoch) break;
        if (player()->v.health <= 0 || cl.intermission) {
            cancel_action(player()->v.health <= 0 ? "Player died." : "Level completed.");
            epoch++; qev_pause(); break;
        }
        if (was_ready) {
            vec3_t delta;
            VectorSubtract(player()->v.origin, before, delta);
            if (length3(delta) > 128) { cancel_action("Player teleported."); epoch++; qev_pause(); break; }
        }
        if (lease > 0 && --lease == 0) cancel_action("Action lease expired.");
        if (remaining > 0 && --remaining == 0) { qev_pause(); break; }
        if (paused && remaining == 0) { qev_pause(); break; }
    }
}
