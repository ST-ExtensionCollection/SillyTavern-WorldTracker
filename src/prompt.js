// WorldTracker — builds the extraction query sent to the tracker model.
//
// The model is shown the CURRENT canonical state (as the JSON it should return,
// pre-filled with the real current values) plus the recent messages, and asked
// to return that same object with any changed fields updated. Locked fields are
// marked immutable. The clock is asked for ELAPSED time only, never an absolute
// date — WorldTracker does the date arithmetic itself.

import { format } from './clock.js';
import { isPlayerName } from './state.js';
import { RELATIONSHIP_OPTIONS } from './schema.js';

const DEFAULT_SYSTEM =
    'You are a world-state tracker for a roleplay. You receive the current world state as JSON and the recent messages. '
    + 'Reply with the SAME JSON object, changing only the fields the recent messages show have changed; copy everything else unchanged. '
    + 'Output ONLY the JSON object — no prose, no markdown, no commentary, and do not think out loud. '
    + 'Never invent detail that the messages do not support.';

/** Trim + case-insensitive name compare (author / narrator / updater matching). */
const nameEq = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Placeholder for an unset text field in the query JSON (models drop ""). */
export const UNKNOWN = '?';

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

/**
 * Character names writable this turn (self / by-name / narrator scoping),
 * ordered with the turn's author first — weak models front-load their effort on
 * the first entry, so the character who just acted should lead.
 */
export function writableNames(state, authorName, narratorName = '', playerName = '', srcIsUser = false) {
    const w = Object.keys(state?.characters || {}).filter((n) => inScope(state.characters[n], n, authorName, narratorName, playerName, srcIsUser));
    const lead = [];
    const rest = [];
    for (const n of w) (nameEq(n, authorName) ? lead : rest).push(n);
    return [...lead, ...rest];
}

function charNameList(state, sec, charNames) {
    if (sec.characters === false) return [];
    if (Array.isArray(charNames)) return charNames.filter((n) => state.characters[n]); // keep caller's order
    return Object.keys(state.characters);
}

/** The object we want back, pre-filled with the current real values. */
function currentAsJson(state, sec = {}, firstTurn = false, charNames = null) {
    const o = {};
    if (state.clock && !state.clock.locked) {
        o.clock = firstTurn
            ? { datetime: format(state.clock.iso, 'yyyy-MM-dd HH:mm') }
            : { elapsed: { days: 0, hours: 0, minutes: 0, seconds: 0 } };
    }
    if (sec.world !== false && Object.keys(state.world).length) {
        o.world = {};
        for (const [k, f] of Object.entries(state.world)) o.world[k] = f.value;
    }
    if (sec.userStats && Object.keys(state.userStats).length) {
        o.userStats = {};
        for (const [k, f] of Object.entries(state.userStats)) o.userStats[k] = f.value;
    }
    const names = charNameList(state, sec, charNames);
    if (names.length) {
        o.characters = {};
        for (const name of names) {
            o.characters[name] = isPlayerName(name) ? {} : { present: state.characters[name].present !== false };
            for (const [fk, ff] of Object.entries(state.characters[name].fields)) {
                // Show blanks as "?" — models routinely drop empty-string fields;
                // an explicit "unknown" they'll actually replace.
                o.characters[name][fk] = (ff.value === '' || ff.value == null) ? UNKNOWN : ff.value;
            }
            const rels = state.characters[name].rels;
            if (rels && Object.keys(rels).length) o.characters[name].relationships = { ...rels };
        }
    }
    return o;
}

