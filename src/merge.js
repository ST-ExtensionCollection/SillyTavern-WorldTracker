// WorldTracker — turn a parsed tracker response into proposed changes.
//
// diffToProposals() compares the model's partial response against the canonical
// state and returns an array of proposal objects. It never mutates state and
// never touches locked fields. applyProposal() commits one proposal.

import { addElapsed, format, deltaToSeconds } from './clock.js';
import * as state from './state.js';

/** Loose equality for field values (trim strings, compare numbers numerically). */
function sameValue(field, incoming) {
    const cur = field.value;
    if (field.type === 'number') return Number(cur) === Number(incoming);
    return String(cur ?? '').trim() === String(incoming ?? '').trim();
}

function coerce(field, v) {
    if (field.type === 'number') {
        let n = Number(v);
        if (!Number.isFinite(n)) return field.value;
        if (field.max != null) n = Math.max(0, Math.min(field.max, Math.round(n)));
        return n;
    }
    return typeof v === 'string' ? v.trim() : v;
}

function displayVal(field, v, state_) {
    if (field?.type === 'number' && field.unit) return `${v}${field.unit}`;
    if (field?.type === 'number' && field.max != null) return `${v}/${field.max}`;
    return String(v);
}

function fieldProposal(path, label, field, incoming, state_, sourceMessageId) {
    const to = coerce(field, incoming);
    return {
        path, label, kind: 'field',
        from: displayVal(field, field.value, state_),
        to: displayVal(field, to, state_),
        rawTo: to,
        sourceMessageId,
    };
}

/**
 * @param {object} st       canonical state
 * @param {object} data     parsed partial { clock?, world?, userStats?, characters? }
 * @param {object} opts     { sourceMessageId }
 * @returns {Array} proposals
 */
export function diffToProposals(st, data, opts = {}) {
    const { sourceMessageId = null } = opts;
    const out = [];
    if (!data || typeof data !== 'object') return out;

    // --- clock ---
    if (data.clock && st.clock && !st.clock.locked) {
        const elapsed = data.clock.elapsed && typeof data.clock.elapsed === 'object'
            ? data.clock.elapsed
            : data.clock;
        if (deltaToSeconds(elapsed) > 0) {
            const toIso = addElapsed(st.clock.iso, elapsed);
            if (toIso !== st.clock.iso) {
                out.push({
                    path: 'clock', kind: 'clock', label: 'Time',
                    from: format(st.clock.iso, st.clock.displayFormat),
                    to: format(toIso, st.clock.displayFormat),
                    fromIso: st.clock.iso, toIso, elapsed,
                    sourceMessageId,
                });
            }
        }
    }

    // --- world ---
    if (data.world && typeof data.world === 'object') {
        for (const [k, v] of Object.entries(data.world)) {
            const f = st.world[k];
            if (!f || f.locked || v == null || sameValue(f, v)) continue;
            out.push(fieldProposal(`world.${k}`, k, f, v, st, sourceMessageId));
        }
    }

    // --- user stats ---
    if (data.userStats && typeof data.userStats === 'object') {
        for (const [k, v] of Object.entries(data.userStats)) {
            const f = st.userStats[k];
            if (!f || f.locked || v == null) continue;
            const nv = coerce(f, v);
            if (sameValue(f, nv)) continue;
            out.push(fieldProposal(`userStats.${k}`, k, f, nv, st, sourceMessageId));
        }
    }

    // --- characters ---
    if (data.characters && typeof data.characters === 'object') {
        for (const [name, fields] of Object.entries(data.characters)) {
            const entry = st.characters[name];
            if (!entry) {
                out.push({
                    path: `characters.${name}`, kind: 'new-character', label: `Track ${name}`,
                    from: '—', to: name, rawTo: { name, fields: fields || {} },
                    sourceMessageId,
                });
                continue;
            }
            for (const [fk, v] of Object.entries(fields || {})) {
                const f = entry.fields[fk];
                if (!f || f.locked || v == null || sameValue(f, v)) continue;
                out.push(fieldProposal(`characters.${name}.fields.${fk}`, `${name} · ${fk}`, f, v, st, sourceMessageId));
            }
        }
    }

    return out;
}

/** Commit one proposal to the canonical state. */
export function applyProposal(st, p, schema) {
    if (!p) return;
    if (p.kind === 'clock') {
        st.clock.iso = p.toIso;
        state.save();
        return;
    }
    if (p.kind === 'new-character') {
        const entry = state.ensureCharacter(st, p.rawTo.name, schema);
        for (const [fk, v] of Object.entries(p.rawTo.fields || {})) {
            const f = entry.fields[fk];
            if (f && !f.locked && v != null) f.value = coerce(f, v);
        }
        state.save();
        return;
    }
    state.applyValue(st, p.path, p.rawTo ?? p.to, p.sourceMessageId);
}
