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
            const exp = state.clock.expectedInterval || { days: 0, hours: 0, minutes: 0 };
            $editor = $(`
                <div class="wt-field-editor wt-clock-editor">
                    <div class="wt-clock-line">
                        <label>Set</label>
                        <input type="datetime-local" class="${INP} wt-clock-abs" value="${esc(cur16)}" step="60">
                    </div>
                    <div class="wt-clock-line">
                        <label>Advance</label>
                        <input type="number" class="${INP} wt-clock-d" min="0" placeholder="d">
                        <input type="number" class="${INP} wt-clock-h" min="0" placeholder="h">
                        <input type="number" class="${INP} wt-clock-m" min="0" placeholder="m">
                    </div>
                    <div class="wt-clock-line">
                        <label title="Fallback time to add if you reject the model's reported elapsed">Expected next</label>
                        <input type="number" class="${INP} wt-exp-d" min="0" placeholder="d" value="${exp.days || ''}">
                        <input type="number" class="${INP} wt-exp-h" min="0" placeholder="h" value="${exp.hours || ''}">
                        <input type="number" class="${INP} wt-exp-m" min="0" placeholder="m" value="${exp.minutes || ''}">
                    </div>
                    <div class="wt-clock-line wt-clock-actions">
                        <button class="${BTN} wt-edit-ok"><i class="fa-solid fa-check"></i> Apply</button>
                        <button class="${BTN} wt-edit-cancel"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
            `);
            $value.hide().after($editor);
            $editor.find('.wt-clock-abs').trigger('focus');
            $editor.find('.wt-edit-ok').on('click', () => {
                const num = (sel) => Number($editor.find(sel).val()) || 0;
                const expected = { days: num('.wt-exp-d'), hours: num('.wt-exp-h'), minutes: num('.wt-exp-m') };
                onEdit && onEdit(path, { __expected: expected });

                const advance = { days: num('.wt-clock-d'), hours: num('.wt-clock-h'), minutes: num('.wt-clock-m') };
                const abs = String($editor.find('.wt-clock-abs').val() || '');
                if (advance.days || advance.hours || advance.minutes) {
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
