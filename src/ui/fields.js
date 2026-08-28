// WorldTracker — one editable field row for the detail sheet.
//
// Renders: [icon] label ......... [value / inline editor] [lock toggle]
// Emits via handlers: onEdit(path, newValue), onToggleLock(path, locked)

import { displayValue, esc, iconFor } from './format.js';

/**
 * @param {string} path        canonical field path
 * @param {object} field       the field object from state ({value,type,locked,...})
 * @param {object} state       full state (needed for clock formatting)
 * @param {object} opts        { showLock, label, onEdit, onToggleLock, extraControlHtml }
 * @returns {JQuery}
 */
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
            // Clock is edited by nudging elapsed time, not typed absolute.
            $editor = $(`
                <span class="wt-field-editor wt-clock-editor">
                    <input type="number" class="wt-clock-d" min="0" placeholder="d" style="width:3em">
                    <input type="number" class="wt-clock-h" min="0" placeholder="h" style="width:3em">
                    <input type="number" class="wt-clock-m" min="0" placeholder="m" style="width:3em">
                    <button class="wt-edit-ok" title="Add time"><i class="fa-solid fa-check"></i></button>
                    <button class="wt-edit-cancel" title="Cancel"><i class="fa-solid fa-xmark"></i></button>
                </span>
            `);
            $value.hide().after($editor);
            $editor.find('.wt-clock-d').trigger('focus');
            $editor.find('.wt-edit-ok').on('click', () => {
                const delta = {
                    days: Number($editor.find('.wt-clock-d').val()) || 0,
                    hours: Number($editor.find('.wt-clock-h').val()) || 0,
                    minutes: Number($editor.find('.wt-clock-m').val()) || 0,
                };
                onEdit && onEdit(path, { __elapsed: delta });
                endEdit();
            });
        } else if (field && field.type === 'enum' && Array.isArray(field.options)) {
            $editor = $(`<span class="wt-field-editor">
                <select class="wt-edit-input">${field.options.map((o) => `<option${o === field.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
                <button class="wt-edit-ok"><i class="fa-solid fa-check"></i></button>
                <button class="wt-edit-cancel"><i class="fa-solid fa-xmark"></i></button>
            </span>`);
            $value.hide().after($editor);
            $editor.find('.wt-edit-input').trigger('focus');
            $editor.find('.wt-edit-ok').on('click', () => { onEdit && onEdit(path, $editor.find('.wt-edit-input').val()); endEdit(); });
        } else {
            const inputType = field && field.type === 'number' ? 'number' : 'text';
            $editor = $(`<span class="wt-field-editor">
                <input type="${inputType}" class="wt-edit-input" value="${esc(field ? field.value : '')}">
                <button class="wt-edit-ok"><i class="fa-solid fa-check"></i></button>
                <button class="wt-edit-cancel"><i class="fa-solid fa-xmark"></i></button>
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
