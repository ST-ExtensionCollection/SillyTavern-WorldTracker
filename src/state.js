// WorldTracker — canonical per-chat world state.
//
// Stored at chat_metadata.WorldTracker. This is THE source of truth for the
// display and for what the next tracker query is told. Nothing mutates it except
// an approved change (or an auto-approved one). Shape:
//
//   {
//     clock:   { iso, displayFormat, locked },
//     world:   { <key>: { value, type, unit?, locked, lastChangedBy } },
//     userStats:{ <key>: { value, type, max?, locked, lastChangedBy } },
//     characters: {
//       <name>: {
//         updater: 'narrator' | 'self' | '<name>',
//         fields: { <key>: { value, type, options?, locked, lastChangedBy } }
//       }
//     },
//     pending: [ { id, path, label, from, to, reason, sourceMessageId, ts } ],
//     history: [ { id, mesId, swipeId, ts, trigger, changes: [ {path,label,kind,before,after,rawBefore,rawAfter,beforeIso?,afterIso?} ] } ],
//     _v: 2
//   }

import { defaultSchema, normGroup, UPDATER_NARRATOR } from './schema.js';
import { diffJson, applyJsonPatch } from './diff.js';
import { vlog, warn } from './log.js';

export const META_KEY = 'WorldTracker';
const STATE_VERSION = 2;

export function init() {
    // No caching — chat_metadata is REASSIGNED by ST on every chat change, so
    // anything captured at boot goes stale. Always read it live.
}

/** The current chat's metadata object (live — reassigned by ST per chat). */
function meta() {
    try {
        return globalThis.SillyTavern.getContext().chatMetadata ?? null;
    } catch (e) {
        warn('no context for chat metadata', e);
        return null;
    }
}

/** The persona (player) name, live from context. '' if unavailable. */
export function personaName() {
    try {
        return globalThis.SillyTavern.getContext().name1 || '';
    } catch {
        return '';
    }
}

/** True when `name` is the current persona — that character uses schema.player. */
export function isPlayerName(name) {
    return !!name && name === personaName();
}

export function save() {
    try {
        const c = globalThis.SillyTavern.getContext();
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else if (typeof c.saveMetadata === 'function') c.saveMetadata();
    } catch (e) {
        warn('save failed', e);
    }
}

/** Build a fresh state object from a schema. */
function seedFromSchema(schema) {
    const s = schema ?? defaultSchema();
    const state = {
        _v: STATE_VERSION,
        clock: {
            iso: s.clock?.startIso ?? '2024-06-01T09:00:00',
            displayFormat: s.clock?.displayFormat ?? 'HH:mm — EEE, MMM d yyyy',
            locked: !!s.clock?.lockedByDefault,
            expectedInterval: { days: 0, hours: 0, minutes: 1, seconds: 0, ...(s.clock?.expectedInterval ?? {}) },
            intervalPresets: (s.clock?.intervalPresets ?? []).map((p) => ({ ...p })),
        },
        world: {},
        userStats: {},
        characters: {},
        pending: [],
        snapshots: {}, // { [messageIndex]: {clock,world,userStats,characters} } for swipe/revert
    };
    for (const f of s.world ?? []) {
        state.world[f.key] = {
            value: f.default ?? '',
            type: f.type ?? 'text',
            unit: f.unit,
            group: normGroup(f.group),
            locked: !!f.lockedByDefault,
            lastChangedBy: null,
        };
    }
    for (const f of s.userStats ?? []) {
        state.userStats[f.key] = {
            value: f.default ?? 0,
            type: f.type ?? 'number',
            max: f.max,
            group: normGroup(f.group),
            locked: !!f.lockedByDefault,
            lastChangedBy: null,
        };
    }
    return state;
}

