// WorldTracker — panel shell.
//
// Owns the DOM: mounts one of the UI modes (banner | float | dock), renders the
// current canonical state into it, and forwards user gestures to handlers
// supplied by index.js. It does NOT mutate state itself.

import { fieldRow } from './fields.js';
import { displayValue, esc, iconFor } from './format.js';
import * as clock from '../clock.js';

const ROOT_ID = 'wt-root';
const BAR_ID = 'wt-bar';
const INLINE_ID = 'wt-inline';

let cfg = null; // { context, settings, getState, handlers }

export function initPanel(config) {
    cfg = config;
}

export function destroyPanel() {
    $(`#${ROOT_ID}`).remove();
    $(`#${BAR_ID}`).remove();
    $(`#${INLINE_ID}`).remove();
    $('body').removeClass('wt-has-dock wt-dock-left wt-dock-right');
}

/** True when a character/group chat is open. Nothing to track otherwise. */
function chatActive() {
    try {
        const id = cfg.context.getCurrentChatId?.();
        return id !== undefined && id !== null && id !== '';
    } catch {
        return true; // if we can't tell, don't hide
    }
}

/**
 * SillyTavern's #sheld is a grid in some versions; TopInfoBar flips it to a
 * flex column so inserted rows stack. Do the same (idempotent, harmless if
 * TopInfoBar already did it or if #sheld is already flex).
 */
function patchSheld(sheld) {
    if (getComputedStyle(sheld).display === 'grid') sheld.classList.add('wt-flexpatch');
}

/**
 * Decide how to mount the banner:
 *  - 'inline' : append a wrapped full-width row INSIDE TopInfoBar's
 *    #extensionTopBar so it inherits that bar's tint / blur / hover exactly.
 *  - 'sibling': our own #wt-bar row inside #sheld before #chat.
 *  - null     : expected layout not present -> caller uses fixed fallback.
 */
function barAnchor() {
    const sheld = document.getElementById('sheld');
    const chatEl = document.getElementById('chat');
    if (!sheld || !chatEl || chatEl.parentElement !== sheld) return null;
    const tib = document.getElementById('extensionTopBar');
    if (tib && tib.parentElement === sheld) return { mode: 'inline', sheld, tib };
    return { mode: 'sibling', sheld, before: chatEl };
}

/** Full rebuild from current state + settings. Safe to call often. */
export function renderPanel() {
    if (!cfg) return;
    const { settings } = cfg;
    destroyPanel();
    if (!settings.enabled) return;

    const mode = settings.uiMode || 'banner';
    if (mode === 'banner') renderBanner();
    else if (mode === 'dock') renderDock();
    else renderFloat();
}

// ---------------------------------------------------------------------------
// Shared content: the detail body (used by banner sheet, float, dock)
// ---------------------------------------------------------------------------

