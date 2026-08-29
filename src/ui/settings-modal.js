// WorldTracker — the panel's gear-button settings dialog.
//
// Edits the field SCHEMA (world fields, user stats, character template fields,
// clock format) and the section toggles. On Save it hands back the rebuilt
// schema + sections; the caller persists and re-seeds the current chat.

import { defaultSchema, normGroup } from '../schema.js';
import { groupMemberNames } from './panel.js';
import { makeSortable } from './drag.js';
import * as profiles from '../profiles.js';

const TYPES = ['text', 'number', 'enum'];
const DEFAULT_SECTIONS = { world: true, userStats: false, characters: true };

function esc(v) { return $('<i>').text(v == null ? '' : String(v)).html(); }

let ctxRef = null; // SillyTavern context, set by openSettingsModal (needed for the nested enum popup)

function enumSummary(options, def) {
    if (!options.length) return '(no options)';
    const s = options.map((o) => (o === def ? `${o} ★` : o)).join(', ');
    return s.length > 44 ? `${s.slice(0, 42)}…` : s;
}

/** Reflect a row's enum state (stored via jQuery .data) onto its button label. */
function refreshEnumBtn($r) {
    $r.find('.wt-enum-summary').text(enumSummary($r.data('enumOptions') || [], $r.data('enumDefault') || ''));
}

/** "Collapsible #" picker: – or a digit 0-9 (fields sharing a digit fold together). */
function groupSelectHtml(f) {
    const g = normGroup(f.group);
    let opts = '<option value="">–</option>';
    for (let i = 0; i <= 9; i++) opts += `<option value="${i}"${g === i ? ' selected' : ''}>${i}</option>`;
    return `<select class="text_pole wt-cfg-group" title="Collapsible #: fields sharing a digit fold into one collapsible group (– = its own row)">${opts}</select>`;
}

function fieldRow(kind, f = {}) {
    const isStat = kind === 'stat';
    const type = f.type || (isStat ? 'number' : 'text');
    const $r = $(`
        <div class="wt-cfg-row" data-kind="${kind}" data-default="${esc(type === 'text' ? (f.default ?? '') : '')}">
            <span class="wt-cfg-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <input type="text" class="text_pole wt-cfg-key" placeholder="name" value="${esc(f.key)}">
            ${isStat ? '' : `<select class="text_pole wt-cfg-type">${TYPES.map((t) => `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`).join('')}</select>`}
            ${isStat
        ? `<input type="number" class="text_pole wt-cfg-max" placeholder="max" value="${f.max ?? ''}" title="max value (blank = unbounded)">`
        : `<input type="text" class="text_pole wt-cfg-extra" placeholder="${type === 'number' ? 'unit' : ''}"${type === 'enum' ? ' style="display:none"' : ''} value="${esc(type === 'number' ? (f.unit || '') : '')}">
           <button class="menu_button wt-enum-edit"${type === 'enum' ? '' : ' style="display:none"'} title="Edit options"><i class="fa-solid fa-pen-to-square"></i> <span class="wt-enum-summary"></span></button>`}
            ${groupSelectHtml(f)}
            <button class="menu_button wt-cfg-del" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `);
    if (!isStat) {
        $r.data('enumOptions', Array.isArray(f.options) ? [...f.options] : []);
        $r.data('enumDefault', type === 'enum' ? (f.default || (f.options || [])[0] || '') : '');
        refreshEnumBtn($r);

        const $type = $r.find('.wt-cfg-type');
        const $extra = $r.find('.wt-cfg-extra');
        const $enumBtn = $r.find('.wt-enum-edit');
        $type.on('change', () => {
            const t = $type.val();
            $extra.toggle(t !== 'enum').attr('placeholder', t === 'number' ? 'unit' : '');
            $enumBtn.toggle(t === 'enum');
        });
        $enumBtn.on('click', async () => {
            const res = await openEnumEditor($r.data('enumOptions') || [], $r.data('enumDefault') || '');
            if (!res) return;
            $r.data('enumOptions', res.options);
            $r.data('enumDefault', res.default);
            refreshEnumBtn($r);
        });
    }
    $r.find('.wt-cfg-del').on('click', () => $r.remove());
    return $r;
}