/** Add any schema fields missing from an existing state (additive, non-destructive). */
function reconcile(state, schema) {
    const s = schema ?? defaultSchema();
    if (!state.clock) state.clock = seedFromSchema(s).clock;
    state.clock.expectedInterval = {
        days: 0, hours: 0, minutes: 1, seconds: 0,
        ...(state.clock.expectedInterval ?? s.clock?.expectedInterval ?? {}),
    };
    if (!Array.isArray(state.clock.intervalPresets) || !state.clock.intervalPresets.length) {
        state.clock.intervalPresets = (s.clock?.intervalPresets ?? []).map((p) => ({ ...p }));
    }
    if (!state.world) state.world = {};
    if (!state.userStats) state.userStats = {};
    if (!state.characters) state.characters = {};
    if (!Array.isArray(state.pending)) state.pending = [];
    if (!state.snapshots || typeof state.snapshots !== 'object') state.snapshots = {};
    // v1 snapshots were bare {clock,world,userStats,characters}; wrap them as keyframes.
    for (const k of Object.keys(state.snapshots)) {
        const v = state.snapshots[k];
        if (v && typeof v === 'object' && !('kf' in v) && !('base' in v) && (v.world || v.characters || v.clock)) {
            state.snapshots[k] = { kf: true, data: v };
        }
    }
    if (!Array.isArray(state.history)) state.history = [];
    for (const name of Object.keys(state.characters)) {
        if (!name.trim()) { delete state.characters[name]; continue; } // empty key = junk
        const c = state.characters[name];
        if (!c.rels || typeof c.rels !== 'object') c.rels = {};
    }
    for (const f of s.world ?? []) {
        if (!state.world[f.key]) {
            state.world[f.key] = { value: f.default ?? '', type: f.type ?? 'text', unit: f.unit, group: normGroup(f.group), locked: !!f.lockedByDefault, lastChangedBy: null };
        } else {
            state.world[f.key].group = normGroup(f.group);
        }
    }
    for (const f of s.userStats ?? []) {
        if (!state.userStats[f.key]) {
            state.userStats[f.key] = { value: f.default ?? 0, type: f.type ?? 'number', max: f.max, group: normGroup(f.group), locked: !!f.lockedByDefault, lastChangedBy: null };
        } else {
            state.userStats[f.key].group = normGroup(f.group);
        }
    }
    return state;
}

/**
 * Get the current chat's state, creating/reconciling it against `schema`.
 * Returns null if no chat is active.
 */
export function get(schema) {
    const m = meta();
    if (!m) return null;
    if (!m[META_KEY] || typeof m[META_KEY] !== 'object') {
        m[META_KEY] = seedFromSchema(schema);
        save();
        vlog(`seeded fresh state for chat (chars: 0)`);
    } else {
        reconcile(m[META_KEY], schema);
    }
    return m[META_KEY];
}

/**
 * Re-shape the current chat's state to match an edited schema: add new fields,
 * remove deleted ones, sync type/unit/options/max on the survivors (values are
 * kept). Called after the settings modal saves.
 */
export function applySchema(st, schema) {
    if (!st) return;
    reconcile(st, schema); // adds any missing world/userStats + clock keys

    const syncScalar = (target, defs, extra = () => {}) => {
        const keys = new Set((defs || []).map((f) => f.key));
        for (const k of Object.keys(target)) if (!keys.has(k)) delete target[k];
        for (const f of defs || []) {
            if (!target[f.key]) {
                target[f.key] = { value: f.default ?? (f.type === 'number' ? 0 : ''), type: f.type ?? 'text', locked: !!f.lockedByDefault, lastChangedBy: null };
            }
            target[f.key].type = f.type ?? 'text';
            target[f.key].group = normGroup(f.group);
            extra(target[f.key], f);
        }
    };

    syncScalar(st.world, schema.world, (t, f) => { t.unit = f.unit; });
    syncScalar(st.userStats, schema.userStats, (t, f) => { t.max = f.max; });
    for (const name of Object.keys(st.characters)) {
        const defs = isPlayerName(name) ? schema.player?.fields : schema.character?.fields;
        syncScalar(st.characters[name].fields, defs, (t, f) => { t.options = f.options; });
    }
    save();
}

/** Replace the whole state object (used by snapshot restore). */
export function replace(newState) {
    const m = meta();
    if (!m) return;
    m[META_KEY] = newState;
    save();
}

const SNAPSHOT_CAP = 40;
const SNAPSHOT_KEYS = ['clock', 'world', 'userStats', 'characters'];
const KEYFRAME_EVERY = 8; // one full copy per this many snapshots; the rest are deltas

