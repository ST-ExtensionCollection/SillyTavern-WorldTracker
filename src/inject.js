// WorldTracker — injects the canonical state into the main chat prompt so the
// roleplay model actually sees the tracked world (time, location, weather,
// stats, characters). Uses setExtensionPrompt at IN_CHAT depth, SYSTEM role.

import { format } from './clock.js';
import { fmtNum } from './ui/format.js';
import { vlog } from './log.js';

const KEY = 'worldtracker-state';
const IN_CHAT = 1;   // extension_prompt_types.IN_CHAT
const SYSTEM = 0;    // extension_prompt_roles.SYSTEM

/** Compact human-readable dump of the state. */
export function buildSummary(st, sec = {}) {
    if (!st) return '';
    const lines = ['[World State]'];
    if (st.clock) lines.push(`Time: ${format(st.clock.iso, st.clock.displayFormat)}`);
    if (sec.world !== false) {
        for (const [k, f] of Object.entries(st.world)) {
            const v = f.type === 'number' && f.unit ? `${fmtNum(f.value)}${f.unit}` : f.value;
            if (v !== '' && v != null) lines.push(`${cap(k)}: ${v}`);
        }
    }
    if (sec.userStats) {
        const stats = Object.entries(st.userStats)
            .map(([k, f]) => `${k} ${fmtNum(f.value)}${f.max != null ? `/${fmtNum(f.max)}` : ''}`);
        if (stats.length) lines.push(`You — ${stats.join(', ')}`);
    }
    if (sec.characters !== false) {
        for (const [name, c] of Object.entries(st.characters)) {
            // Absent characters don't clutter the scene: one who has been in a
            // scene before gets a bare "not present" note (so the model doesn't
            // write them in); one who never appeared is omitted entirely.
            if (c.present === false) {
                if (c.lastPresentTs) lines.push(`${name} — not present`);
                continue;
            }
            const bits = Object.entries(c.fields)
                .filter(([, f]) => f.value !== '' && f.value != null)
                .map(([fk, f]) => `${fk}: ${f.value}`);
            if (c.rels && Object.keys(c.rels).length) {
                const groups = {};
                for (const [obj, rel] of Object.entries(c.rels)) (groups[rel] ||= []).push(obj);
                bits.push('rels: ' + Object.entries(groups).map(([r, ns]) => `${r}→${ns.join(',')}`).join('; '));
            }
            if (bits.length) lines.push(`${name} — ${bits.join('; ')}`);
        }
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Push (or clear) the injection.
 * @param {object} ctx       SillyTavern context
 * @param {object|null} st   canonical state, or null to clear
 * @param {object} settings
 */
export function updateInjection(ctx, st, settings) {
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const enabled = settings?.enabled && settings?.injectState !== false;
    const text = enabled ? buildSummary(st, settings?.sections || {}) : '';
    const depth = Math.max(0, Number(settings?.injectionDepth) || 0);
    ctx.setExtensionPrompt(KEY, text, IN_CHAT, depth, false, SYSTEM);
    vlog(text ? `injected world state (${text.length} chars, depth ${depth})` : 'cleared world-state injection');
}
