// WorldTracker — one editable field row for the detail sheet.
//
// Renders: [icon] label ......... [value / inline editor] [lock toggle]
// Emits via handlers: onEdit(path, newValue), onToggleLock(path, locked)
//
// For the clock, onEdit's second arg is an object with any of:
//   { __setIso: 'YYYY-MM-DDTHH:mm' }   set the clock absolutely
//   { __elapsed: {days,hours,minutes} } advance the clock
//   { __expected: {days,hours,minutes} } save the "expected next reply" interval

import { displayValue, esc, iconFor } from './format.js';
import { toIso } from '../clock.js';

// ST-native classes so inputs/buttons pick up the active theme.
const INP = 'text_pole wt-inp';
const BTN = 'menu_button wt-btn-sm';

export function fieldRow(path, field, state, opts = {}) {
    const { showLock = true, label, onEdit, onToggleLock, extraControlHtml = '' } = opts;
    const isClock = path === 'clock';
    const locked = !!(field && field.locked);
    const $row = $(`
        <div class="wt-field-row${locked ? ' wt-locked' : ''}" data-path="${esc(path)}">
            <span class="wt-field-ico"><i class="fa-solid ${iconFor(label || path.split('.').pop())}"></i></span>
            <span class="wt-field-label">${esc(label || path.split('.').pop())}</span>
            <span class="wt-field-value" tabindex="0" role="button" title="Click to edit">${esc(displayValue(path, field, state))}</span>
            ${extraControlHtml}
            ${showLock ? `<button class="wt-lock-btn" title="${locked ? 'Locked — click to unlock' : 'Unlocked — click to lock'}"><i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>` : ''}
        </div>
    `);

    const $value = $row.find('.wt-field-value');

    function beginEdit() {
        if ($row.find('.wt-field-editor').length) return;
        let $editor;

        if (isClock) {
            const cur16 = toIso(state.clock.iso).slice(0, 16); // YYYY-MM-DDTHH:mm
            const exp = state.clock.expectedInterval || { days: 0, hours: 0, minutes: 0, seconds: 0 };
            const presets = Array.isArray(state.clock.intervalPresets) ? state.clock.intervalPresets : [];
            const dhms = (cls, src) => `
                <input type="number" class="${INP} ${cls}-d" min="0" placeholder="d" value="${src && src.days || ''}">
                <input type="number" class="${INP} ${cls}-h" min="0" placeholder="h" value="${src && src.hours || ''}">
                <input type="number" class="${INP} ${cls}-m" min="0" placeholder="m" value="${src && src.minutes || ''}">
                <input type="number" class="${INP} ${cls}-s" min="0" placeholder="s" value="${src && src.seconds || ''}">`;
            $editor = $(`
                <div class="wt-field-editor wt-clock-editor">
                    <div class="wt-clock-line">
                        <label>Set</label>
                        <input type="datetime-local" class="${INP} wt-clock-abs" value="${esc(cur16)}" step="60">
                    </div>
                    <div class="wt-clock-line">
                        <label>Advance</label>
                        ${dhms('wt-adv', null)}
                    </div>
                    <div class="wt-clock-line">
                        <label title="Fallback time to add if you reject the model's reported elapsed">Expected next</label>
                        ${dhms('wt-exp', exp)}
                    </div>
                    ${presets.length ? `<div class="wt-clock-line wt-clock-presets">${presets.map((p, i) =>
                        `<button class="${BTN} wt-preset" data-i="${i}">${esc(p.name)}</button>`).join('')}</div>` : ''}
                    <div class="wt-clock-line wt-clock-actions">
                        <button class="${BTN} wt-edit-ok"><i class="fa-solid fa-check"></i> Apply</button>
                        <button class="${BTN} wt-edit-cancel"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
            `);
            $value.hide().after($editor);
            $editor.find('.wt-clock-abs').trigger('focus');

            $editor.find('.wt-preset').on('click', function () {
                const p = presets[Number($(this).data('i'))] || {};
                $editor.find('.wt-exp-d').val(p.days || '');
                $editor.find('.wt-exp-h').val(p.hours || '');
                $editor.find('.wt-exp-m').val(p.minutes || '');
                $editor.find('.wt-exp-s').val(p.seconds || '');
            });

            $editor.find('.wt-edit-ok').on('click', () => {
                const grab = (cls) => ({
                    days: Number($editor.find(`.${cls}-d`).val()) || 0,
                    hours: Number($editor.find(`.${cls}-h`).val()) || 0,
                    minutes: Number($editor.find(`.${cls}-m`).val()) || 0,
                    seconds: Number($editor.find(`.${cls}-s`).val()) || 0,
                });
                onEdit && onEdit(path, { __expected: grab('wt-exp') });

                const advance = grab('wt-adv');
                const abs = String($editor.find('.wt-clock-abs').val() || '');
                if (advance.days || advance.hours || advance.minutes || advance.seconds) {
                    onEdit && onEdit(path, { __elapsed: advance });
                } else if (abs && abs.slice(0, 16) !== toIso(state.clock.iso).slice(0, 16)) {
                    onEdit && onEdit(path, { __setIso: abs });
                }
                endEdit();
            });
        } else if (field && field.type === 'enum' && Array.isArray(field.options)) {
            $editor = $(`<span class="wt-field-editor">
                <select class="${INP} wt-edit-input">${field.options.map((o) => `<option${o === field.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
                <button class="${BTN} wt-edit-ok"><i class="fa-solid fa-check"></i></button>
                <button class="${BTN} wt-edit-cancel"><i class="fa-solid fa-xmark"></i></button>
            </span>`);
            $value.hide().after($editor);
            $editor.find('.wt-edit-input').trigger('focus');
            $editor.find('.wt-edit-ok').on('click', () => { onEdit && onEdit(path, $editor.find('.wt-edit-input').val()); endEdit(); });
        } else {
            const inputType = field && field.type === 'number' ? 'number' : 'text';
            $editor = $(`<span class="wt-field-editor">
                <input type="${inputType}" class="${INP} wt-edit-input" value="${esc(field ? field.value : '')}">
                <button class="${BTN} wt-edit-ok"><i class="fa-solid fa-check"></i></button>
                <button class="${BTN} wt-edit-cancel"><i class="fa-solid fa-xmark"></i></button>
            </span>`);
            $value.hide().after($editor);
            const $inp = $editor.find('.wt-edit-input');
            $inp.trigger('focus').trigger('select');
            const commit = () => {
                let v = $inp.val();
                if (inputType === 'number') v = Number(v);
                onEdit && onEdit(path, v);
                endEdit();
            };
            $editor.find('.wt-edit-ok').on('click', commit);
            $inp.on('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') endEdit(); });
        }
        $editor.find('.wt-edit-cancel').on('click', endEdit);
    }

    function endEdit() {
        $row.find('.wt-field-editor').remove();
        $value.show();
    }

    $value.on('click', beginEdit);
    $value.on('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginEdit(); } });

    if (showLock) {
        $row.find('.wt-lock-btn').on('click', () => {
            onToggleLock && onToggleLock(path, !locked);
        });
    }

    return $row;
}
