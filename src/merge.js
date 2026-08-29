// WorldTracker — turn a parsed tracker response into proposed changes.
//
// diffToProposals() compares the model's partial response against the canonical
// state and returns an array of proposal objects. It never mutates state and
// never touches locked fields. applyProposal() commits one proposal.

import { addElapsed, format, deltaToSeconds, toIso as isoOf, humanDelta } from './clock.js';
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
        const fromIso = st.clock.iso;

        if (sourceMessageId === 0) {
            // First message: pick up an absolute in-world date/time if the scene
            // states or implies one. Never auto-advance by the expected interval
            // here — there is no "previous turn" to have elapsed from.
            const raw = (data.clock.datetime ?? data.clock.iso)
                ?? (typeof data.clock === 'string' ? data.clock : null);
            let nextIso = null;
            if (raw != null && String(raw).trim()) {
                try { nextIso = isoOf(raw); } catch { nextIso = null; }
            }
            if (nextIso && nextIso !== fromIso) {
                out.push({
                    path: 'clock', kind: 'clock', label: 'Time',
                    from: format(fromIso, st.clock.displayFormat),
                    to: format(nextIso, st.clock.displayFormat),
                    fromIso, toIso: nextIso, elapsed: null, absolute: true,
                    sourceMessageId,
                });
            }
        } else {
            let elapsed = data.clock.elapsed && typeof data.clock.elapsed === 'object'
                ? data.clock.elapsed
                : data.clock;
            // Model reported 0/0/0/0 (or nothing usable) — fall back to the
            // user's "Expected next" interval so time still moves.
            let usedExpected = false;
            if (deltaToSeconds(elapsed) <= 0 && deltaToSeconds(st.clock.expectedInterval) > 0) {
                elapsed = st.clock.expectedInterval;
                usedExpected = true;
            }
            if (deltaToSeconds(elapsed) > 0) {
                const nextIso = addElapsed(fromIso, elapsed);
                if (nextIso !== fromIso) {
                    const fromF = format(fromIso, st.clock.displayFormat);
                    const toF = format(nextIso, st.clock.displayFormat);
                    out.push({
                        path: 'clock', kind: 'clock', label: 'Time',
                        from: fromF,
                        // Sub-display-precision jumps (e.g. +30s with an HH:mm
                        // format) would show "X -> X"; append the real delta.
                        to: fromF === toF ? `${toF} (${humanDelta(fromIso, nextIso)})` : toF,
                        fromIso, toIso: nextIso, elapsed,
                        expected: usedExpected,
                        sourceMessageId,
                    });
                }
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

/**
 * Commit one proposal to the canonical state.
 * @returns a history change `{ path, label, kind, before, after, rawBefore, rawAfter, beforeIso?, afterIso? }`
 *          (or null). Callers collect these into one `pushHistory` record per batch.
 */
export function applyProposal(st, p, schema) {
    if (!p) return null;

    if (p.kind === 'clock') {
        const beforeIso = st.clock.iso;
        st.clock.iso = p.toIso;
        state.save();
        const bf = format(beforeIso, st.clock.displayFormat);
        const af = format(p.toIso, st.clock.displayFormat);
        return {
            path: 'clock', label: 'Time', kind: 'clock',
            before: bf,
            after: (bf === af && !p.absolute) ? `${af} (${humanDelta(beforeIso, p.toIso)})` : af,
            beforeIso, afterIso: p.toIso, rawBefore: beforeIso, rawAfter: p.toIso,
        };
    }

    if (p.kind === 'presence') {
        const entry = st.characters[p.path.split('.')[1]];
        const was = entry ? entry.present !== false : true;
        if (entry) {
            entry.present = !!p.rawTo;
            if (!entry.present) entry.lastPresentTs = Date.now();
        }
        state.save();
        return {
            path: p.path, label: p.label, kind: 'presence',
            before: was ? 'present' : 'away', after: p.rawTo ? 'present' : 'away',
            rawBefore: was, rawAfter: !!p.rawTo,
        };
    }

    if (p.kind === 'rel') {
        const parts = p.path.split('.'); // characters, <name>, rels, <obj...>
        const entry = st.characters[parts[1]];
        const obj = parts.slice(3).join('.');
        const was = entry?.rels?.[obj];
        if (entry) {
            if (!entry.rels) entry.rels = {};
            if (p.rawTo == null || p.rawTo === '') delete entry.rels[obj];
            else entry.rels[obj] = p.rawTo;
        }
        state.save();
        return {
            path: p.path, label: p.label, kind: 'rel',
            before: was || '—', after: p.rawTo || '—', rawBefore: was ?? '', rawAfter: p.rawTo ?? '',
        };
    }

    if (p.kind === 'new-character') {
        const entry = state.ensureCharacter(st, p.rawTo.name, schema);
        for (const [fk, v] of Object.entries(p.rawTo.fields || {})) {
            if (fk === 'present') { entry.present = v !== false; continue; }
            const f = entry.fields[fk];
            if (f && !f.locked && v != null) f.value = coerce(f, v);
        }
        state.save();
        return {
            path: p.path, label: p.label, kind: 'new-character',
            before: '—', after: p.rawTo.name, rawBefore: null, rawAfter: p.rawTo,
        };
    }

    // field
    const f = state.fieldAt(st, p.path);
    const rawBefore = f ? f.value : undefined;
    const before = f ? displayVal(f, f.value) : (p.from ?? '—');
    state.applyValue(st, p.path, p.rawTo ?? p.to, p.sourceMessageId);
    return {
        path: p.path, label: p.label, kind: 'field',
        before, after: p.to, rawBefore, rawAfter: p.rawTo ?? p.to,
    };
}
