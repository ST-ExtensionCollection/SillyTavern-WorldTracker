// WorldTracker — the panel's gear-button settings dialog.
//
// Edits the field SCHEMA (world fields, user stats, character template fields,
// clock format) and the section toggles. On Save it hands back the rebuilt
// schema + sections; the caller persists and re-seeds the current chat.

const TYPES = ['text', 'number', 'enum'];

function row(html) { return $(html); }

function fieldRow(kind, f = {}) {
    const isChar = kind === 'char';
    const isStat = kind === 'stat';
    const type = f.type || (isStat ? 'number' : 'text');
    const $r = row(`
        <div class="wt-cfg-row" data-kind="${kind}">
            <input type="text" class="text_pole wt-cfg-key" placeholder="name" value="${$('<i>').text(f.key || '').html()}">
            ${isStat ? '' : `<select class="text_pole wt-cfg-type">${TYPES.map((t) => `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`).join('')}</select>`}
            ${isStat
        ? `<input type="number" class="text_pole wt-cfg-max" placeholder="max" value="${f.max ?? ''}" title="max value (blank = unbounded)">`
        : `<input type="text" class="text_pole wt-cfg-extra" placeholder="${type === 'number' ? 'unit' : type === 'enum' ? 'a, b, c' : ''}" value="${$('<i>').text(type === 'enum' ? (f.options || []).join(', ') : (f.unit || '')).html()}">`}
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

function section(title, kind, list, $host) {
    const $sec = row(`<div class="wt-cfg-sec"><div class="wt-cfg-sec-head">${title}</div><div class="wt-cfg-list"></div><button class="menu_button wt-cfg-add"><i class="fa-solid fa-plus"></i> Add</button></div>`);
    const $list = $sec.find('.wt-cfg-list');
    for (const f of list) $list.append(fieldRow(kind, f));
    $sec.find('.wt-cfg-add').on('click', () => $list.append(fieldRow(kind, {})));
    $host.append($sec);
    return $list;
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
        const f = { key, label: key, type, lockedByDefault: false, default: type === 'number' ? 0 : '' };
        if (type === 'number' && extra) f.unit = extra;
        if (type === 'enum') {
            f.options = extra.split(',').map((s) => s.trim()).filter(Boolean);
            f.default = f.options[0] ?? '';
        }
        out.push(f);
    });
    return out;
}

/**
 * @param {object} ctx       SillyTavern context (needs callGenericPopup, POPUP_TYPE, POPUP_RESULT)
 * @param {object} settings  live settings object (schema + sections)
 * @param {(schema, sections)=>void} onSave
 */
export async function openSettingsModal(ctx, settings, onSave) {
    const s = settings.schema;
    const sec = settings.sections || {};

    const $c = $('<div class="wt-cfg"></div>');

    const $toggles = row(`
        <div class="wt-cfg-sec">
            <div class="wt-cfg-sec-head">Sections</div>
            <label class="checkbox_label"><input type="checkbox" class="wt-sec-world" ${sec.world !== false ? 'checked' : ''}><span>World fields</span></label>
            <label class="checkbox_label"><input type="checkbox" class="wt-sec-stats" ${sec.userStats ? 'checked' : ''}><span>User stats</span></label>
            <label class="checkbox_label"><input type="checkbox" class="wt-sec-chars" ${sec.characters !== false ? 'checked' : ''}><span>Characters</span></label>
        </div>
    `);
    $c.append($toggles);

    const $clock = row(`
        <div class="wt-cfg-sec">
            <div class="wt-cfg-sec-head">Clock</div>
            <label>Display format <input type="text" class="text_pole wt-clk-fmt" value="${$('<i>').text(s.clock?.displayFormat || '').html()}"></label>
            <label>Start date/time <input type="datetime-local" class="text_pole wt-clk-start" value="${(s.clock?.startIso || '2024-06-01T09:00:00').slice(0, 16)}"></label>
            <small class="notes">Tokens: yyyy MMMM MMM dd d EEEE EEE HH mm ss a — text in 'quotes' is literal.</small>
        </div>
    `);
    $c.append($clock);

    const $world = section('World fields', 'world', s.world || [], $c);
    const $stats = section('User stats', 'stat', s.userStats || [], $c);
    const $chars = section('Character fields (template for each tracked NPC)', 'char', s.character?.fields || [], $c);

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
        world: readRows($world, 'world'),
        userStats: readRows($stats, 'stat'),
        character: { ...(s.character || {}), fields: readRows($chars, 'char') },
    };
    const newSections = {
        world: $toggles.find('.wt-sec-world').is(':checked'),
        userStats: $toggles.find('.wt-sec-stats').is(':checked'),
        characters: $toggles.find('.wt-sec-chars').is(':checked'),
    };
    onSave(newSchema, newSections);
}