function buildDetailBody() {
    const state = cfg.getState();
    const { settings, handlers } = cfg;
    const $body = $('<div class="wt-detail-body"></div>');
    if (!state) {
        $body.append('<div class="wt-empty">No active chat.</div>');
        return $body;
    }

    // Pending review queue
    if (state.pending.length) {
        const $q = $('<div class="wt-section wt-review"></div>');
        $q.append(`<div class="wt-section-head"><i class="fa-solid fa-inbox"></i> Proposed changes (${state.pending.length})
            <span class="wt-review-actions">
                <button class="wt-approve-all" title="Approve all">Approve all</button>
                <button class="wt-decline-all" title="Decline all">Decline all</button>
            </span></div>`);
        for (const p of state.pending) {
            const $item = $(`
                <div class="wt-review-item" data-id="${esc(p.id)}">
                    <div class="wt-review-label">${esc(p.label || p.path)}</div>
                    <div class="wt-review-diff"><span class="wt-from">${esc(p.from ?? '—')}</span><i class="fa-solid fa-arrow-right"></i><span class="wt-to">${esc(p.to ?? '—')}</span></div>
                    ${p.reason ? `<div class="wt-review-reason">${esc(p.reason)}</div>` : ''}
                    <div class="wt-review-btns">
                        <button class="wt-approve" title="Approve"><i class="fa-solid fa-check"></i></button>
                        <button class="wt-decline" title="Decline"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
            `);
            $item.find('.wt-approve').on('click', () => handlers.onApprove?.(p.id));
            $item.find('.wt-decline').on('click', () => handlers.onDecline?.(p.id));
            $q.append($item);
        }
        $q.find('.wt-approve-all').on('click', () => handlers.onApproveAll?.());
        $q.find('.wt-decline-all').on('click', () => handlers.onDeclineAll?.());
        $body.append($q);
    }

    const showLock = settings.showLockIcons !== false;
    const onEdit = (path, val) => handlers.onEdit?.(path, val);
    const onToggleLock = (path, locked) => handlers.onToggleLock?.(path, locked);

    // World section
    const $world = $('<div class="wt-section"></div>').append('<div class="wt-section-head"><i class="fa-solid fa-earth-americas"></i> World</div>');
    $world.append(fieldRow('clock', state.clock, state, { showLock, label: 'Time', onEdit, onToggleLock }));
    for (const [key, f] of Object.entries(state.world)) {
        $world.append(fieldRow(`world.${key}`, f, state, { showLock, label: key, onEdit, onToggleLock }));
    }
    $body.append($world);

    // User stats
    if (Object.keys(state.userStats).length) {
        const $us = $('<div class="wt-section"></div>').append('<div class="wt-section-head"><i class="fa-solid fa-user"></i> You</div>');
        for (const [key, f] of Object.entries(state.userStats)) {
            $us.append(fieldRow(`userStats.${key}`, f, state, { showLock, label: key, onEdit, onToggleLock }));
        }
        $body.append($us);
    }

    // Characters
    const names = Object.keys(state.characters);
    if (names.length) {
        const $cs = $('<div class="wt-section"></div>').append('<div class="wt-section-head"><i class="fa-solid fa-users"></i> Characters</div>');
        for (const name of names) {
            const entry = state.characters[name];
            const $c = $(`<div class="wt-char"><div class="wt-char-head">
                <span class="wt-char-name">${esc(name)}</span>
                <select class="wt-updater" title="Who updates this character">
                    <option value="narrator"${entry.updater === 'narrator' ? ' selected' : ''}>Narrator</option>
                    <option value="self"${entry.updater === 'self' ? ' selected' : ''}>Self only</option>
                    ${names.filter((n) => n !== name).map((n) => `<option value="${esc(n)}"${entry.updater === n ? ' selected' : ''}>By ${esc(n)}</option>`).join('')}
                </select>
                <button class="wt-char-remove" title="Stop tracking ${esc(name)}"><i class="fa-solid fa-trash"></i></button>
            </div></div>`);
            $c.find('.wt-updater').on('change', function () { handlers.onSetUpdater?.(name, $(this).val()); });
            $c.find('.wt-char-remove').on('click', () => handlers.onRemoveCharacter?.(name));
            for (const [key, f] of Object.entries(entry.fields)) {
                $c.append(fieldRow(`characters.${name}.fields.${key}`, f, state, { showLock, label: key, onEdit, onToggleLock }));
            }
            $cs.append($c);
        }
        $body.append($cs);
    }

    return $body;
}

function buildToolbar() {
    const { settings, handlers } = cfg;
    const $bar = $(`
        <div class="wt-toolbar">
            <button class="wt-btn wt-update" title="Update tracker now"><i class="fa-solid fa-rotate"></i></button>
            <select class="wt-mode" title="Display mode">
                <option value="banner"${settings.uiMode === 'banner' ? ' selected' : ''}>Banner</option>
                <option value="float"${settings.uiMode === 'float' ? ' selected' : ''}>Float</option>
                <option value="dock"${settings.uiMode === 'dock' ? ' selected' : ''}>Dock</option>
            </select>
            <button class="wt-btn wt-settings" title="WorldTracker settings"><i class="fa-solid fa-gear"></i></button>
        </div>
    `);
    $bar.find('.wt-update').on('click', () => handlers.onManualUpdate?.());
    $bar.find('.wt-mode').on('change', function () { handlers.onModeChange?.($(this).val()); });
    $bar.find('.wt-settings').on('click', () => handlers.onOpenSettings?.());
    return $bar;
}

// ---------------------------------------------------------------------------
// Banner mode
// ---------------------------------------------------------------------------

