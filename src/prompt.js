// WorldTracker — builds the extraction query sent to the tracker model.
//
// The model is shown the CURRENT canonical state (as the JSON it should return,
// pre-filled with the real current values) plus the recent messages, and asked
// to return that same object with any changed fields updated. Locked fields are
// marked immutable. The clock is asked for ELAPSED time only, never an absolute
// date — WorldTracker does the date arithmetic itself.

import { format } from './clock.js';

const DEFAULT_SYSTEM =
    'You are a world-state tracker for a roleplay. You receive the current world state as JSON and the recent messages. '
    + 'Reply with the SAME JSON object, changing only the fields the recent messages show have changed; copy everything else unchanged. '
    + 'Output ONLY the JSON object — no prose, no markdown, no commentary, and do not think out loud. '
    + 'Never invent detail that the messages do not support.';

/** Remove injected tracker JSON / code blocks / tag soup from a message body. */
function cleanMessage(mes, cap) {
    let s = String(mes ?? '');
    s = s.replace(/```[\s\S]*?```/g, ' ');          // fenced code / injected JSON
    s = s.replace(/<[^>]{1,40}>/g, ' ');            // short html/xml tags
    s = s.replace(/\{[^{}]*"[^{}]*\}/g, ' ');       // stray inline json-ish objects
    s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (cap && s.length > cap) s = `${s.slice(0, cap)}…`;
    return s;
}

/** The object we want back, pre-filled with the current real values. */
function currentAsJson(state) {
    const o = {};
    if (state.clock && !state.clock.locked) {
        o.clock = { elapsed: { days: 0, hours: 0, minutes: 0, seconds: 0 } };
    }
    if (Object.keys(state.world).length) {
        o.world = {};
        for (const [k, f] of Object.entries(state.world)) o.world[k] = f.value;
    }
    if (Object.keys(state.userStats).length) {
        o.userStats = {};
        for (const [k, f] of Object.entries(state.userStats)) o.userStats[k] = f.value;
    }
    const names = Object.keys(state.characters);
    if (names.length) {
        o.characters = {};
        for (const name of names) {
            o.characters[name] = {};
            for (const [fk, ff] of Object.entries(state.characters[name].fields)) {
                o.characters[name][fk] = ff.value;
            }
        }
    }
    return o;
}

/** Human notes about constraints that don't fit in the JSON. */
function constraintNotes(state) {
    const notes = [];
    if (state.clock && !state.clock.locked) {
        notes.push(`- clock.elapsed = in-world time passed since ${JSON.stringify(format(state.clock.iso, state.clock.displayFormat))}. Dialogue back-and-forth is seconds. Never output an absolute date/time.`);
    } else if (state.clock?.locked) {
        notes.push('- clock: LOCKED. Omit the clock key entirely.');
    }
    for (const [k, f] of Object.entries(state.world)) {
        if (f.locked) notes.push(`- world.${k}: LOCKED — must stay ${JSON.stringify(f.value)}.`);
        else if (f.type === 'number' && f.unit) notes.push(`- world.${k}: number in ${f.unit}.`);
    }
    for (const [k, f] of Object.entries(state.userStats)) {
        if (f.locked) notes.push(`- userStats.${k}: LOCKED — must stay ${f.value}.`);
        else if (f.max != null) notes.push(`- userStats.${k}: integer 0–${f.max}.`);
    }
    for (const [name, c] of Object.entries(state.characters)) {
        for (const [fk, ff] of Object.entries(c.fields)) {
            if (ff.locked) notes.push(`- characters.${name}.${fk}: LOCKED — must stay ${JSON.stringify(ff.value)}.`);
            else if (ff.type === 'enum' && Array.isArray(ff.options)) notes.push(`- characters.${name}.${fk}: one of ${ff.options.join(' / ')}.`);
        }
    }
    return notes;
}

/**
 * A character is "in scope" this turn if its updater is the narrator, or if it
 * is 'self' and it authored the triggering message, or a specific name that
 * authored it. Others are read-only for this update.
 */
export function inScope(entry, name, authorName) {
    const u = entry?.updater || 'narrator';
    if (u === 'narrator') return true;
    if (!authorName) return false;
    if (u === 'self') return authorName === name;
    return authorName === u;
}

/**
 * @param {object} state    canonical world state
 * @param {Array}  recent   [{ name, is_user, mes }] recent chat messages, oldest first
 * @param {object} opts     { settings, playerName, authorName }
 * @returns {{ messages: {role:string, content:string}[] }}
 */
export function buildTrackerPrompt(state, recent, opts = {}) {
    const { settings = {}, playerName, authorName } = opts;
    const sys = settings.promptOverrides?.system || DEFAULT_SYSTEM;
    const cap = Number(settings.maxMessageChars) || 1500;
    const L = [];

    L.push('CURRENT WORLD STATE — reply with this object, updated:');
    L.push('```json');
    L.push(JSON.stringify(currentAsJson(state), null, 2));
    L.push('```');

    const notes = constraintNotes(state);
    if (notes.length) {
        L.push('');
        L.push('Constraints:');
        L.push(...notes);
    }

    const names = Object.keys(state.characters);
    if (names.length) {
        const writable = names.filter((n) => inScope(state.characters[n], n, authorName));
        const readonly = names.filter((n) => !writable.includes(n));
        L.push('');
        if (writable.length) L.push(`Report updates for these NPCs only: ${writable.join(', ')}.`);
        if (readonly.length) L.push(`Do NOT report or change these NPCs this turn (not their turn to update): ${readonly.join(', ')}.`);
        if (playerName) L.push(`Never report the player (${playerName}).`);
    }

    if (settings.promptOverrides?.instruction) {
        L.push('');
        L.push(settings.promptOverrides.instruction);
    }

    L.push('');
    L.push('RECENT MESSAGES (oldest first):');
    for (const m of recent) {
        const who = m.is_user ? (playerName || 'User') : (m.name || 'Character');
        const body = cleanMessage(m.mes, cap);
        if (body) L.push(`${who}: ${body}`);
    }

    L.push('');
    L.push('Now output the updated JSON object only.');

    return {
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: L.join('\n') },
        ],
    };
}
