// WorldTracker — in-world clock helpers. Dependency-free.
//
// The canonical clock is an ISO-ish local datetime string ("YYYY-MM-DDTHH:mm:ss").
// The model is only ever asked for ELAPSED time; we do the arithmetic here so the
// date/year can never drift.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse "YYYY-MM-DDTHH:mm:ss" (or with space) into a Date in local time. */
export function parseIso(iso) {
    if (iso instanceof Date) return new Date(iso.getTime());
    const s = String(iso ?? '').trim().replace(' ', 'T');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) {
        const d = new Date(s);
        return isNaN(d.getTime()) ? new Date() : d;
    }
    return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
    );
}

function pad(n, w = 2) {
    return String(Math.abs(n)).padStart(w, '0');
}

/** Serialize a Date back to canonical "YYYY-MM-DDTHH:mm:ss". */
export function toIso(date) {
    const d = date instanceof Date ? date : parseIso(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Add an elapsed delta to an ISO string. delta = { days, hours, minutes,
 * seconds } (any missing/negative-safe). Returns a new ISO string.
 */
export function addElapsed(iso, delta) {
    const d = parseIso(iso);
    const days = Math.max(0, Number(delta?.days) || 0);
    const hours = Math.max(0, Number(delta?.hours) || 0);
    const minutes = Math.max(0, Number(delta?.minutes) || 0);
    const seconds = Math.max(0, Number(delta?.seconds) || 0);
    d.setSeconds(d.getSeconds() + seconds + minutes * 60 + hours * 3600 + days * 86400);
    return toIso(d);
}

/** Total seconds represented by a { days, hours, minutes, seconds } delta. */
export function deltaToSeconds(delta) {
    return (Math.max(0, Number(delta?.days) || 0) * 86400)
        + (Math.max(0, Number(delta?.hours) || 0) * 3600)
        + (Math.max(0, Number(delta?.minutes) || 0) * 60)
        + Math.max(0, Number(delta?.seconds) || 0);
}

/**
 * Minimal date-fns-ish formatter. Supported tokens:
 *   yyyy  4-digit year        yy  2-digit year
 *   MMMM  full month          MMM month abbr    MM  2-digit month   M  month
 *   dd    2-digit day         d   day
 *   EEEE  full weekday        EEE weekday abbr
 *   HH    2-digit 24h hour    H   24h hour
 *   hh    2-digit 12h hour    h   12h hour
 *   mm    2-digit minute      m   minute
 *   ss    2-digit second
 *   a     am/pm
 * Anything in single quotes is literal.
 */
export function format(iso, pattern) {
    const d = parseIso(iso);
    const h24 = d.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const map = {
        yyyy: d.getFullYear(),
        yy: pad(d.getFullYear() % 100),
        MMMM: MONTHS_LONG[d.getMonth()],
        MMM: MONTHS[d.getMonth()],
        MM: pad(d.getMonth() + 1),
        M: d.getMonth() + 1,
        dd: pad(d.getDate()),
        d: d.getDate(),
        EEEE: DAYS_LONG[d.getDay()],
        EEE: DAYS[d.getDay()],
        HH: pad(h24),
        H: h24,
        hh: pad(h12),
        h: h12,
        mm: pad(d.getMinutes()),
        m: d.getMinutes(),
        ss: pad(d.getSeconds()),
        a: h24 < 12 ? 'am' : 'pm',
    };
    const tokens = ['yyyy', 'yy', 'MMMM', 'MMM', 'MM', 'M', 'dd', 'd', 'EEEE', 'EEE', 'HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 'a'];
    const re = new RegExp(`'[^']*'|${tokens.join('|')}`, 'g');
    return String(pattern ?? 'yyyy-MM-dd HH:mm').replace(re, (t) => {
        if (t.startsWith("'")) return t.slice(1, -1);
        return String(map[t]);
    });
}

/** Short human diff between two ISO strings, e.g. "+2h 15m" or "+30s". '' if equal/backwards. */
export function humanDelta(fromIso, toIso_) {
    let secs = Math.round((parseIso(toIso_).getTime() - parseIso(fromIso).getTime()) / 1000);
    if (secs <= 0) return '';
    const days = Math.floor(secs / 86400); secs -= days * 86400;
    const hours = Math.floor(secs / 3600); secs -= hours * 3600;
    const mins = Math.floor(secs / 60); secs -= mins * 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    if (secs) parts.push(`${secs}s`);
    return parts.length ? `+${parts.join(' ')}` : '';
}
