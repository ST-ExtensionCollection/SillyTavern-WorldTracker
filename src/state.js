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

import { defaultSchema, UPDATER_NARRATOR } from './schema.js';
import { log, warn } from './log.js';

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
    };
    for (const f of s.world ?? []) {
        state.world[f.key] = {
            value: f.default ?? '',
            type: f.type ?? 'text',
            unit: f.unit,
            locked: !!f.lockedByDefault,
            lastChangedBy: null,
        };
    }
    for (const f of s.userStats ?? []) {
        state.userStats[f.key] = {
            value: f.default ?? 0,
            type: f.type ?? 'number',
            max: f.max,
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
    for (const f of s.world ?? []) {
        if (!state.world[f.key]) {
            state.world[f.key] = { value: f.default ?? '', type: f.type ?? 'text', unit: f.unit, locked: !!f.lockedByDefault, lastChangedBy: null };
        }
    }
    for (const f of s.userStats ?? []) {
        if (!state.userStats[f.key]) {
            state.userStats[f.key] = { value: f.default ?? 0, type: f.type ?? 'number', max: f.max, locked: !!f.lockedByDefault, lastChangedBy: null };
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
        log(`seeded fresh state for chat (chars: 0)`);
    } else {
        reconcile(m[META_KEY], schema);
    }
    return m[META_KEY];
}

/** Replace the whole state object (used by snapshot restore). */
export function replace(newState) {
    const m = meta();
    if (!m) return;
    m[META_KEY] = newState;
    save();
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
