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
    if (!Array.isArray(state.history)) state.history = [];
    for (const name of Object.keys(state.characters)) {
        const t = name.trim().toLowerCase();
        if (!name.trim() || t === 'null' || t === 'undefined') { delete state.characters[name]; continue; }
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

/**
 * Capture the PRE-turn state for message `index`. Write-once: a re-run of the
 * tracker on the same message keeps the original baseline, so re-processing
 * recomputes deltas from the same starting point instead of compounding them.
 */
export function snapshot(st, index) {
    if (!st || !Number.isInteger(index) || index < 0) { warn('snapshot: bad index', index); return; }
    if (!st.snapshots) st.snapshots = {};
    if (st.snapshots[index]) { vlog(`snapshot #${index} already exists — kept as baseline`); return; }
    const snap = {};
    for (const k of SNAPSHOT_KEYS) snap[k] = deepCopy(st[k]);
    st.snapshots[index] = snap;
    // Trim to the most recent SNAPSHOT_CAP indices.
    const keys = Object.keys(st.snapshots).map(Number).sort((a, b) => a - b);
    while (keys.length > SNAPSHOT_CAP) delete st.snapshots[keys.shift()];
    vlog(`snapshot #${index} saved; snapshots: [${Object.keys(st.snapshots).join(',')}]`);
    save();
}

/**
 * Revert canonical state to just before message `index` influenced it.
 * Restores the nearest snapshot with key <= index, drops later snapshots and
 * any pending change sourced from message >= index.
 * @returns {{restored:boolean, usedKey:number|null, prunedPending:number, prunedSnaps:number}}
 */
export function restoreFrom(st, index) {
    const result = { restored: false, usedKey: null, prunedPending: 0, prunedSnaps: 0, prunedHistory: 0 };
    if (!st) return result;
    if (!st.snapshots || typeof st.snapshots !== 'object') st.snapshots = {};

    const candidates = Object.keys(st.snapshots).map(Number).filter((k) => k <= index).sort((a, b) => b - a);
    const useKey = candidates[0];
    if (useKey != null) {
        const snap = st.snapshots[useKey];
        for (const k of SNAPSHOT_KEYS) if (snap && snap[k] != null) st[k] = deepCopy(snap[k]);
        result.restored = true;
        result.usedKey = useKey;
    }
    for (const k of Object.keys(st.snapshots)) {
        if (Number(k) > index) { delete st.snapshots[k]; result.prunedSnaps++; }
    }
    const before = (st.pending || []).length;
    st.pending = (st.pending || []).filter((p) => !(Number.isInteger(p.sourceMessageId) && p.sourceMessageId >= index));
    result.prunedPending = before - st.pending.length;
    result.prunedHistory = pruneHistory(st, index);

    vlog(`restoreFrom(${index}): all snapshot keys were [${Object.keys(st.snapshots).join(',')}], used #${useKey ?? 'none'}, pruned ${result.prunedPending} pending / ${result.prunedSnaps} snaps / ${result.prunedHistory} history`);
    save();
    return result;
}

// ---------------------------------------------------------------------------
// Non-destructive snapshot read + per-swipe reconstruction
// ---------------------------------------------------------------------------

/** Deep copy of the nearest snapshot with key <= index, or null. No mutation. */
export function peekSnapshot(state, index) {
    if (!state || !state.snapshots || typeof state.snapshots !== 'object') return null;
    const key = Object.keys(state.snapshots).map(Number).filter((k) => k <= index).sort((a, b) => b - a)[0];
    if (key == null) return null;
    const snap = state.snapshots[key];
    if (!snap) return null;
    const out = {};
    for (const k of SNAPSHOT_KEYS) if (snap[k] != null) out[k] = deepCopy(snap[k]);
    return out;
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

/** Ensure a character entry exists, seeded from the schema template. */
export function ensureCharacter(state, name, schema) {
    const s = schema ?? defaultSchema();
    if (!state.characters[name]) {
        const template = isPlayerName(name) ? (s.player?.fields ?? []) : (s.character?.fields ?? []);
        const entry = { updater: s.character?.defaultUpdater ?? UPDATER_NARRATOR, present: true, order: Object.keys(state.characters).length, fields: {}, rels: {} };
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
    ensureCharacter(state, name, schema);
    return true;
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
