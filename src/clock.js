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
 * Add an elapsed delta to an ISO string. delta = { days, hours, minutes } (any
 * missing/negative-safe). Returns a new ISO string.
 */
export function addElapsed(iso, delta) {
    const d = parseIso(iso);
    const days = Math.max(0, Number(delta?.days) || 0);
    const hours = Math.max(0, Number(delta?.hours) || 0);
    const minutes = Math.max(0, Number(delta?.minutes) || 0);
    d.setMinutes(d.getMinutes() + minutes + hours * 60 + days * 24 * 60);
    return toIso(d);
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

/** Short human diff between two ISO strings, e.g. "+2h 15m". '' if equal/backwards. */
export function humanDelta(fromIso, toIso_) {
    let ms = parseIso(toIso_).getTime() - parseIso(fromIso).getTime();
    if (ms <= 0) return '';
    let mins = Math.round(ms / 60000);
    const days = Math.floor(mins / 1440); mins -= days * 1440;
    const hours = Math.floor(mins / 60); mins -= hours * 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    return parts.length ? `+${parts.join(' ')}` : '';
}