/** Human notes about constraints that don't fit in the JSON. */
function constraintNotes(state, sec = {}, firstTurn = false, charNames = null) {
    const notes = [];
    if (state.clock && !state.clock.locked && firstTurn) {
        notes.push(`- clock.datetime = the scene's in-world date/time as "YYYY-MM-DD HH:mm". If the opening message states or clearly implies one (a year, a season, a weekday, "at dawn", etc.) set it; otherwise copy ${JSON.stringify(format(state.clock.iso, 'yyyy-MM-dd HH:mm'))} unchanged.`);
    } else if (state.clock && !state.clock.locked) {
        notes.push(`- clock.elapsed = in-world time passed since ${JSON.stringify(format(state.clock.iso, state.clock.displayFormat))}. Dialogue back-and-forth is seconds. Never output an absolute date/time.`);
    } else if (state.clock?.locked) {
        notes.push('- clock: LOCKED. Omit the clock key entirely.');
    }
    if (sec.world !== false) for (const [k, f] of Object.entries(state.world)) {
        if (f.locked) notes.push(`- world.${k}: LOCKED — must stay ${JSON.stringify(f.value)}.`);
        else if (f.type === 'number' && f.unit) notes.push(`- world.${k}: number in ${f.unit}.`);
    }
    if (sec.userStats) for (const [k, f] of Object.entries(state.userStats)) {
        if (f.locked) notes.push(`- userStats.${k}: LOCKED — must stay ${f.value}.`);
        else if (f.max != null) notes.push(`- userStats.${k}: integer 0–${f.max}.`);
    }
    if (sec.characters === false) return notes;
    if (Object.keys(state.characters).length) {
        notes.push('- characters.<name>.present: boolean — true only when the character is physically in the current scene this turn; false when away. Change it only when the scene shows them arrive or leave.');
    }
    // Only mention relationships once at least one exists — otherwise weak models
    // try to fill a whole N×N matrix and mangle the JSON.
    if (Object.values(state.characters).some((c) => c.rels && Object.keys(c.rels).length)) {
        notes.push(`- characters.<name>.relationships: only the entries already shown, values one of ${RELATIONSHIP_OPTIONS.join(' / ')}. Change one ONLY when the scene clearly shifts that bond; never add new pairs.`);
    }
    for (const name of charNameList(state, sec, charNames)) {
        for (const [fk, ff] of Object.entries(state.characters[name].fields)) {
            if (ff.locked) notes.push(`- characters.${name}.${fk}: LOCKED — must stay ${JSON.stringify(ff.value)}.`);
            else if (ff.type === 'enum' && Array.isArray(ff.options)) notes.push(`- characters.${name}.${fk}: one of ${ff.options.join(' / ')}.`);
        }
    }
    return notes;
}

/** JSON Schema describing the response shape (unlocked fields only). */
export function buildResponseSchema(state, sec = {}, firstTurn = false, charNames = null) {
    const props = {};
    if (state.clock && !state.clock.locked && firstTurn) {
        props.clock = { type: 'object', properties: { datetime: { type: 'string' } } };
    } else if (state.clock && !state.clock.locked) {
        props.clock = {
            type: 'object',
            properties: {
                elapsed: {
                    type: 'object',
                    properties: {
                        days: { type: 'integer' }, hours: { type: 'integer' },
                        minutes: { type: 'integer' }, seconds: { type: 'integer' },
                    },
                },
            },
        };
    }
    const objOf = (entries, propFn) => {
        const p = {};
        for (const [k, f] of entries) if (!f.locked) p[k] = propFn(f);
        return Object.keys(p).length ? { type: 'object', properties: p } : null;
    };
    const worldP = sec.world !== false ? objOf(Object.entries(state.world), (f) => (f.type === 'number' ? { type: 'number' } : { type: 'string' })) : null;
    if (worldP) props.world = worldP;
    const usP = sec.userStats ? objOf(Object.entries(state.userStats), () => ({ type: 'number' })) : null;
    if (usP) props.userStats = usP;
    const names = charNameList(state, sec, charNames);
    if (names.length) {
        const cp = {};
        for (const name of names) {
            const fp = objOf(Object.entries(state.characters[name].fields), (ff) => (
                ff.type === 'enum' && Array.isArray(ff.options) ? { type: 'string', enum: ff.options }
                    : ff.type === 'number' ? { type: 'number' } : { type: 'string' }
            )) || { type: 'object', properties: {} };
            if (!isPlayerName(name)) fp.properties.present = { type: 'boolean' };
            if (Object.keys(state.characters[name].rels || {}).length) {
                fp.properties.relationships = { type: 'object', additionalProperties: { type: 'string', enum: RELATIONSHIP_OPTIONS } };
            }
            // Require every field back — some backends honor this and stop the
            // model dropping the ones it has "nothing to say" about.
            fp.required = Object.keys(fp.properties);
            if (fp.required.length) cp[name] = fp;
        }
        if (Object.keys(cp).length) props.characters = { type: 'object', properties: cp };
    }
    return { type: 'object', properties: props };
}

