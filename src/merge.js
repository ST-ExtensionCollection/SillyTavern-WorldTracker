// WorldTracker — turn a parsed tracker response into proposed changes.
//
// diffToProposals() compares the model's partial response against the canonical
// state and returns an array of proposal objects. It never mutates state and
// never touches locked fields. applyProposal() commits one proposal.

import { addElapsed, format, deltaToSeconds } from './clock.js';
import { fmtNum } from './ui/format.js';
import { inScope } from './prompt.js';
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

function displayVal(field, v) {
    if (field?.type === 'number' && field.unit) return `${fmtNum(v)}${field.unit}`;
    if (field?.type === 'number' && field.max != null) return `${fmtNum(v)}/${fmtNum(field.max)}`;
    if (field?.type === 'number') return fmtNum(v);
    return String(v);
}

function fieldProposal(path, label, field, incoming, sourceMessageId) {
    const to = coerce(field, incoming);
    return {
        path, label, kind: 'field',
        from: displayVal(field, field.value),
        to: displayVal(field, to),
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
    const { sourceMessageId = null, authorName = null, sections = {}, narratorName = '', playerName = '' } = opts;
    const out = [];
    if (!data || typeof data !== 'object') return out;

    // --- clock ---
    if (data.clock && st.clock && !st.clock.locked) {
        let elapsed = data.clock.elapsed && typeof data.clock.elapsed === 'object'
            ? data.clock.elapsed
            : data.clock;
        // Model reported 0/0/0/0 (or nothing usable) — it didn't really answer.
        // Fall back to the user's "Expected next" interval so time still moves.
        let usedExpected = false;
        if (deltaToSeconds(elapsed) <= 0 && deltaToSeconds(st.clock.expectedInterval) > 0) {
            elapsed = st.clock.expectedInterval;
            usedExpected = true;
        }
        if (deltaToSeconds(elapsed) > 0) {
            const toIso = addElapsed(st.clock.iso, elapsed);
            if (toIso !== st.clock.iso) {
                out.push({
                    path: 'clock', kind: 'clock', label: 'Time',
                    from: format(st.clock.iso, st.clock.displayFormat),
                    to: format(toIso, st.clock.displayFormat),
                    fromIso: st.clock.iso, toIso, elapsed,
                    expected: usedExpected,
                    sourceMessageId,
                });
            }
        }
    }

    // --- world ---
    if (sections.world !== false && data.world && typeof data.world === 'object') {
        for (const [k, v] of Object.entries(data.world)) {
            const f = st.world[k];
            if (!f || f.locked || v == null || sameValue(f, v)) continue;
            out.push(fieldProposal(`world.${k}`, k, f, v, sourceMessageId));
        }
    }

    // --- user stats ---
    if (sections.userStats && data.userStats && typeof data.userStats === 'object') {
        for (const [k, v] of Object.entries(data.userStats)) {
            const f = st.userStats[k];
            if (!f || f.locked || v == null) continue;
            const nv = coerce(f, v);
            if (sameValue(f, nv)) continue;
            out.push(fieldProposal(`userStats.${k}`, k, f, nv, sourceMessageId));
        }
    }

    // --- characters ---
    if (sections.characters !== false && data.characters && typeof data.characters === 'object') {
        for (const [name, fields] of Object.entries(data.characters)) {
            const entry = st.characters[name];
            if (!entry) {
                // Only the narrator introduces new NPCs.
                if (inScope({ updater: 'narrator' }, name, authorName, narratorName)) {
                    out.push({
                        path: `characters.${name}`, kind: 'new-character', label: `Track ${name}`,
                        from: '—', to: name, rawTo: { name, fields: fields || {} },
                        sourceMessageId,
                    });
                }
                continue;
            }
            // Ownership: skip characters that aren't this turn's to update.
            if (!inScope(entry, name, authorName, narratorName, playerName)) continue;
            for (const [fk, v] of Object.entries(fields || {})) {
                if (fk === 'present') {
                    if (v == null || name === playerName) continue; // the player is always present
                    const cur = entry.present !== false;
                    const nv = !!v;
                    if (nv === cur) continue;
                    out.push({
                        path: `characters.${name}.present`, kind: 'presence', label: `${name} · presence`,
                        from: cur ? 'present' : 'away', to: nv ? 'present' : 'away', rawTo: nv,
                        sourceMessageId,
                    });
                    continue;
                }
                const f = entry.fields[fk];
                if (!f || f.locked || v == null || sameValue(f, v)) continue;
                out.push(fieldProposal(`characters.${name}.fields.${fk}`, `${name} · ${fk}`, f, v, sourceMessageId));
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
    if (p.kind === 'presence') {
        const name = p.path.split('.')[1];
        const entry = st.characters[name];
        if (entry) {
            entry.present = !!p.rawTo;
            if (!entry.present) entry.lastPresentTs = Date.now();
        }
        state.save();
        return;
    }
    if (p.kind === 'new-character') {
        const entry = state.ensureCharacter(st, p.rawTo.name, schema);
        for (const [fk, v] of Object.entries(p.rawTo.fields || {})) {
            if (fk === 'present') { entry.present = v !== false; continue; }
            const f = entry.fields[fk];
            if (f && !f.locked && v != null) f.value = coerce(f, v);
        }
        state.save();
        return;
    }
    state.applyValue(st, p.path, p.rawTo ?? p.to, p.sourceMessageId);
}