/**
 * A snapshot entry is either
 *   { kf: true, data: { clock, world, userStats, characters } }   — full copy
 *   { base: <lowerKey>, patch: <diffJson result> }                — forward delta
 * (or, on chats saved before v2, the bare {clock,world,userStats,characters};
 *  reconcile() rewraps those as keyframes.)
 */

/** Full {clock,world,userStats,characters} for an exact snapshot key, or null. */
function readSnap(state, key, depth = 0) {
    const e = state.snapshots?.[key];
    if (!e || depth > 200) return null;
    if (e.kf) return deepCopy(e.data || null);
    if (!('base' in e)) { // legacy bare shape
        const out = {};
        for (const k of SNAPSHOT_KEYS) if (e[k] != null) out[k] = deepCopy(e[k]);
        return Object.keys(out).length ? out : null;
    }
    const base = readSnap(state, e.base, depth + 1);
    if (!base) { warn(`readSnap: broken delta chain at #${key} (base #${e.base})`); return null; }
    try { return applyJsonPatch(base, e.patch); } catch (err) { warn('readSnap: patch failed', err); return null; }
}

function nearestSnapKey(state, index) {
    if (!state?.snapshots || typeof state.snapshots !== 'object') return null;
    const k = Object.keys(state.snapshots).map(Number).filter((n) => n <= index).sort((a, b) => b - a)[0];
    return k == null ? null : k;
}

function deltasSinceKeyframe(state, key) {
    let hops = 0;
    let k = key;
    while (hops < 300) {
        const e = state.snapshots[k];
        if (!e || e.kf || !('base' in e)) return hops;
        k = e.base;
        hops++;
    }
    return hops;
}

/** Drop lowest keys past SNAPSHOT_CAP, promoting any delta that would be orphaned. */
function trimSnapshots(state) {
    let keys = Object.keys(state.snapshots).map(Number).sort((a, b) => a - b);
    while (keys.length > SNAPSHOT_CAP) {
        const lo = keys.shift();
        for (const kk of Object.keys(state.snapshots)) {
            const e = state.snapshots[kk];
            if (e && !e.kf && 'base' in e && e.base === lo) {
                const full = readSnap(state, Number(kk));
                if (full) state.snapshots[kk] = { kf: true, data: full };
            }
        }
        delete state.snapshots[lo];
    }
}

/**
 * Capture the PRE-turn state for message `index`. Write-once: a re-run of the
 * tracker on the same message keeps the original baseline, so re-processing
 * recomputes deltas from the same starting point instead of compounding them.
 * Stored as a delta from the previous snapshot, with a full keyframe every
 * KEYFRAME_EVERY captures.
 */
export function snapshot(st, index) {
    if (!st || !Number.isInteger(index) || index < 0) { warn('snapshot: bad index', index); return; }
    if (!st.snapshots) st.snapshots = {};
    if (st.snapshots[index]) { vlog(`snapshot #${index} already exists — kept as baseline`); return; }

    const cur = {};
    for (const k of SNAPSHOT_KEYS) cur[k] = deepCopy(st[k]);

    const prevKey = nearestSnapKey(st, index - 1);
    const prevData = prevKey != null ? readSnap(st, prevKey) : null;

    if (prevData == null || deltasSinceKeyframe(st, prevKey) + 1 >= KEYFRAME_EVERY) {
        st.snapshots[index] = { kf: true, data: cur };
    } else {
        st.snapshots[index] = { base: prevKey, patch: diffJson(prevData, cur) };
    }

    trimSnapshots(st);
    vlog(`snapshot #${index} saved (${st.snapshots[index].kf ? 'keyframe' : 'delta<-' + st.snapshots[index].base}); keys [${Object.keys(st.snapshots).join(',')}]`);
    save();
}

/**
 * Revert canonical state to just before message `index` influenced it.
 * Restores the nearest snapshot with key <= index, drops later snapshots and
 * any pending change / history sourced from message >= index.
 */