function renderBanner() {
    const { settings, handlers } = cfg;

    // Nothing to track outside a chat — render nothing at all.
    if (!chatActive()) return;

    const state = cfg.getState();
    if (!state) return;
    const pendingCount = state.pending.length;
    const expanded = !!settings.bannerExpanded;

    const anchor = barAnchor();
    if (anchor) patchSheld(anchor.sheld);

    // inline  -> wrapped full-width row inside #extensionTopBar (inherits its look)
    // sibling -> our own #wt-bar row inside #sheld
    // null    -> fixed fallback strip on <body>
    let $root;
    if (anchor && anchor.mode === 'inline') {
        $root = $(`<div id="${INLINE_ID}" class="wt-inline${expanded ? ' wt-expanded' : ''}"></div>`);
    } else if (anchor && anchor.mode === 'sibling') {
        $root = $(`<div id="${BAR_ID}" class="wt-bar${expanded ? ' wt-expanded' : ''}"></div>`);
    } else {
        $root = $(`<div id="${ROOT_ID}" class="wt-bar wt-bar-floating${expanded ? ' wt-expanded' : ''}"></div>`);
    }

    // chip strip
    const $strip = $('<div class="wt-strip"></div>');
    $strip.append(chip('clock', 'Time', displayValue('clock', state.clock, state), state.clock.locked));
    for (const [key, f] of Object.entries(state.world)) {
        $strip.append(chip(`world.${key}`, key, displayValue(`world.${key}`, f, state), f.locked));
    }
    for (const [key, f] of Object.entries(state.userStats)) {
        $strip.append(chip(`userStats.${key}`, key, displayValue(`userStats.${key}`, f, state), f.locked));
    }

    const $right = $('<div class="wt-strip-right"></div>');
    const $badge = $(`<button class="wt-btn wt-review-badge${pendingCount ? ' wt-has-pending' : ''}" title="Proposed changes">
        <i class="fa-solid fa-inbox"></i><span class="wt-badge-n">${pendingCount}</span></button>`);
    $badge.on('click', () => handlers.onToggleExpand?.(true));
    $right.append($badge);
    $right.append(buildToolbar());
    const $caret = $(`<button class="wt-btn wt-expand-toggle" title="${expanded ? 'Collapse' : 'Expand'}"><i class="fa-solid ${expanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i></button>`);
    $caret.on('click', () => handlers.onToggleExpand?.(!expanded));
    $right.append($caret);

    $root.append($('<div class="wt-strip-wrap"></div>').append($strip).append($right));

    if (expanded) {
        $root.append($('<div class="wt-sheet"></div>').append(buildDetailBody()));
    }

    if (anchor && anchor.mode === 'inline') anchor.tib.appendChild($root[0]);
    else if (anchor && anchor.mode === 'sibling') anchor.sheld.insertBefore($root[0], anchor.before);
    else $('body').append($root);
}

/** Re-run banner placement (e.g. if TopInfoBar mounted after us). */
export function replaceBanner() {
    if (cfg && cfg.settings.enabled && (cfg.settings.uiMode || 'banner') === 'banner') {
        renderPanel();
    }
}

function chip(path, label, value, locked) {
    return $(`<span class="wt-chip${locked ? ' wt-locked' : ''}" data-path="${esc(path)}" title="${esc(label)}">
        <i class="fa-solid ${iconFor(label)}"></i><span class="wt-chip-v">${esc(value)}</span>${locked ? '<i class="fa-solid fa-lock wt-chip-lock"></i>' : ''}
    </span>`);
}

// ---------------------------------------------------------------------------
// Float / Dock — minimal for now (full drag/resize in a later milestone)
// ---------------------------------------------------------------------------

function renderFloat() {
    const { settings } = cfg;
    const p = settings.floatPos || { x: 80, y: 80 };
    const s = settings.floatSize || { w: 340, h: 420 };
    const $root = $(`<div id="${ROOT_ID}" class="wt-float" style="left:${p.x}px;top:${p.y}px;width:${s.w}px;height:${s.h}px"></div>`);
    $root.append($('<div class="wt-float-head"><span><i class="fa-solid fa-compass"></i> WorldTracker</span></div>').append(buildToolbar()));
    $root.append($('<div class="wt-float-body"></div>').append(buildDetailBody()));
    $('body').append($root);
    // drag/resize wired in milestone 8
}

function renderDock() {
    const { settings } = cfg;
    const side = settings.dockSide === 'left' ? 'left' : 'right';
    const $root = $(`<div id="${ROOT_ID}" class="wt-dock wt-dock-${side}"></div>`);
    $root.append($('<div class="wt-dock-head"><span><i class="fa-solid fa-compass"></i> WorldTracker</span></div>').append(buildToolbar()));
    $root.append($('<div class="wt-dock-body"></div>').append(buildDetailBody()));
    $('body').append($root).addClass(`wt-has-dock wt-dock-${side}`);
}
