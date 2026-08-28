// WorldTracker — small pure display helpers shared by the banner, detail sheet,
// review queue and inline card.

import * as clock from '../clock.js';

/** Text shown for a field's current value. */
export function displayValue(path, field, state) {
    if (!field) return '—';
    if (path === 'clock') {
        return clock.format(state?.clock?.iso, state?.clock?.displayFormat);
    }
    const v = field.value;
    if (v === '' || v == null) return '—';
    if (field.type === 'number' && field.unit) return `${v}${field.unit}`;
    if (field.type === 'number' && field.max != null) return `${v}/${field.max}`;
    return String(v);
}

/** Escape for insertion as text content inside a template string. */
export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
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
