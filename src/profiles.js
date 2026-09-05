// WorldTracker — named settings profiles.
//
// A profile bundles the gear-dialog content: field schema, section toggles,
// and the narrator character. Profiles can be bound to a specific chat/group
// (auto-applied on open) and one can be marked the default.

import { defaultSchema } from './schema.js';

/** Keys a profile owns. */
const PROFILE_KEYS = ['schema', 'sections'];

const clone = (v) => JSON.parse(JSON.stringify(v));

export function ensureProfiles(settings) {
    if (!settings.profiles || typeof settings.profiles !== 'object') settings.profiles = {};
    const p = settings.profiles;
    if (!p.list || typeof p.list !== 'object') p.list = {};
    if (typeof p.activeId !== 'string') p.activeId = '';
    if (typeof p.defaultId !== 'string') p.defaultId = '';
    if (!p.bindings || typeof p.bindings !== 'object') p.bindings = {}; // chatKey -> profileId

    // Seed a first profile from whatever settings currently hold.
    if (!Object.keys(p.list).length) {
        const id = newId();
        p.list[id] = { name: 'Default', data: snapshot(settings) };
        p.activeId = id;
        p.defaultId = id;
    }
    if (!p.list[p.activeId]) p.activeId = Object.keys(p.list)[0] || '';
    if (p.defaultId && !p.list[p.defaultId]) p.defaultId = '';
    return p;
}

function newId() {
    return `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Extract the profile-owned slice from live settings. */
export function snapshot(settings) {
    const out = {};
    for (const k of PROFILE_KEYS) out[k] = clone(settings[k]);
    return out;
}

/** Write a profile's data back into live settings. */
export function applyData(settings, data) {
    if (!data) return;
    for (const k of PROFILE_KEYS) {
        if (data[k] !== undefined) settings[k] = clone(data[k]);
    }
    if (!settings.schema || typeof settings.schema !== 'object') settings.schema = defaultSchema();
}

export function list(settings) {
    const p = ensureProfiles(settings);
    return Object.entries(p.list).map(([id, v]) => ({ id, name: v.name }));
}

export function active(settings) {
    const p = ensureProfiles(settings);
    return p.list[p.activeId] ? { id: p.activeId, ...p.list[p.activeId] } : null;
}

/** Save `data` into the active profile (or a specific id). */
export function save(settings, data, id) {
    const p = ensureProfiles(settings);
    const target = id || p.activeId;
    if (!p.list[target]) return null;
    p.list[target].data = clone(data);
    return target;
}

/** Create a new profile from `data` and make it active. Returns its id. */
export function create(settings, name, data) {
    const p = ensureProfiles(settings);
    const id = newId();
    p.list[id] = { name: String(name || 'Profile').trim() || 'Profile', data: clone(data) };
    p.activeId = id;
    return id;
}

export function rename(settings, id, name) {
    const p = ensureProfiles(settings);
    if (p.list[id]) p.list[id].name = String(name || '').trim() || p.list[id].name;
}

export function remove(settings, id) {
    const p = ensureProfiles(settings);
    if (!p.list[id]) return;
    delete p.list[id];
    for (const [k, v] of Object.entries(p.bindings)) if (v === id) delete p.bindings[k];
    if (p.defaultId === id) p.defaultId = '';
    if (p.activeId === id) p.activeId = Object.keys(p.list)[0] || '';
    if (!Object.keys(p.list).length) {
        // never leave zero profiles
        const nid = create(settings, 'Default', snapshot(settings));
        p.defaultId = nid;
    }
}

export function setActive(settings, id) {
    const p = ensureProfiles(settings);
    if (p.list[id]) p.activeId = id;
}

export function setDefault(settings, id) {
    const p = ensureProfiles(settings);
    p.defaultId = (id && p.list[id]) ? id : '';
}

// --- chat / group bindings ---

/** A stable key for the current chat: group id, or character avatar. */
export function chatKey(ctx) {
    try {
        const c = ctx?.getContext ? ctx : globalThis.SillyTavern.getContext();
        if (c.groupId) return `group:${c.groupId}`;
        const av = c.characters?.[c.characterId]?.avatar;
        return av ? `char:${av}` : '';
    } catch {
        return '';
    }
}

export function bindingFor(settings, key) {
    const p = ensureProfiles(settings);
    return key && p.bindings[key] && p.list[p.bindings[key]] ? p.bindings[key] : '';
}

export function bind(settings, key, id) {
    const p = ensureProfiles(settings);
    if (!key) return;
    if (id && p.list[id]) p.bindings[key] = id;
    else delete p.bindings[key];
}

/**
 * Which profile should be active for this chat: an explicit binding wins,
 * else the default, else keep whatever is active. Returns a profile id or ''.
 */
export function resolveForChat(settings, ctx) {
    const p = ensureProfiles(settings);
    const bound = bindingFor(settings, chatKey(ctx));
    if (bound) return bound;
    if (p.defaultId && p.list[p.defaultId]) return p.defaultId;
    return p.activeId || '';
}

// --- narrator (per chat/group, not part of a profile) ---

function narratorMap(settings) {
    if (!settings.narratorByChat || typeof settings.narratorByChat !== 'object') settings.narratorByChat = {};
    return settings.narratorByChat;
}

/** The designated narrator for chat `key`. '' = any turn (the default). */
export function narratorFor(settings, key) {
    return (key && narratorMap(settings)[key]) || '';
}

/** Set (or, with an empty name, clear) the narrator for chat `key`. */
export function setNarrator(settings, key, name) {
    if (!key) return;
    const m = narratorMap(settings);
    if (name) m[key] = name;
    else delete m[key];
}

/** Rename a narrator binding everywhere it's referenced, after a character rename. */
export function renameNarratorEverywhere(settings, oldName, newName) {
    const m = narratorMap(settings);
    for (const k of Object.keys(m)) if (m[k] === oldName) m[k] = newName;
}