export function restoreFrom(st, index) {
    const result = { restored: false, usedKey: null, prunedPending: 0, prunedSnaps: 0, prunedHistory: 0 };
    if (!st) return result;
    if (!st.snapshots || typeof st.snapshots !== 'object') st.snapshots = {};

    const useKey = nearestSnapKey(st, index);
    if (useKey != null) {
        const data = readSnap(st, useKey);
        if (data) {
            for (const k of SNAPSHOT_KEYS) if (data[k] != null) st[k] = deepCopy(data[k]);
            result.restored = true;
            result.usedKey = useKey;
        } else {
            warn(`restoreFrom(${index}): could not reconstruct snapshot #${useKey}; state left as-is`);
        }
    }
    for (const k of Object.keys(st.snapshots)) {
        if (Number(k) > index) { delete st.snapshots[k]; result.prunedSnaps++; }
    }
    const before = (st.pending || []).length;
    st.pending = (st.pending || []).filter((p) => !(Number.isInteger(p.sourceMessageId) && p.sourceMessageId >= index));
    result.prunedPending = before - st.pending.length;
    result.prunedHistory = pruneHistory(st, index);

    vlog(`restoreFrom(${index}): used #${useKey ?? 'none'}, pruned ${result.prunedPending} pending / ${result.prunedSnaps} snaps / ${result.prunedHistory} history`);
    save();
    return result;
}

// ---------------------------------------------------------------------------
// Non-destructive snapshot read + per-swipe reconstruction
// ---------------------------------------------------------------------------

/** Reconstructed {clock,world,userStats,characters} for the nearest snapshot key <= index, or null. */
export function peekSnapshot(state, index) {
    const key = nearestSnapKey(state, index);
    return key == null ? null : readSnap(state, key);
}

/**
 * Rebuild canonical state for message `mesId`'s swipe `swipeId`: start from the
 * pre-query snapshot, then replay every history record tagged with that
 * (mesId, swipeId). Non-destructive — does NOT prune snapshots/pending/history.
 */
export function restoreToSwipe(state, mesId, swipeId, schema) {
    const base = peekSnapshot(state, mesId);
    if (!base) { warn('restoreToSwipe: no base snapshot for', mesId); return false; }
    for (const k of SNAPSHOT_KEYS) if (base[k] != null) state[k] = deepCopy(base[k]);
    const recs = (state.history || [])
        .filter((r) => r.mesId === mesId && r.swipeId === swipeId)
        .sort((a, b) => a.ts - b.ts);
    for (const r of recs) for (const ch of r.changes || []) applyChange(state, ch, schema);
    save();
    vlog(`restoreToSwipe(${mesId}, ${swipeId}): replayed ${recs.length} record(s)`);
    return true;
}

// ---------------------------------------------------------------------------
// Path helpers. A path addresses one leaf field, e.g.
//   'clock'
//   'world.location'
//   'userStats.Health'
//   'characters.Sarah.fields.relationship'
// ---------------------------------------------------------------------------

/** Resolve a path to its field object ({value,locked,...}) or null. */
export function fieldAt(state, path) {
    if (!state || !path) return null;
    if (path === 'clock') return state.clock;
    const parts = path.split('.');
    let node = state;
    for (const p of parts) {
        if (node == null) return null;
        node = node[p];
    }
    return node ?? null;
}

export function isLocked(state, path) {
    const f = fieldAt(state, path);
    return !!(f && f.locked);
}

export function setLock(state, path, locked) {
    const f = fieldAt(state, path);
    if (f) {
        f.locked = !!locked;
        save();
    }
}