/** Nested popup: reorder / rename / delete enum options, star one as default. */
async function openEnumEditor(options, defaultVal) {
    const $c = $('<div class="wt-enum-ed"></div>');
    const $list = $('<div class="wt-enum-list"></div>');
    let curDefault = defaultVal;

    const optRow = (text) => {
        const $o = $(`
            <div class="wt-enum-opt">
                <span class="wt-enum-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                <input type="text" class="text_pole wt-enum-text" value="${esc(text)}">
                <button class="menu_button wt-enum-star" title="Set as default"><i class="fa-solid fa-star"></i></button>
                <button class="menu_button wt-enum-del" title="Delete"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `);
        $o.find('.wt-enum-star').on('click', () => {
            curDefault = String($o.find('.wt-enum-text').val() || '');
            markDefault();
        });
        $o.find('.wt-enum-del').on('click', () => { $o.remove(); markDefault(); });
        return $o;
    };
    const markDefault = () => {
        $list.find('.wt-enum-opt').each(function () {
            const isDef = String($(this).find('.wt-enum-text').val() || '') === curDefault && curDefault !== '';
            $(this).toggleClass('wt-is-default', isDef);
            $(this).find('.wt-enum-star i').attr('class', isDef ? 'fa-solid fa-star' : 'fa-regular fa-star');
        });
    };
    for (const o of options) $list.append(optRow(o));
    makeSortable($list[0], { itemSelector: '.wt-enum-opt', handleSelector: '.wt-enum-grip', onDrop() {} });
    markDefault();

    const $add = $('<button class="menu_button"><i class="fa-solid fa-plus"></i> Add option</button>');
    $add.on('click', () => { $list.append(optRow('')); });

    const $import = $(`
        <div class="wt-enum-import">
            <input type="text" class="text_pole wt-enum-csv" placeholder="paste a comma list, then Import">
            <button class="menu_button wt-enum-csv-go">Import</button>
        </div>
    `);
    $import.find('.wt-enum-csv-go').on('click', () => {
        const parts = String($import.find('.wt-enum-csv').val() || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!parts.length) return;
        $list.empty();
        for (const p of parts) $list.append(optRow(p));
        if (!parts.includes(curDefault)) curDefault = '';
        markDefault();
        $import.find('.wt-enum-csv').val('');
    });

    $c.append($list, $add, $import);

    const r = await ctxRef.callGenericPopup($c[0], ctxRef.POPUP_TYPE.CONFIRM, '', { okButton: 'Done', cancelButton: 'Cancel' });
    if (r !== ctxRef.POPUP_RESULT.AFFIRMATIVE) return null;

    const outOpts = [];
    $list.find('.wt-enum-opt .wt-enum-text').each(function () {
        const v = String($(this).val() || '').trim();
        if (v && !outOpts.includes(v)) outOpts.push(v);
    });
    const def = outOpts.includes(curDefault) ? curDefault : (outOpts[0] || '');
    return { options: outOpts, default: def };
}

