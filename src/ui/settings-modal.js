// WorldTracker — the panel's gear-button settings dialog.
//
// Edits the field SCHEMA (world fields, user stats, character template fields,
// clock format) and the section toggles. On Save it hands back the rebuilt
// schema + sections; the caller persists and re-seeds the current chat.

import { defaultSchema } from '../schema.js';
import { groupMemberNames } from './panel.js';

const TYPES = ['text', 'number', 'enum'];
const DEFAULT_SECTIONS = { world: true, userStats: false, characters: true };

function esc(v) { return $('<i>').text(v == null ? '' : String(v)).html(); }

function fieldRow(kind, f = {}) {
    const isStat = kind === 'stat';
    const type = f.type || (isStat ? 'number' : 'text');
    const $r = $(`
        <div class="wt-cfg-row" data-kind="${kind}" data-default="${esc(f.default ?? '')}">
            <input type="text" class="text_pole wt-cfg-key" placeholder="name" value="${esc(f.key)}">
            ${isStat ? '' : `<select class="text_pole wt-cfg-type">${TYPES.map((t) => `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`).join('')}</select>`}
            ${isStat
        ? `<input type="number" class="text_pole wt-cfg-max" placeholder="max" value="${f.max ?? ''}" title="max value (blank = unbounded)">`
        : `<input type="text" class="text_pole wt-cfg-extra" placeholder="${type === 'number' ? 'unit' : type === 'enum' ? 'a, b, c' : ''}" value="${esc(type === 'enum' ? (f.options || []).join(', ') : (f.unit || ''))}">`}
            <button class="menu_button wt-cfg-del" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `);
    if (!isStat) {
        const $type = $r.find('.wt-cfg-type');
        const $extra = $r.find('.wt-cfg-extra');
        $type.on('change', () => {
            const t = $type.val();
            $extra.attr('placeholder', t === 'number' ? 'unit' : t === 'enum' ? 'a, b, c' : '').val('');
        });
    }
    $r.find('.wt-cfg-del').on('click', () => $r.remove());
    return $r;
}

function listSection(title, kind, list) {
    const $sec = $(`
        <div class="wt-cfg-sec">
            <div class="wt-cfg-sec-head">${title}
                <span class="wt-cfg-sec-actions">
                    <button class="menu_button wt-cfg-add"><i class="fa-solid fa-plus"></i> Add</button>
                    <button class="menu_button wt-cfg-reset" title="Reset this list to defaults"><i class="fa-solid fa-rotate-left"></i></button>
                </span>
            </div>
            <div class="wt-cfg-list"></div>
        </div>
    `);
    const $list = $sec.find('.wt-cfg-list');
    const fill = (arr) => { $list.empty(); for (const f of arr) $list.append(fieldRow(kind, f)); };
    fill(list);
    $sec.find('.wt-cfg-add').on('click', () => $list.append(fieldRow(kind, {})));
    $sec.find('.wt-cfg-reset').on('click', () => {
        const ds = defaultSchema();
        fill(kind === 'world' ? ds.world : kind === 'stat' ? ds.userStats : (ds.character?.fields || []));
    });
    return { $sec, $list };
}

function readRows($list, kind) {
    const out = [];
    $list.children('.wt-cfg-row').each(function () {
        const $r = $(this);
        const key = String($r.find('.wt-cfg-key').val() || '').trim();
        if (!key) return;
        if (kind === 'stat') {
            const max = $r.find('.wt-cfg-max').val();
            out.push({ key, label: key, type: 'number', max: max === '' ? undefined : Number(max), default: 0, lockedByDefault: false });
            return;
        }
        const type = $r.find('.wt-cfg-type').val() || 'text';
        const extra = String($r.find('.wt-cfg-extra').val() || '').trim();
        const prevDefault = $r.attr('data-default') || '';
        const f = { key, label: key, type, lockedByDefault: false, default: type === 'number' ? 0 : '' };
        if (type === 'number' && extra) f.unit = extra;
        if (type === 'enum') {
            f.options = extra.split(',').map((s) => s.trim()).filter(Boolean);
            // Keep the previous default if it's still a valid option.
            f.default = f.options.includes(prevDefault) ? prevDefault : (f.options[0] ?? '');
        } else if (type === 'text' && prevDefault) {
            f.default = prevDefault;
        }
        out.push(f);
    });
    return out;
}

const SECTION_PILLS = [
    { key: 'world', label: 'World fields', icon: 'fa-earth-americas' },
    { key: 'userStats', label: 'User stats', icon: 'fa-heart-pulse' },
    { key: 'characters', label: 'Characters', icon: 'fa-users' },
];

/**
 * @param {object} ctx       SillyTavern context (callGenericPopup, POPUP_TYPE, POPUP_RESULT)
 * @param {object} settings  live settings object (schema + sections + narratorName)
 * @param {(schema, sections, extras)=>void} onSave  extras = { narratorName }
 */
