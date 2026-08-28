// WorldTracker — tolerant parser for the tracker model's reply.
//
// Never throws. Returns { ok, data, raw }. `data` is a partial object with any
// of: clock.elapsed, world{}, userStats{}, characters{}. Missing keys just mean
// "no update" — the caller keeps the current value.

const ENVELOPE_KEYS = ['tracker', 'trackers', 'state', 'world_state', 'worldstate', 'result', 'data', 'update', 'json'];

/**
 * Strip reasoning / channel noise. Handles: ST's configured reasoning template
 * (<think>…</think> by default, user-set), generic <thinking>/<thought>, and
 * OpenAI "harmony" channel markup (<|channel|>analysis<|message|>…<|end|>,
 * <|start|>assistant…). If harmony `final` channel is present, keep only what
 * follows it.
 */
function preclean(s) {
    let t = String(s);

    // ST reasoning template (prefix…suffix), non-strict.
    try {
        const parse = globalThis.SillyTavern?.getContext?.().parseReasoningFromString;
        if (typeof parse === 'function') {
            const r = parse(t, { strict: false });
            if (r && r.content) t = r.content;
        }
    } catch { /* ignore */ }

    // Harmony: if there's a final channel, everything before it is reasoning.
    const finalMarker = t.match(/<\|?channel\|?>\s*final\b[\s\S]{0,40}?<\|?message\|?>/i);
    if (finalMarker) t = t.slice(finalMarker.index + finalMarker[0].length);

    t = t
        .replace(/<\|?channel\|?>[\s\S]*?<\|?message\|?>/gi, '')
        .replace(/<\|?(?:start|end|return|constrain|message|channel)\|?>/gi, '')
        .replace(/<\|?channel\|?>\s*\w+/gi, '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<\/?(?:think|thinking|thought|reasoning|analysis)>/gi, '');

    return t.trim();
}

/** Light JSON repair: trailing commas, smart quotes, JS-style comments. */
function repair(s) {
    return s
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\/\/[^\n\r]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([}\]])/g, '$1');
}

function tryParse(chunk) {
    if (!chunk || typeof chunk !== 'string') return null;
    const attempts = [chunk, repair(chunk)];
    for (const a of attempts) {
        try {
            const v = JSON.parse(a);
            if (v && typeof v === 'object') return v;
        } catch { /* next */ }
    }
    return null;
}

/** Every balanced {...} block, string/escape aware, outermost first. */
function scanObjects(s) {
    const out = [];
    let depth = 0, start = -1, inStr = false, quote = '', esc = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === quote) inStr = false;
            continue;
        }
        if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
        if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; }
        }
    }
    return out;
}

function unwrap(obj) {
    let cur = obj;
    for (let i = 0; i < 4; i++) {
        if (!cur || typeof cur !== 'object') break;
        const keys = Object.keys(cur);
        if (keys.length === 1 && ENVELOPE_KEYS.includes(keys[0].toLowerCase()) && cur[keys[0]] && typeof cur[keys[0]] === 'object') {
            cur = cur[keys[0]];
        } else break;
    }
    return cur;
}

/** Does this object look like tracker data we can use? */
function looksLikeTracker(o) {
    if (!o || typeof o !== 'object') return false;
    return ['clock', 'world', 'userStats', 'characters', 'time', 'elapsed'].some((k) => k in o);
}

/**
 * Normalize a parsed object into the canonical partial shape.
 * Tolerates a few common variants (time/elapsed at top level, etc.).
 */
function normalize(o) {
    const out = {};
    if (o.clock && typeof o.clock === 'object') {
        out.clock = o.clock.elapsed ? { elapsed: o.clock.elapsed } : o.clock;
    } else if (o.elapsed && typeof o.elapsed === 'object') {
        out.clock = { elapsed: o.elapsed };
    }
    if (o.world && typeof o.world === 'object') out.world = { ...o.world };
    if (o.userStats && typeof o.userStats === 'object') out.userStats = { ...o.userStats };
    else if (o.stats && typeof o.stats === 'object') out.userStats = { ...o.stats };
    if (o.characters && typeof o.characters === 'object') out.characters = { ...o.characters };
    return out;
}

export function parseTrackerResponse(text) {
    const raw = text;
    if (!text) return { ok: false, data: null, raw };
    const s = preclean(text);

    const candidates = [];
    const fence = s.match(/```(?:json|json5)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1].trim());
    candidates.push(...scanObjects(s));
    candidates.push(s);

    for (const c of candidates) {
        const parsed = tryParse(c);
        if (!parsed) continue;
        const inner = unwrap(parsed);
        if (looksLikeTracker(inner)) return { ok: true, data: normalize(inner), raw };
    }

    // Last resort: a bare object that parsed but didn't match the shape — still
    // hand it back so the caller can log it.
    for (const c of candidates) {
        const parsed = tryParse(c);
        if (parsed) return { ok: false, data: unwrap(parsed), raw };
    }
    return { ok: false, data: null, raw };
}