/**
 * A character is "in scope" (writable) this turn based on its updater:
 *   'narrator'  -> the narrator's turn (any turn if no narrator is set)
 *   'self'      -> a turn this character authored
 *   '<name>'    -> a turn that named character authored
 * The persona's own card bypasses this while its updater is 'narrator'
 * (default: always writable); set it to 'self' and it updates only on the
 * user's own messages.
 * @param {string} authorName   who authored the triggering message
 * @param {string} narratorName the designated narrator ('' = any turn)
 * @param {string} playerName   the persona name
 * @param {boolean} srcIsUser   the triggering message was written by the user
 */
export function inScope(entry, name, authorName, narratorName = '', playerName = '', srcIsUser = false) {
    const u = entry?.updater || 'narrator';
    if (playerName && name === playerName) {
        return u === 'self' ? !!srcIsUser : true;
    }
    if (u === 'narrator') return narratorName ? nameEq(authorName, narratorName) : true;
    if (!authorName) return false;
    if (u === 'self') return nameEq(authorName, name);
    return nameEq(authorName, u);
}

/**
 * @param {object} state    canonical world state
 * @param {Array}  recent   [{ name, is_user, mes }] recent chat messages, oldest first
 * @param {object} opts     { settings, playerName, authorName }
 * @returns {{ messages: {role:string, content:string}[] }}
 */
export function buildTrackerPrompt(state, recent, opts = {}) {
    const { settings = {}, playerName, authorName, firstTurn = false, srcIsUser = false } = opts;
    const narratorName = settings.narratorName || '';
    const sys = settings.promptOverrides?.system || DEFAULT_SYSTEM;
    const cap = Number(settings.maxMessageChars) || 1500;
    const sec = settings.sections || {};
    const L = [];

    const allNames = sec.characters !== false ? Object.keys(state.characters) : [];
    const writable = writableNames(state, authorName, narratorName, playerName, srcIsUser).filter((n) => allNames.includes(n));
    const others = allNames.filter((n) => !writable.includes(n));

    L.push('CURRENT WORLD STATE — reply with this object, updated:');
    L.push('```json');
    L.push(JSON.stringify(currentAsJson(state, sec, firstTurn, writable), null, 2));
    L.push('```');

    const notes = constraintNotes(state, sec, firstTurn, writable);
    if (notes.length) {
        L.push('');
        L.push('Constraints:');
        L.push(...notes);
    }

    if (allNames.length) {
        L.push('');
        if (writable.length) {
            L.push(`Your "characters" object MUST contain one entry per name, for every one of: ${writable.join(', ')}, with ALL of that character's fields present.`);
            L.push(`Fields shown as "?" are unknown — replace each with what the recent messages show about THAT character (their outfit, pose, position, physical status, where they are). Keep "?" only if the scene genuinely says nothing about it. Base a character's fields on how THEY are described and acted on, never on another character's details.`);
        }
        const authorCard = writable.find((n) => nameEq(n, authorName) && n !== playerName);
        if (authorCard) {
            L.push(`${authorCard} wrote the latest message — update ${authorCard}'s own pose, position, state of dress, status and appearance from what it and the narration describe. Do not fold ${authorCard}'s state into another character.`);
        }
        if (others.length) {
            L.push(`Other characters in the scene are context only — do NOT put them in your reply: ${others.join(', ')}.`);
        }
        if (playerName && writable.includes(playerName)) {
            L.push(`${playerName} is the player and a tracked character — update ${playerName}'s state from their own messages and the narration.`);
        } else if (playerName) {
            L.push(`Never report the player (${playerName}).`);
        }
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