/** Human label for a path, for cards / queue rows. */
export function labelFor(path) {
    if (path === 'clock') return 'Time';
    const parts = path.split('.');
    if (parts[0] === 'characters') {
        if (parts[2] === 'present') return `${parts[1]} · presence`;
        if (parts[2] === 'rels') return `${parts[1]} → ${parts.slice(3).join('.')}`;
        return `${parts[1]} · ${parts[3] ?? ''}`.trim();
    }
    return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Turn-history log
// ---------------------------------------------------------------------------

let historySeq = 0;
const HISTORY_CAP = 120;

/**
 * Append a turn record. `rec` = { mesId?, swipeId?, trigger, changes: [...] }.
 * Each change: { path, label, kind, before, after, rawBefore, rawAfter, beforeIso?, afterIso? }.
 */
export function pushHistory(state, rec) {
    if (!state || !rec || !Array.isArray(rec.changes) || !rec.changes.length) return null;
    if (!Array.isArray(state.history)) state.history = [];
    const entry = {
        id: `h${Date.now()}_${historySeq++}`,
        ts: Date.now(),
        mesId: Number.isInteger(rec.mesId) ? rec.mesId : null,
        swipeId: Number.isInteger(rec.swipeId) ? rec.swipeId : null,
        trigger: rec.trigger || 'edit',
        changes: rec.changes,
    };

    // Re-processing the same message+swipe (arrows / repeated auto-update)
    // shouldn't stack N separate turn records. Merge into the previous tracker
    // record for the same (mesId, swipeId): per path keep the earliest `before`
    // and the latest `after`.
    const last = state.history[state.history.length - 1];
    if (entry.trigger === 'tracker' && last && last.trigger === 'tracker'
        && last.mesId != null && last.mesId === entry.mesId && last.swipeId === entry.swipeId) {
        for (const ch of entry.changes) {
            const prev = (last.changes || []).find((c) => c.path === ch.path);
            if (prev) {
                prev.after = ch.after; prev.rawAfter = ch.rawAfter;
                if ('afterIso' in ch) prev.afterIso = ch.afterIso;
            } else {
                last.changes.push(ch);
            }
        }
        last.ts = entry.ts;
        save();
        return last;
    }

    state.history.push(entry);
    while (state.history.length > HISTORY_CAP) state.history.shift();
    save();
    return entry;
}

/** Drop history records whose source message index is >= fromIndex. Returns count removed. */
export function pruneHistory(state, fromIndex) {
    if (!state || !Array.isArray(state.history)) return 0;
    const before = state.history.length;
    state.history = state.history.filter((r) => !(Number.isInteger(r.mesId) && r.mesId >= fromIndex));
    return before - state.history.length;
}

/**
 * Prior values seen for `path`, newest first (each = the `rawBefore` of a change
 * that touched it). Skips the current value and dedupes consecutive repeats.
 */
export function fieldHistory(state, path, limit = 10) {
    if (!state || !Array.isArray(state.history)) return [];
    const cur = path === 'clock' ? state.clock?.iso : fieldAt(state, path)?.value;
    const out = [];
    for (let i = state.history.length - 1; i >= 0 && out.length < limit; i--) {
        for (const ch of state.history[i].changes || []) {
            if (ch.path !== path) continue;
            const v = ch.rawBefore;
            if (v == null) continue;
            if (String(v) === String(cur)) continue;
            const last = out[out.length - 1];
            if (last && String(last.value) === String(v)) continue;
            out.push({ value: v, iso: ch.beforeIso, ts: state.history[i].ts, mesId: state.history[i].mesId });
            if (out.length >= limit) break;
        }
    }
    return out;
}

/**
 * Apply one history change's `rawAfter` to canonical state. Shared by
 * applyProposal, per-swipe replay, and revert-turn (which passes a change whose
 * rawAfter is the value to land on). Mirrors applyProposal's per-kind mutations.
 */
export function applyChange(state, ch, schema) {
    if (!ch || !ch.path) return;
    if (ch.kind === 'clock' || ch.path === 'clock') {
        state.clock.iso = ch.afterIso ?? ch.rawAfter;
        save();
        return;
    }
    if (ch.kind === 'presence') {
        const e = state.characters[ch.path.split('.')[1]];
        if (e) { e.present = !!ch.rawAfter; if (!e.present) e.lastPresentTs = Date.now(); }
        save();
        return;
    }
    if (ch.kind === 'rel') {
        const parts = ch.path.split('.'); // characters, <name>, rels, <obj...>
        const e = state.characters[parts[1]];
        if (e) {
            if (!e.rels) e.rels = {};
            const obj = parts.slice(3).join('.');
            if (ch.rawAfter == null || ch.rawAfter === '') delete e.rels[obj];
            else e.rels[obj] = ch.rawAfter;
        }
        save();
        return;
    }
    if (ch.kind === 'new-character') {
        const nc = ch.rawAfter || {};
        if (!nc.name) return;
        const e = ensureCharacter(state, nc.name, schema);
        for (const [fk, v] of Object.entries(nc.fields || {})) {
            if (fk === 'present') { e.present = v !== false; continue; }
            const f = e.fields[fk];
            if (f && !f.locked && v != null) f.value = f.type === 'number' ? Number(v) : v;
        }
        save();
        return;
    }
    applyValue(state, ch.path, ch.rawAfter, null);
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/**
 * Ensure a character entry exists, seeded from the schema template.
 * `opts.auto` marks it as auto-added (persona auto-track / bulk-add /
 * model-introduced) so an untouched one can be pruned on chat change.
 */
export function ensureCharacter(state, name, schema, opts = {}) {
    const s = schema ?? defaultSchema();
    if (!state.characters[name]) {
        const template = isPlayerName(name) ? (s.player?.fields ?? []) : (s.character?.fields ?? []);
        const entry = { updater: s.character?.defaultUpdater ?? UPDATER_NARRATOR, present: true, order: Object.keys(state.characters).length, fields: {}, rels: {} };
        if (opts.auto) entry.auto = true;
        for (const f of template) {
            entry.fields[f.key] = {
                value: f.default ?? '',
                type: f.type ?? 'text',
                options: f.options,
                group: normGroup(f.group),
                locked: !!f.lockedByDefault,
                lastChangedBy: null,
            };
        }
        state.characters[name] = entry;
        save();
    }
    return state.characters[name];
}

export function removeCharacter(state, name) {
    if (state.characters[name]) {
        delete state.characters[name];
        // drop dangling relationships pointing at the removed character
        for (const other of Object.values(state.characters)) {
            if (other.rels && name in other.rels) delete other.rels[name];
        }
        save();
    }
}

/**
 * Set how `subject` regards `object` (a value from RELATIONSHIP_OPTIONS, or a
 * falsy value to clear it). `mirror` also writes the reverse direction.
 */
export function setRel(state, subject, object, value, { mirror = false } = {}) {
    const put = (a, b) => {
        const e = state.characters[a];
        if (!e) return;
        if (!e.rels) e.rels = {};
        if (!value) delete e.rels[b];
        else e.rels[b] = value;
    };
    put(subject, object);
    if (mirror) put(object, subject);
    save();
}

/**
 * Persist a manual display order for character cards. `orderedNames` is the
 * full desired order; any tracked name missing from it is pushed to the end.
 */
export function reorderCharacters(state, orderedNames) {
    if (!state || !Array.isArray(orderedNames)) return;
    let tail = orderedNames.length;
    for (const name of Object.keys(state.characters)) {
        const i = orderedNames.indexOf(name);
        state.characters[name].order = i >= 0 ? i : tail++;
    }
    save();
}

/**
 * Ensure the persona has its own tracked card (seeded from schema.player).
 * No-op when there's no persona name or the card already exists.
 * @returns {boolean} true if a card was created
 */
export function ensurePlayerTracked(state, schema) {
    if (!state) return false;
    const name = personaName();
    if (!name || state.characters[name]) return false;
    ensureCharacter(state, name, schema, { auto: true });
    return true;
}

/** True when a character card holds real data (so it must not be auto-pruned). */
export function isCardTouched(state, name, schema) {
    const e = state?.characters?.[name];
    if (!e) return false;
    if (e.present === false) return true;
    if (e.rels && Object.keys(e.rels).length) return true;
    if (e.updater && e.updater !== UPDATER_NARRATOR) return true;

    const s = schema ?? defaultSchema();
    const tmpl = isPlayerName(name) ? (s.player?.fields ?? []) : (s.character?.fields ?? []);
    const defs = {};
    for (const f of tmpl) defs[f.key] = f.default ?? '';
    for (const [k, f] of Object.entries(e.fields || {})) {
        if (f.value != null && f.value !== '' && String(f.value) !== String(defs[k] ?? '')) return true;
    }

    const prefix = `characters.${name}.`;
    const hit = (p) => p === `characters.${name}` || (typeof p === 'string' && p.startsWith(prefix));
    for (const r of state.history || []) {
        for (const ch of r.changes || []) if (hit(ch.path)) return true;
    }
    for (const p of state.pending || []) if (hit(p.path)) return true;
    return false;
}

/**
 * Remove every auto-added card that still has no real data and isn't in
 * `keepNames`. Returns how many were dropped.
 */
export function pruneAutoCards(state, keepNames, schema) {
    if (!state || !state.characters) return 0;
    const keep = keepNames instanceof Set ? keepNames : new Set(keepNames || []);
    let removed = 0;
    for (const name of Object.keys(state.characters)) {
        const e = state.characters[name];
        if (e && e.auto && !keep.has(name) && !isCardTouched(state, name, schema)) {
            delete state.characters[name];
            for (const other of Object.values(state.characters)) {
                if (other.rels && name in other.rels) delete other.rels[name];
            }
            removed++;
        }
    }
    if (removed) save();
    return removed;
}

/**
 * Rename a tracked character everywhere it is referenced in LIVE state
 * (characters key, other cards' updater + rels, pending, history). Snapshots
 * are left as-is — reverting past a rename restores the old name.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function renameCharacter(state, oldName, newNameRaw) {
    const newName = String(newNameRaw ?? '').trim();
    if (!state || !state.characters) return { ok: false, reason: 'no state' };
    if (!newName) return { ok: false, reason: 'name is empty' };
    if (newName === oldName) return { ok: false, reason: 'same name' };
    if (!state.characters[oldName]) return { ok: false, reason: `"${oldName}" is not tracked` };
    if (state.characters[newName]) return { ok: false, reason: `"${newName}" is already tracked` };

    // move the entry, preserving key order
    const rebuilt = {};
    for (const [k, v] of Object.entries(state.characters)) rebuilt[k === oldName ? newName : k] = v;
    state.characters = rebuilt;

    // other cards' references
    for (const [n, e] of Object.entries(state.characters)) {
        if (n === newName) continue;
        if (e.updater === oldName) e.updater = newName;
        if (e.rels && oldName in e.rels) {
            e.rels[newName] = e.rels[oldName];
            delete e.rels[oldName];
        }
    }

    const oldExact = `characters.${oldName}`;
    const oldPrefix = `characters.${oldName}.`;
    const rewrite = (p) => {
        if (p === oldExact) return `characters.${newName}`;
        if (typeof p === 'string' && p.startsWith(oldPrefix)) return `characters.${newName}.` + p.slice(oldPrefix.length);
        return p;
    };
    for (const p of state.pending || []) {
        const np = rewrite(p.path);
        if (np !== p.path) { p.path = np; p.label = labelFor(np); }
    }
    for (const r of state.history || []) {
        for (const ch of r.changes || []) {
            const np = rewrite(ch.path);
            if (np !== ch.path) { ch.path = np; ch.label = labelFor(np); }
            if (ch.kind === 'new-character' && ch.rawAfter && ch.rawAfter.name === oldName) ch.rawAfter.name = newName;
        }
    }

    save();
    return { ok: true };
}

/**
 * Set a character's scene presence. Turning it off stamps `lastPresentTs` so the
 * panel can sort recently-departed characters above long-absent ones. Presence
 * is a first-class per-character property, not a schema field — a missing
 * `present` counts as present everywhere.
 */
export function setPresent(state, name, present) {
    const entry = state.characters[name];
    if (!entry) return;
    entry.present = !!present;
    if (!entry.present) entry.lastPresentTs = Date.now();
    save();
}

// ---------------------------------------------------------------------------
// Pending queue
// ---------------------------------------------------------------------------

let pendingSeq = 0;

export function addPending(state, change) {
    const entry = {
        id: `p${Date.now()}_${pendingSeq++}`,
        ts: Date.now(),
        ...change,
    };
    // Collapse: if a pending change for the same path exists, replace it.
    const idx = state.pending.findIndex((p) => p.path === change.path);
    if (idx >= 0) state.pending[idx] = entry;
    else state.pending.push(entry);
    save();
    return entry;
}

export function removePending(state, id) {
    const idx = state.pending.findIndex((p) => p.id === id);
    if (idx >= 0) {
        state.pending.splice(idx, 1);
        save();
    }
}

export function clearPending(state) {
    if (state.pending.length) {
        state.pending = [];
        save();
    }
}

/** Apply an approved value to the canonical field. */
export function applyValue(state, path, value, sourceMessageId) {
    const f = fieldAt(state, path);
    if (!f) return false;
    if (path === 'clock') {
        state.clock.iso = value;
    } else {
        f.value = value;
        f.lastChangedBy = sourceMessageId ?? null;
    }
    save();
    return true;
}

export function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}
