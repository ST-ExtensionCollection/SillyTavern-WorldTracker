// WorldTracker — small pure display helpers shared by the banner, detail sheet,
// review queue and inline card.

import * as clock from '../clock.js';

/** Group digits with thousands separators; pass non-numbers through. */
export function fmtNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** Text shown for a field's current value. */
export function displayValue(path, field, state) {
    if (!field) return '—';
    if (path === 'clock') {
        return clock.format(state?.clock?.iso, state?.clock?.displayFormat);
    }
    const v = field.value;
    if (v === '' || v == null) return '—';
    if (field.type === 'number' && field.unit) return `${fmtNum(v)}${field.unit}`;
    if (field.type === 'number' && field.max != null) return `${fmtNum(v)}/${fmtNum(field.max)}`;
    if (field.type === 'number') return fmtNum(v);
    return String(v);
}

/** Escape for insertion as text content inside a template string. */
export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const WS_RE = /^\s+$/;

/** Split into whitespace / word / punctuation tokens, preserving all three so
 *  list edits ("a, b, c" -> "a, c, d") diff at the item, not the whole tail. */
function tokenize(s) {
    return String(s ?? '').match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) || [];
}

/**
 * Word-level diff between two display strings. Returns `fromHtml` (unchanged
 * runs plain, removed runs wrapped in `.wt-del`) and `toHtml` (unchanged runs
 * plain, added runs wrapped in `.wt-ins`), plus `common` = the number of shared
 * non-whitespace tokens. `common === 0` means the two values share nothing, so
 * a caller may prefer blanket old/new styling over a token diff.
 */
export function wordDiff(fromStr, toStr) {
    const a = tokenize(fromStr);
    const b = tokenize(toStr);
    const n = a.length;
    const m = b.length;

    // LCS table, filled from the back so a forward walk can pick the longer run.
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const ops = []; // ['eq' | 'del' | 'ins', token]
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push(['eq', a[i]]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['del', a[i]]); i++; }
        else { ops.push(['ins', b[j]]); j++; }
    }
    while (i < n) ops.push(['del', a[i++]]);
    while (j < m) ops.push(['ins', b[j++]]);

    let common = 0;
    for (const [t, s] of ops) if (t === 'eq' && !WS_RE.test(s)) common++;

    const side = (mark, cls) => {
        let html = '';
        let run = '';
        const flush = () => {
            if (run) { html += `<span class="${cls}">${esc(run)}</span>`; run = ''; }
        };
        for (const [t, s] of ops) {
            if (t === 'eq') { flush(); html += esc(s); }
            else if (t === mark) { run += s; }
        }
        flush();
        return html;
    };

    return { common, fromHtml: side('del', 'wt-del'), toHtml: side('ins', 'wt-ins') };
}

/**
 * Inner HTML for a `.wt-review-diff` row. Word-level strike/insert when the two
 * values share tokens (minor tweaks to long lists — clothes, pose — read as a
 * diff, no manual spot-the-difference); blanket old -> new otherwise.
 */
export function renderDiff(from, to) {
    const f = from == null ? '—' : String(from);
    const t = to == null ? '—' : String(to);
    const arrow = '<i class="fa-solid fa-arrow-right"></i>';
    if (f !== '—' && t !== '—' && f !== t) {
        const d = wordDiff(f, t);
        if (d.common > 0) {
            return `<span class="wt-from wt-tok">${d.fromHtml}</span>${arrow}<span class="wt-to wt-tok">${d.toHtml}</span>`;
        }
    }
    return `<span class="wt-from">${esc(f)}</span>${arrow}<span class="wt-to">${esc(t)}</span>`;
}

/** FontAwesome icon name for a well-known field key (best-effort). */
export function iconFor(key) {
    const k = String(key).toLowerCase();
    if (k === 'clock' || k === 'time') return 'fa-clock';
    if (k.includes('location')) return 'fa-location-dot';
    if (k.includes('weather')) return 'fa-cloud-sun';
    if (k.includes('temp')) return 'fa-temperature-half';
    if (k.includes('health') || k.includes('hp')) return 'fa-heart';
    if (k.includes('energy') || k.includes('stamina')) return 'fa-bolt';
    if (k.includes('relationship')) return 'fa-hand-holding-heart';
    if (k.includes('status')) return 'fa-circle-info';
    return 'fa-tag';
}
