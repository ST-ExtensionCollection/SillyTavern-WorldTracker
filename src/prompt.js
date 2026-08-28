// WorldTracker — builds the extraction query sent to the tracker model.
//
// The model is shown the current canonical state and the recent messages, and
// asked to return ONE JSON object describing the current state. Locked fields
// are presented as immutable. The clock is asked for ELAPSED time only, never an
// absolute date — WorldTracker does the date arithmetic itself.

import { format } from './clock.js';

const DEFAULT_SYSTEM =
    'You are a world-state tracker for a roleplay. Read the recent messages and report the CURRENT world state as a single JSON object. '
    + 'Output ONLY the JSON object — no prose, no explanation, no markdown fence commentary. '
    + 'For every field: if the recent messages show it changed, report the new value; otherwise repeat the current value unchanged. '
    + 'Never invent detail that is not supported by the messages or the current state.';

function fmtClock(state) {
    return format(state.clock.iso, state.clock.displayFormat);
}

/** A filled-in example object showing the exact shape wanted back. */
function exampleShape(state) {
    const ex = {};
    if (state.clock && !state.clock.locked) {
        ex.clock = { elapsed: { days: 0, hours: 0, minutes: 1, seconds: 0 } };
    }
    if (Object.keys(state.world).length) {
        ex.world = {};
        for (const [k, f] of Object.entries(state.world)) {
            ex.world[k] = f.type === 'number' ? 0 : 'string';
        }
    }
    if (Object.keys(state.userStats).length) {
        ex.userStats = {};
        for (const k of Object.keys(state.userStats)) ex.userStats[k] = 0;
    }
    const names = Object.keys(state.characters);
    if (names.length) {
        ex.characters = {};
        for (const name of names) {
            const c = state.characters[name];
            ex.characters[name] = {};
            for (const [fk, ff] of Object.entries(c.fields)) {
                ex.characters[name][fk] = ff.type === 'enum' && Array.isArray(ff.options)
                    ? (ff.options[0] ?? 'string')
                    : (ff.type === 'number' ? 0 : 'string');
            }
        }
    }
    return ex;
}

/**
 * @param {object} state    canonical world state
 * @param {Array}  recent   [{ name, is_user, mes }] recent chat messages, oldest first
 * @param {object} opts     { settings, playerName }
 * @returns {{ messages: {role:string, content:string}[] }}
 */
export function buildTrackerPrompt(state, recent, opts = {}) {
    const { settings = {}, playerName } = opts;
    const sys = settings.promptOverrides?.system || DEFAULT_SYSTEM;
    const L = [];

    L.push('== CURRENT STATE ==');

    if (state.clock) {
        if (state.clock.locked) {
            L.push(`Time: LOCKED at "${fmtClock(state)}". Do NOT report elapsed time.`);
        } else {
            L.push(`Time: the last update was at in-world time "${fmtClock(state)}". Report ONLY how much IN-WORLD time has passed since then as clock.elapsed = { days, hours, minutes, seconds }. Back-and-forth dialogue is usually seconds. If nothing indicates a jump, use a small value. Do NOT output an absolute date or time.`);
        }
    }

    for (const [k, f] of Object.entries(state.world)) {
        const unit = f.type === 'number' && f.unit ? ` ${f.unit}` : '';
        if (f.locked) L.push(`${k}: LOCKED = ${JSON.stringify(f.value)}${unit}. Repeat exactly, never change.`);
        else L.push(`${k}: currently ${JSON.stringify(f.value)}${unit}.`);
    }

    for (const [k, f] of Object.entries(state.userStats)) {
        const range = f.max != null ? ` (0–${f.max})` : '';
        if (f.locked) L.push(`${k}: LOCKED = ${f.value}${range}. Repeat exactly.`);
        else L.push(`${k}: currently ${f.value}${range}.`);
    }

    const names = Object.keys(state.characters);
    if (names.length) {
        L.push('');
        L.push(`Characters — report these NPCs only${playerName ? `, never the player (${playerName})` : ''}:`);
        for (const name of names) {
            const c = state.characters[name];
            const bits = Object.entries(c.fields).map(([fk, ff]) => {
                if (ff.locked) return `${fk}=LOCKED(${JSON.stringify(ff.value)})`;
                if (ff.type === 'enum' && Array.isArray(ff.options)) return `${fk} (one of: ${ff.options.join(', ')})`;
                return fk;
            });
            L.push(`- ${name}: ${bits.join('; ')}`);
        }
    }

    L.push('');
    L.push('== RETURN EXACTLY THIS SHAPE ==');
    L.push('```json');
    L.push(JSON.stringify(exampleShape(state), null, 2));
    L.push('```');
    L.push('Omit any key you have no update for. Locked fields: repeat their current value, do not change.');

    if (settings.promptOverrides?.instruction) {
        L.push('');
        L.push(settings.promptOverrides.instruction);
    }

    L.push('');
    L.push('== RECENT MESSAGES ==');
    for (const m of recent) {
        const who = m.is_user ? (playerName || 'User') : (m.name || 'Character');
        L.push(`${who}: ${String(m.mes ?? '').trim()}`);
    }

    return {
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: L.join('\n') },
        ],
    };
}