export async function openSettingsModal(ctx, settings, onSave) {
    const s = settings.schema;
    const sec0 = { ...DEFAULT_SECTIONS, ...(settings.sections || {}) };

    const $c = $('<div class="wt-cfg"></div>');

    // --- narrator character ---
    const members = groupMemberNames();
    const curNarr = settings.narratorName || '';
    const narrOpts = [...new Set(members.concat(curNarr && !members.includes(curNarr) ? [curNarr] : []))];
    const $narr = $(`
        <div class="wt-cfg-sec">
            <div class="wt-cfg-sec-head">Narrator character</div>
            <select class="text_pole wt-narr">
                <option value=""${curNarr ? '' : ' selected'}>(any turn)</option>
                ${narrOpts.map((n) => `<option value="${esc(n)}"${n === curNarr ? ' selected' : ''}>${esc(n)}</option>`).join('')}
            </select>
            <small class="notes">Characters set to updater "Narrator" update only on this character's turns. "(any turn)" = update every turn.</small>
        </div>
    `);
    $c.append($narr);

    // --- sections as toggle pills ---
    const $pills = $('<div class="wt-cfg-pills"></div>');
    for (const p of SECTION_PILLS) {
        const on = p.key === 'userStats' ? !!sec0.userStats : sec0[p.key] !== false;
        const $b = $(`<button class="wt-pill${on ? ' wt-pill-on' : ''}" data-key="${p.key}"><i class="fa-solid ${p.icon}"></i> ${p.label}</button>`);
        $b.on('click', () => $b.toggleClass('wt-pill-on'));
        $pills.append($b);
    }
    $c.append($(`<div class="wt-cfg-sec"><div class="wt-cfg-sec-head">Show &amp; track
        <span class="wt-cfg-sec-actions"><button class="menu_button wt-cfg-restore-all"><i class="fa-solid fa-rotate-left"></i> Restore all defaults</button></span>
    </div></div>`).append($pills));

    // --- clock ---
    const $clock = $(`
        <div class="wt-cfg-sec">
            <div class="wt-cfg-sec-head">Clock
                <span class="wt-cfg-sec-actions"><button class="menu_button wt-clk-reset" title="Reset clock to defaults"><i class="fa-solid fa-rotate-left"></i></button></span>
            </div>
            <label>Display format <input type="text" class="text_pole wt-clk-fmt" value="${esc(s.clock?.displayFormat)}"></label>
            <label>Start date/time <input type="datetime-local" class="text_pole wt-clk-start" value="${(s.clock?.startIso || '2024-06-01T09:00:00').slice(0, 16)}"></label>
            <small class="notes">Tokens: yyyy MMMM MMM dd d EEEE EEE HH mm ss a — text in 'quotes' is literal.</small>
        </div>
    `);
    $clock.find('.wt-clk-reset').on('click', () => {
        const dc = defaultSchema().clock;
        $clock.find('.wt-clk-fmt').val(dc.displayFormat);
        $clock.find('.wt-clk-start').val(dc.startIso.slice(0, 16));
    });
    $c.append($clock);

    // --- field lists ---
    const world = listSection('World fields', 'world', s.world || []);
    const stats = listSection('User stats', 'stat', s.userStats || []);
    const chars = listSection('Character fields (template for each tracked NPC)', 'char', s.character?.fields || []);
    $c.append(world.$sec, stats.$sec, chars.$sec);

    $c.find('.wt-cfg-restore-all').on('click', async () => {
        const ok = await ctx.callGenericPopup('Reset all WorldTracker fields and sections to defaults?', ctx.POPUP_TYPE.CONFIRM);
        if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        const ds = defaultSchema();
        $pills.find('.wt-pill').each(function () {
            const k = $(this).data('key');
            $(this).toggleClass('wt-pill-on', k === 'userStats' ? !!DEFAULT_SECTIONS.userStats : DEFAULT_SECTIONS[k] !== false);
        });
        $clock.find('.wt-clk-fmt').val(ds.clock.displayFormat);
        $clock.find('.wt-clk-start').val(ds.clock.startIso.slice(0, 16));
        const refill = ($list, arr, kind) => { $list.empty(); for (const f of arr) $list.append(fieldRow(kind, f)); };
        refill(world.$list, ds.world, 'world');
        refill(stats.$list, ds.userStats, 'stat');
        refill(chars.$list, ds.character?.fields || [], 'char');
    });

    const result = await ctx.callGenericPopup($c[0], ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save', cancelButton: 'Cancel', wide: true, large: true, allowVerticalScrolling: true,
    });
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

    const newSchema = {
        ...s,
        clock: {
            ...s.clock,
            displayFormat: String($clock.find('.wt-clk-fmt').val() || s.clock?.displayFormat || 'HH:mm — EEE, MMM d yyyy'),
            startIso: `${String($clock.find('.wt-clk-start').val() || '2024-06-01T09:00').slice(0, 16)}:00`,
        },
        world: readRows(world.$list, 'world'),
        userStats: readRows(stats.$list, 'stat'),
        character: { ...(s.character || {}), fields: readRows(chars.$list, 'char') },
    };
    const pillOn = (k) => $pills.find(`.wt-pill[data-key="${k}"]`).hasClass('wt-pill-on');
    const newSections = { world: pillOn('world'), userStats: pillOn('userStats'), characters: pillOn('characters') };
    onSave(newSchema, newSections, { narratorName: String($narr.find('.wt-narr').val() || '') });
}