function listSection(title, kind, list, collapsed) {
    const $sec = $(`
        <div class="wt-cfg-sec${collapsed ? ' wt-collapsed' : ''}">
            <div class="wt-cfg-sec-head">
                <span class="wt-cfg-head-label"><i class="wt-cfg-chevron fa-solid fa-chevron-down"></i> ${title}</span>
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
    makeSortable($list[0], { itemSelector: '.wt-cfg-row', handleSelector: '.wt-cfg-grip', onDrop() {} });
    $sec.find('.wt-cfg-add').on('click', () => $list.append(fieldRow(kind, {})));
    $sec.find('.wt-cfg-reset').on('click', () => {
        const ds = defaultSchema();
        fill(kind === 'world' ? ds.world
            : kind === 'stat' ? ds.userStats
            : kind === 'player' ? (ds.player?.fields || [])
            : (ds.character?.fields || []));
    });
    return { $sec, $list };
}

function readRows($list, kind) {
    const out = [];
    $list.children('.wt-cfg-row').each(function () {
        const $r = $(this);
        const key = String($r.find('.wt-cfg-key').val() || '').trim();
        if (!key) return;
        const grp = normGroup($r.find('.wt-cfg-group').val());
        if (kind === 'stat') {
            const max = $r.find('.wt-cfg-max').val();
            out.push({ key, label: key, type: 'number', max: max === '' ? undefined : Number(max), default: 0, lockedByDefault: false, group: grp ?? undefined });
            return;
        }
        const type = $r.find('.wt-cfg-type').val() || 'text';
        const extra = String($r.find('.wt-cfg-extra').val() || '').trim();
        const f = { key, label: key, type, lockedByDefault: false, default: type === 'number' ? 0 : '' };
        if (grp != null) f.group = grp;
        if (type === 'number' && extra) f.unit = extra;
        if (type === 'enum') {
            f.options = ($r.data('enumOptions') || []).slice();
            const d = $r.data('enumDefault') || '';
            f.default = f.options.includes(d) ? d : (f.options[0] ?? '');
        } else if (type === 'text') {
            const prevDefault = $r.attr('data-default') || '';
            if (prevDefault) f.default = prevDefault;
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

/** Build the editable body from a { schema, sections, narratorName } snapshot. */
function buildBody(data) {
    const s = data.schema;
    const sec0 = { ...DEFAULT_SECTIONS, ...(data.sections || {}) };
    const $c = $('<div class="wt-cfg-body"></div>');

    // narrator
    const members = groupMemberNames();
    const curNarr = data.narratorName || '';
    const narrOpts = [...new Set(members.concat(curNarr && !members.includes(curNarr) ? [curNarr] : []))];
    const head = (title, actions = '') =>
        `<div class="wt-cfg-sec-head"><span class="wt-cfg-head-label"><i class="wt-cfg-chevron fa-solid fa-chevron-down"></i> ${title}</span>${actions ? `<span class="wt-cfg-sec-actions">${actions}</span>` : ''}</div>`;

    const $narr = $(`
        <div class="wt-cfg-sec">
            ${head('Narrator character')}
            <select class="text_pole wt-narr">
                <option value=""${curNarr ? '' : ' selected'}>(any turn)</option>
                ${narrOpts.map((n) => `<option value="${esc(n)}"${n === curNarr ? ' selected' : ''}>${esc(n)}</option>`).join('')}
            </select>
            <small class="notes">Characters set to updater "Narrator" update only on this character's turns. "(any turn)" = every turn.</small>
        </div>
    `);
    $c.append($narr);

    // section pills
    const $pills = $('<div class="wt-cfg-pills"></div>');
    for (const p of SECTION_PILLS) {
        const on = p.key === 'userStats' ? !!sec0.userStats : sec0[p.key] !== false;
        const $b = $(`<button class="wt-pill${on ? ' wt-pill-on' : ''}" data-key="${p.key}"><i class="fa-solid ${p.icon}"></i> ${p.label}</button>`);
        $b.on('click', () => {
            $b.toggleClass('wt-pill-on');
            const off = !$b.hasClass('wt-pill-on');
            const secs = { world: [world.$sec], userStats: [stats.$sec], characters: [chars.$sec, player.$sec] }[p.key] || [];
            for (const $sec of secs) if ($sec) $sec.toggleClass('wt-collapsed', off);
        });
        $pills.append($b);
    }
    $c.append($(`<div class="wt-cfg-sec">${head('Show &amp; track', '<button class="menu_button wt-cfg-restore-all"><i class="fa-solid fa-rotate-left"></i> Restore all defaults</button>')}</div>`).append($pills));

    // clock
    const $clock = $(`
        <div class="wt-cfg-sec">
            ${head('Clock', '<button class="menu_button wt-clk-reset" title="Reset clock to defaults"><i class="fa-solid fa-rotate-left"></i></button>')}
            <label>Display format <input type="text" class="text_pole wt-clk-fmt" value="${esc(s.clock?.displayFormat)}"></label>
            <label>Start date/time <input type="datetime-local" class="text_pole wt-clk-start" value="${(s.clock?.startIso || '2024-06-01T09:00:00').slice(0, 16)}"></label>
        </div>
    `);
    $clock.find('.wt-clk-reset').on('click', () => {
        const dc = defaultSchema().clock;
        $clock.find('.wt-clk-fmt').val(dc.displayFormat);
        $clock.find('.wt-clk-start').val(dc.startIso.slice(0, 16));
    });
    $c.append($clock);

    // field lists — start collapsed if the matching section pill is off
    const world = listSection('World fields', 'world', s.world || [], sec0.world === false);
    const stats = listSection('User stats', 'stat', s.userStats || [], !sec0.userStats);
    const chars = listSection('Character fields (template for each tracked NPC)', 'char', s.character?.fields || [], sec0.characters === false);
    const player = listSection('Your character (appearance & conditions the model should remember)', 'player', s.player?.fields || [], sec0.characters === false);
    $c.append(world.$sec, stats.$sec, chars.$sec, player.$sec);

    // any section head toggles its own collapse (buttons excepted)
    $c.on('click', '.wt-cfg-sec-head', function (e) {
        if ($(e.target).closest('button, select, input, a').length) return;
        $(this).closest('.wt-cfg-sec').toggleClass('wt-collapsed');
    });

    const pillOn = (k) => $pills.find(`.wt-pill[data-key="${k}"]`).hasClass('wt-pill-on');

    const read = () => ({
        schema: {
            ...s,
            clock: {
                ...s.clock,
                displayFormat: String($clock.find('.wt-clk-fmt').val() || s.clock?.displayFormat || 'HH:mm — EEE, MMM d yyyy'),
                startIso: `${String($clock.find('.wt-clk-start').val() || '2024-06-01T09:00').slice(0, 16)}:00`,
            },
            world: readRows(world.$list, 'world'),
            userStats: readRows(stats.$list, 'stat'),
            character: { ...(s.character || {}), fields: readRows(chars.$list, 'char') },
            player: { ...(s.player || {}), fields: readRows(player.$list, 'player') },
        },
        sections: { world: pillOn('world'), userStats: pillOn('userStats'), characters: pillOn('characters') },
        narratorName: String($narr.find('.wt-narr').val() || ''),
    });

    return { $c, read, onRestoreAll: (cb) => $c.find('.wt-cfg-restore-all').on('click', cb) };
}

async function promptName(ctx, title, def = '') {
    try {
        const v = await ctx.Popup.show.input(title, '', def);
        return (v ?? '').trim();
    } catch {
        return (window.prompt(title, def) ?? '').trim();
    }
}

/**
 * @param {object} ctx       SillyTavern context
 * @param {object} settings  live settings (schema/sections/narratorName + profiles)
 * @param {() => void} persist  re-apply settings.schema to the current chat + refresh UI
 */
export async function openSettingsModal(ctx, settings, persist) {
    ctxRef = ctx;
    profiles.ensureProfiles(settings);
    const saveGlobal = () => { ctx.saveSettingsDebounced(); persist(); };

    let working = profiles.snapshot(settings);
    let body = buildBody(working);

    const $wrap = $('<div class="wt-cfg"></div>');
    const $bar = $(`
        <div class="wt-cfg-sec wt-profile-bar">
            <div class="wt-cfg-sec-head"><span class="wt-cfg-head-label"><i class="wt-cfg-chevron fa-solid fa-chevron-down"></i> Profile</span></div>
            <div class="wt-profile-row">
                <select class="text_pole wt-prof-select"></select>
                <button class="menu_button wt-prof-bind" title="Lock this profile to the current chat / group"><i class="fa-solid fa-lock-open"></i></button>
                <button class="menu_button wt-prof-default" title="Use as the default profile for new chats"><i class="fa-regular fa-star"></i></button>
                <button class="menu_button wt-prof-new" title="New profile from defaults"><i class="fa-solid fa-file-circle-plus"></i></button>
                <button class="menu_button wt-prof-save" title="Save into this profile"><i class="fa-solid fa-floppy-disk"></i></button>
                <button class="menu_button wt-prof-saveas" title="Save as a new profile"><i class="fa-solid fa-copy"></i></button>
                <button class="menu_button wt-prof-rename" title="Rename"><i class="fa-solid fa-i-cursor"></i></button>
                <button class="menu_button wt-prof-del" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `);
    const $bodyHost = $('<div class="wt-cfg-body-host"></div>').append(body.$c);
    $wrap.append($bar, $bodyHost);

    $bar.find('.wt-cfg-sec-head').on('click', (e) => {
        if ($(e.target).closest('button, select, input').length) return;
        $bar.toggleClass('wt-collapsed');
    });

    const rebuild = (data) => {
        working = data;
        body = buildBody(working);
        $bodyHost.empty().append(body.$c);
        wireRestoreAll();
    };
    function wireRestoreAll() {
        body.onRestoreAll(async () => {
            const ok = await ctx.callGenericPopup('Reset fields and sections to defaults? (does not touch other profiles)', ctx.POPUP_TYPE.CONFIRM);
            if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
            rebuild({ schema: defaultSchema(), sections: { ...DEFAULT_SECTIONS }, narratorName: working.narratorName });
        });
    }
    wireRestoreAll();

    function refreshBar() {
        profiles.ensureProfiles(settings);
        const p = settings.profiles;
        const $sel = $bar.find('.wt-prof-select').empty();
        for (const { id, name } of profiles.list(settings)) {
            $sel.append(`<option value="${esc(id)}"${id === p.activeId ? ' selected' : ''}>${esc(name)}${id === p.defaultId ? ' ★' : ''}</option>`);
        }
        const key = profiles.chatKey(ctx);
        const bound = !!key && profiles.bindingFor(settings, key) === p.activeId;
        const $bind = $bar.find('.wt-prof-bind');
        $bind.toggleClass('wt-on', bound).prop('disabled', !key)
            .attr('title', !key ? 'No chat/group to lock to' : bound ? 'Locked to this chat/group — click to unlock' : 'Lock this profile to the current chat/group');
        $bind.find('i').attr('class', `fa-solid ${bound ? 'fa-lock' : 'fa-lock-open'}`);
        const isDef = p.defaultId === p.activeId;
        const $def = $bar.find('.wt-prof-default').toggleClass('wt-on', isDef)
            .attr('title', isDef ? 'This is the default profile — click to clear' : 'Use as the default profile for new chats');
        $def.find('i').attr('class', `${isDef ? 'fa-solid' : 'fa-regular'} fa-star`);
    }
    refreshBar();

    // profile bar handlers
    $bar.find('.wt-prof-select').on('change', function () {
        profiles.setActive(settings, this.value);
        const a = profiles.active(settings);
        if (a) { profiles.applyData(settings, a.data); rebuild(profiles.snapshot(settings)); }
        refreshBar();
        saveGlobal();
    });
    $bar.find('.wt-prof-new').on('click', async () => {
        const name = await promptName(ctx, 'Name the new profile', 'New profile');
        if (!name) return;
        profiles.create(settings, name, { schema: defaultSchema(), sections: { ...DEFAULT_SECTIONS }, narratorName: '' });
        profiles.applyData(settings, profiles.active(settings).data);
        rebuild(profiles.snapshot(settings));
        refreshBar();
        saveGlobal();
    });
    $bar.find('.wt-prof-save').on('click', () => {
        const d = body.read();
        profiles.save(settings, d);
        profiles.applyData(settings, d);
        rebuild(profiles.snapshot(settings));
        refreshBar();
        saveGlobal();
        toastr.success(`WorldTracker: saved "${profiles.active(settings)?.name}".`);
    });
    $bar.find('.wt-prof-saveas').on('click', async () => {
        const name = await promptName(ctx, 'Save as new profile', `${profiles.active(settings)?.name || 'Profile'} copy`);
        if (!name) return;
        profiles.create(settings, name, body.read());
        profiles.applyData(settings, profiles.active(settings).data);
        rebuild(profiles.snapshot(settings));
        refreshBar();
        saveGlobal();
    });
    $bar.find('.wt-prof-rename').on('click', async () => {
        const p = settings.profiles;
        const name = await promptName(ctx, 'Rename profile', p.list[p.activeId]?.name || '');
        if (!name) return;
        profiles.rename(settings, p.activeId, name);
        refreshBar();
        ctx.saveSettingsDebounced();
    });
    $bar.find('.wt-prof-del').on('click', async () => {
        const p = settings.profiles;
        if (Object.keys(p.list).length <= 1) { toastr.info('WorldTracker: keep at least one profile.'); return; }
        const ok = await ctx.callGenericPopup(`Delete profile "${p.list[p.activeId]?.name}"?`, ctx.POPUP_TYPE.CONFIRM);
        if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        profiles.remove(settings, p.activeId);
        profiles.applyData(settings, profiles.active(settings).data);
        rebuild(profiles.snapshot(settings));
        refreshBar();
        saveGlobal();
    });
    $bar.find('.wt-prof-bind').on('click', function () {
        if (this.disabled) return;
        const key = profiles.chatKey(ctx);
        const nowBound = $(this).hasClass('wt-on');
        profiles.bind(settings, key, nowBound ? '' : settings.profiles.activeId);
        refreshBar();
        ctx.saveSettingsDebounced();
    });
    $bar.find('.wt-prof-default').on('click', function () {
        const isDef = $(this).hasClass('wt-on');
        profiles.setDefault(settings, isDef ? '' : settings.profiles.activeId);
        refreshBar();
        ctx.saveSettingsDebounced();
    });

    const result = await ctx.callGenericPopup($wrap[0], ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save & close', cancelButton: 'Close', wide: true, large: true, allowVerticalScrolling: true,
    });
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

    const d = body.read();
    profiles.save(settings, d);
    profiles.applyData(settings, d);
    saveGlobal();
}
