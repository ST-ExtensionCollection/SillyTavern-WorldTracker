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
//     _v: 1
//   }

import { defaultSchema, normGroup, UPDATER_NARRATOR } from './schema.js';
import { vlog, warn } from './log.js';

export const META_KEY = 'WorldTracker';
const STATE_VERSION = 1;

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
        syncScalar(st.characters[name].fields, schema.character?.fields, (t, f) => { t.options = f.options; });
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

/** Capture the pre-query state for message `index` (idempotent per index). */
export function snapshot(st, index) {
    if (!st || !Number.isInteger(index) || index < 0) { warn('snapshot: bad index', index); return; }
    if (!st.snapshots) st.snapshots = {};
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
    const result = { restored: false, usedKey: null, prunedPending: 0, prunedSnaps: 0 };
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

    vlog(`restoreFrom(${index}): all snapshot keys were [${Object.keys(st.snapshots).join(',')}], used #${useKey ?? 'none'}, pruned ${result.prunedPending} pending / ${result.prunedSnaps} snaps`);
    save();
    return result;
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
    if (parts[0] === 'characters') return `${parts[1]} · ${parts[3] ?? ''}`.trim();
    return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/** Ensure a character entry exists, seeded from the schema template. */
export function ensureCharacter(state, name, schema) {
    const s = schema ?? defaultSchema();
    if (!state.characters[name]) {
        const entry = { updater: s.character?.defaultUpdater ?? UPDATER_NARRATOR, fields: {} };
        for (const f of s.character?.fields ?? []) {
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
        save();
    }
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
