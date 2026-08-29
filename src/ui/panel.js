// WorldTracker — panel shell.
//
// Owns the DOM: mounts one of the UI modes (banner | float | dock), renders the
// current canonical state into it, and forwards user gestures to handlers
// supplied by index.js. It does NOT mutate state itself.

import { fieldRow } from './fields.js';
import { displayValue, esc, iconFor } from './format.js';
import { makeDraggable, makeResizable, makeSortable } from './drag.js';
import { vlog } from '../log.js';

const ROOT_ID = 'wt-root';
const BAR_ID = 'wt-bar';
const INLINE_ID = 'wt-inline';
const SHEET_ID = 'wt-sheet';

let cfg = null; // { context, settings, getState, handlers }
let resizeHandler = null;

export function initPanel(config) {
    cfg = config;
}

/** Toggle the refresh button between "update now" and "stop" (spinner). */
export function setBusy(busy) {
    const $btn = $('.wt-update');
    $btn.toggleClass('wt-spin', !!busy);
    $btn.attr('title', busy ? 'Stop the running update' : 'Update tracker now');
    $btn.find('i').attr('class', busy ? 'fa-solid fa-stop' : 'fa-solid fa-rotate');
}

export function destroyPanel() {
    $(`#${ROOT_ID}`).remove();
    $(`#${BAR_ID}`).remove();
    $(`#${INLINE_ID}`).remove();
    $(`#${SHEET_ID}`).remove();
    if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
    }
    unpadChat();
    $('body').removeClass('wt-has-dock wt-dock-left wt-dock-right wt-dock-collapsed');
}

const SPACER_ID = 'wt-chat-spacer';

/**
 * When the banner overlaps the top of #chat (TopInfoBar is a fixed pill in
 * many themes), insert a spacer as the FIRST child of #chat so a lone first
 * message can be scrolled clear of the bar. A spacer div (vs. padding on
 * #chat) leaves #chat's own box model untouched, so ST's scroll-to-bottom
 * anchoring doesn't fight it.
 */
function padChatForBar() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const tib = document.getElementById('extensionTopBar');
    const barEl = (tib && document.getElementById(INLINE_ID)) ? tib : stripAnchorEl();
    if (!barEl) { unpadChat(); return; }
    const overlap = barEl.getBoundingClientRect().bottom - chatEl.getBoundingClientRect().top;
    let spacer = document.getElementById(SPACER_ID);
    if (overlap > 2) {
        if (!spacer) {
            spacer = document.createElement('div');
            spacer.id = SPACER_ID;
            spacer.setAttribute('aria-hidden', 'true');
        }
        spacer.style.cssText = `flex:0 0 auto;height:${Math.round(overlap + 10)}px;pointer-events:none;`;
        if (chatEl.firstElementChild !== spacer) chatEl.insertBefore(spacer, chatEl.firstChild);
    } else if (spacer) {
        spacer.remove();
    }
}

function unpadChat() {
    document.getElementById(SPACER_ID)?.remove();
}

/**
 * Character names in the current group chat (empty for a solo chat).
 * Reads the context LIVE — a context captured at boot has empty groups /
 * characters / groupId (nothing was loaded yet).
 */
export function groupMemberNames() {
    try {
        const c = globalThis.SillyTavern.getContext();
        const gid = c.groupId ?? c.selected_group;
        if (!gid) { vlog('groupMemberNames: no groupId (solo chat)'); return []; }
        const group = (c.groups || []).find((g) => String(g.id) === String(gid));
        if (!group) { vlog(`groupMemberNames: group ${gid} not in ctx.groups (${(c.groups || []).length} groups)`); return []; }
        const chars = c.characters || [];
        const raw = Array.isArray(group.members) ? group.members : [];
        const out = raw
            .map((m) => {
                const ch = chars.find((x) => x.avatar === m || x.name === m);
                return ch?.name || String(m).replace(/\.(png|webp|jpe?g|gif)$/i, '');
            })
            .filter(Boolean);
        vlog(`groupMemberNames: members=[${raw.join(', ')}] -> [${out.join(', ')}]`);
        return [...new Set(out)];
    } catch (e) {
        vlog('groupMemberNames error', e);
        return [];
    }
}

/** The persona (player) name, live from context. '' if unavailable. */
export function playerName() {
    try {
        return globalThis.SillyTavern.getContext().name1 || '';
    } catch {
        return '';
    }
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
 * Where to mount the banner strip:
 *  - { mode:'inline', tib } : as a wrapped full-width row inside TopInfoBar's
 *    #extensionTopBar, so it inherits that bar's tint / blur / hover. CSS
 *    (body:has(#wt-inline) #extensionTopBar) lets the bar grow to fit it;
 *    we never touch its position or z-index.
 *  - { mode:'sibling', sheld, before } : our own #wt-bar row inside #sheld.
 *  - null : expected layout absent -> caller uses a fixed fallback strip.
 */
function barAnchor() {
    const tib = document.getElementById('extensionTopBar');
    if (tib) return { mode: 'inline', tib };
    const sheld = document.getElementById('sheld');
    const chatEl = document.getElementById('chat');
    if (!sheld || !chatEl || chatEl.parentElement !== sheld) return null;
    return { mode: 'sibling', sheld, before: chatEl };
}

/** Anchor element the expand-sheet is positioned under (the visible strip). */
function stripAnchorEl() {
    return document.getElementById(INLINE_ID)
        || document.getElementById(BAR_ID)
        || document.getElementById(ROOT_ID);
}

/** Position the fixed expand-sheet directly under the strip. */
function positionSheet() {
    const sheet = document.getElementById(SHEET_ID);
    const anchor = stripAnchorEl();
    if (!sheet || !anchor) return;
    const r = anchor.getBoundingClientRect();
    sheet.style.top = `${Math.round(r.bottom)}px`;
    sheet.style.left = `${Math.round(r.left)}px`;
    sheet.style.width = `${Math.round(r.width)}px`;
}

const NARROW = 1000;
let _resizeDebounce = null;

const SCROLLER_SEL = `#${SHEET_ID}, .wt-float-body, .wt-dock-body`;

/** Full rebuild from current state + settings. Safe to call often. */
export function renderPanel() {
    if (!cfg) return;
    const { settings } = cfg;
    // Preserve the detail-view scroll across the teardown + rebuild.
    const prevScroll = document.querySelector(SCROLLER_SEL)?.scrollTop || 0;
    destroyPanel();
    // Nothing to track outside a chat — no panel in any mode.
    if (settings.enabled && chatActive()) {
        let mode = settings.uiMode || 'banner';
        // Free-floating / side-rail panels are unusable on a narrow screen.
        if ((mode === 'float' || mode === 'dock') && window.innerWidth <= NARROW) mode = 'banner';
        if (mode === 'dock') renderDock();
        else if (mode === 'float') renderFloat();
        else renderBanner();
    }
    renderMessageCards();

    if (prevScroll) {
        const restore = () => { const el = document.querySelector(SCROLLER_SEL); if (el && el.scrollTop !== prevScroll) el.scrollTop = prevScroll; };
        restore();
        requestAnimationFrame(restore);
        setTimeout(restore, 300);
    }

    // One resize handler for the whole panel: re-render (covers narrow-screen
    // fallback + float clamp). renderBanner also does its own lighter reflow.
    resizeHandler = () => {
        clearTimeout(_resizeDebounce);
        _resizeDebounce = setTimeout(() => renderPanel(), 150);
    };
    window.addEventListener('resize', resizeHandler);
}

// ---------------------------------------------------------------------------
// Shared content: the detail body (used by banner sheet, float, dock)
// ---------------------------------------------------------------------------

/** One pending-change row (shared by the panel review section and message cards). */
function buildPendingItem(p) {
    const { handlers } = cfg;
    const $item = $(`
        <div class="wt-review-item" data-id="${esc(p.id)}">
            <div class="wt-review-label">${esc(p.label || p.path)}${p.expected ? ' <span class="wt-review-tag" title="Model reported no elapsed time — using your Expected next interval">expected</span>' : ''}</div>
            <div class="wt-review-diff"><span class="wt-from">${esc(p.from ?? '—')}</span><i class="fa-solid fa-arrow-right"></i><span class="wt-to">${esc(p.to ?? '—')}</span></div>
            ${p.reason ? `<div class="wt-review-reason">${esc(p.reason)}</div>` : ''}
            <div class="wt-review-btns">
                ${p.kind === 'clock' ? `<button class="wt-approve-exp" title="Use your expected interval instead">exp</button>` : ''}
                <button class="wt-approve" title="Approve"><i class="fa-solid fa-check"></i></button>
                <button class="wt-decline" title="Decline"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
    `);
    $item.find('.wt-approve').on('click', () => handlers.onApprove?.(p.id));
    $item.find('.wt-decline').on('click', () => handlers.onDecline?.(p.id));
    $item.find('.wt-approve-exp').on('click', () => handlers.onApproveExpected?.(p.id));
    return $item;
}

function buildReviewSection(pending) {
    const { handlers } = cfg;
    const $q = $('<div class="wt-section wt-review"></div>');
    $q.append(`<div class="wt-section-head"><i class="fa-solid fa-inbox"></i> Proposed changes (${pending.length})
        <span class="wt-review-actions">
            <button class="wt-approve-all">Approve all</button>
            <button class="wt-decline-all">Decline all</button>
        </span></div>`);
    for (const p of pending) $q.append(buildPendingItem(p));
    $q.find('.wt-approve-all').on('click', () => handlers.onApproveAll?.());
    $q.find('.wt-decline-all').on('click', () => handlers.onDeclineAll?.());
    return $q;
}

/** One read-only applied-change row (mirrors buildPendingItem, no buttons). */
function historyItem(ch) {
    return $(`
        <div class="wt-review-item wt-history-item">
            <div class="wt-review-label">${esc(ch.label || ch.path)}</div>
            <div class="wt-review-diff"><span class="wt-from">${esc(ch.before ?? '—')}</span><i class="fa-solid fa-arrow-right"></i><span class="wt-to">${esc(ch.after ?? '—')}</span></div>
        </div>
    `);
}

/**
 * Inline per-message cards: still-pending proposals (with approve/decline) plus
 * a read-only "changes this turn" list from the history log, with a
 * revert-this-turn button and a lazy full-state expander.
 */
function renderMessageCards() {
    $('.wt-card').remove();
    const state = cfg.getState();
    const { settings, handlers } = cfg;
    if (!settings.enabled || !state) return;

    const byMsg = new Map();
    const bump = (id) => { if (!byMsg.has(id)) byMsg.set(id, { pending: [], applied: [] }); return byMsg.get(id); };
    for (const p of state.pending) { if (p.sourceMessageId != null) bump(p.sourceMessageId).pending.push(p); }
    if (settings.showMessageCards !== false) {
        for (const r of state.history || []) {
            if (r.mesId == null || r.trigger === 'revert-turn') continue;
            bump(r.mesId).applied.push(r);
        }
    }

    for (const [mesId, group] of byMsg) {
        const mes = document.querySelector(`.mes[mesid="${mesId}"]`);
        const anchor = mes?.querySelector('.mes_text');
        if (!mes || !anchor) continue;

        const activeSwipe = SillyTavern.getContext().chat?.[mesId]?.swipe_id ?? 0;
        const appliedChanges = [];
        for (const r of group.applied) {
            if (r.swipeId != null && r.swipeId !== activeSwipe) continue;
            for (const ch of r.changes || []) appliedChanges.push(ch);
        }
        if (!group.pending.length && !appliedChanges.length) continue;

        const $card = $('<div class="wt-card"></div>');

        if (group.pending.length) {
            $card.append(`<div class="wt-card-head"><i class="fa-solid fa-compass"></i> WorldTracker — ${group.pending.length} proposed change${group.pending.length > 1 ? 's' : ''}</div>`);
            for (const p of group.pending) $card.append(buildPendingItem(p));
            const $pf = $(`<div class="wt-card-foot"><button class="wt-approve-all">Approve all</button><button class="wt-decline-all">Decline all</button></div>`);
            $pf.find('.wt-approve-all').on('click', () => handlers.onApproveAll?.());
            $pf.find('.wt-decline-all').on('click', () => handlers.onDeclineAll?.());
            $card.append($pf);
        }

        if (appliedChanges.length) {
            const collapsed = !!settings.messageCardsCollapsed;
            const $applied = $(`<div class="wt-card-applied${collapsed ? ' wt-collapsed' : ''}"></div>`);
            const $head = $(`<button class="wt-card-applied-head" type="button"><i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i> ${appliedChanges.length} change${appliedChanges.length > 1 ? 's' : ''} this turn</button>`);
            const $list = $('<div class="wt-card-applied-list"></div>');
            for (const ch of appliedChanges) $list.append(historyItem(ch));
            $head.on('click', () => {
                $applied.toggleClass('wt-collapsed');
                $head.find('i').attr('class', `fa-solid ${$applied.hasClass('wt-collapsed') ? 'fa-chevron-right' : 'fa-chevron-down'}`);
            });
            const $foot = $(`<div class="wt-card-foot"><button class="wt-revert-turn" title="Undo all of this turn's tracker changes"><i class="fa-solid fa-arrow-rotate-left"></i> Revert turn</button><button class="wt-state-asof">State as of here</button></div>`);
            const $dump = $('<pre class="wt-state-dump"></pre>').prop('hidden', true);
            $foot.find('.wt-revert-turn').on('click', () => handlers.onRevertTurn?.(mesId, activeSwipe));
            $foot.find('.wt-state-asof').on('click', () => {
                if (!$dump.prop('hidden')) { $dump.prop('hidden', true); return; }
                if (!$dump.data('loaded')) { $dump.text(handlers.getStateAsOf?.(mesId) || '(unavailable)'); $dump.data('loaded', true); }
                $dump.prop('hidden', false);
            });
            $applied.append($head, $list, $foot, $dump);
            $card.append($applied);
        }

        anchor.before($card[0]);
    }
}

/**
 * Append field rows to `$container`, folding any fields that carry a `group`
 * digit into one collapsible block per digit (placed where the group's first
 * member appears). `prefix` namespaces the persisted collapse key
 * ('world' | 'stat' | 'char'). `mkRow(key, field)` returns the row element.
 */
function appendFieldRows($container, entries, prefix, mkRow) {
    const { settings, handlers } = cfg;
    const collapsedMap = settings.fieldGroupCollapsed || {};
    const groups = new Map(); // digit -> { $list, $head, names }

    for (const [key, f] of entries) {
        const g = (f && f.group != null && f.group !== '') ? String(f.group) : null;
        if (g == null) { $container.append(mkRow(key, f)); continue; }

        let bucket = groups.get(g);
        if (!bucket) {
            const gkey = `${prefix}:${g}`;
            const collapsed = !!collapsedMap[gkey];
            const $wrap = $(`<div class="wt-fieldgroup${collapsed ? ' wt-collapsed' : ''}" data-gkey="${esc(gkey)}"></div>`);
            const $head = $(`<button class="wt-fieldgroup-head" type="button"><i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i> <span class="wt-fieldgroup-title"></span></button>`);
            const $list = $('<div class="wt-fieldgroup-list"></div>');
            $head.on('click', () => handlers.onToggleFieldGroup?.(gkey, !$wrap.hasClass('wt-collapsed')));
            $wrap.append($head, $list);
            $container.append($wrap);
            bucket = { $list, $head, names: [] };
            groups.set(g, bucket);
        }
        bucket.names.push(key);
        bucket.$list.append(mkRow(key, f));
    }

    for (const b of groups.values()) {
        const joined = b.names.join(', ');
        const label = joined.length > 30 ? `${joined.slice(0, 28)}…` : joined;
        b.$head.find('.wt-fieldgroup-title').text(`${label} (${b.names.length})`);
    }
}

function buildDetailBody() {
    const state = cfg.getState();
    const { settings, handlers } = cfg;
    const $body = $('<div class="wt-detail-body"></div>');
    if (!state) {
        $body.append('<div class="wt-empty">No active chat.</div>');
        return $body;
    }

    // Pending review queue
    if (state.pending.length) $body.append(buildReviewSection(state.pending));

    const showLock = settings.showLockIcons !== false;
    const sec = settings.sections || {};
    const onEdit = (path, val, o) => handlers.onEdit?.(path, val, o);
    const onToggleLock = (path, locked) => handlers.onToggleLock?.(path, locked);
    const histFor = (path) => { try { return handlers.fieldHistory?.(path) || []; } catch { return []; } };
    const rowOpts = (path, label) => ({
        showLock, label, onEdit, onToggleLock,
        history: histFor(path),
        onPickHistory: (v) => handlers.onEdit?.(path, path === 'clock' ? { __setIso: v } : v, { trigger: 'scrub' }),
    });

    // World section (clock always; world fields gated by the section toggle)
    const $world = $('<div class="wt-section"></div>').append('<div class="wt-section-head"><i class="fa-solid fa-earth-americas"></i> World</div>');
    $world.append(fieldRow('clock', state.clock, state, rowOpts('clock', 'Time')));
    if (sec.world !== false) {
        appendFieldRows($world, Object.entries(state.world), 'world',
            (key, f) => fieldRow(`world.${key}`, f, state, rowOpts(`world.${key}`, key)));
    }
    $body.append($world);

    // User stats
    if (sec.userStats && Object.keys(state.userStats).length) {
        const $us = $('<div class="wt-section"></div>').append('<div class="wt-section-head"><i class="fa-solid fa-user"></i> You</div>');
        appendFieldRows($us, Object.entries(state.userStats), 'stat',
            (key, f) => fieldRow(`userStats.${key}`, f, state, rowOpts(`userStats.${key}`, key)));
        $body.append($us);
    }

    // Characters — main (self / by-name / the player's own card) up top,
    // narrator-run NPCs in a collapsible group below. Absent characters fade,
    // fold their fields, and sink to the bottom of their list (most recently
    // present first).
    if (sec.characters !== false) {
        const names = Object.keys(state.characters);
        const pName = playerName();
        const $cs = $('<div class="wt-section"></div>');
        const $head = $('<div class="wt-section-head"><i class="fa-solid fa-users"></i> Characters</div>');
        const $addAll = $('<button class="wt-add-participants" title="Track every chat participant"><i class="fa-solid fa-user-plus"></i></button>');
        $addAll.on('click', () => handlers.onAddParticipants?.());
        $head.append($addAll);
        $cs.append($head);

        const members = groupMemberNames();
        const isPresent = (n) => state.characters[n].present !== false;
        const byOrder = (a, b) => (state.characters[a].order ?? 1e9) - (state.characters[b].order ?? 1e9);
        const sortByPresence = (arr) => [
            ...arr.filter(isPresent).sort(byOrder),
            ...arr.filter((n) => !isPresent(n))
                .sort((a, b) => byOrder(a, b)
                    || (state.characters[b].lastPresentTs || 0) - (state.characters[a].lastPresentTs || 0)),
        ];
        const buildCard = (name) => {
            const entry = state.characters[name];
            const isPlayer = !!pName && name === pName;
            const absent = !isPlayer && entry.present === false;
            const byNames = [...new Set([...members, ...names])].filter((n) => n !== name);
            if (entry.updater && !['narrator', 'self'].includes(entry.updater) && !byNames.includes(entry.updater)) byNames.push(entry.updater);
            const $c = $(`<div class="wt-char${absent ? ' wt-absent' : ''}${isPlayer ? ' wt-char-player' : ''}" data-name="${esc(name)}"><div class="wt-char-head">
                ${isPlayer ? '' : '<span class="wt-char-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>'}
                ${isPlayer ? '' : `<button class="wt-char-present" title="${absent ? 'Away — click to mark present' : 'Present — click to mark away'}"><i class="fa-solid ${absent ? 'fa-eye-slash' : 'fa-eye'}"></i></button>`}
                <span class="wt-char-name">${esc(name)}${isPlayer ? ' <span class="wt-char-you">you</span>' : ''}</span>
                ${isPlayer ? '' : `<select class="wt-updater" title="Who updates this character">
                    <option value="narrator"${entry.updater === 'narrator' ? ' selected' : ''}>Narrator</option>
                    <option value="self"${entry.updater === 'self' ? ' selected' : ''}>Self only (${esc(name)})</option>
                    ${byNames.map((n) => `<option value="${esc(n)}"${entry.updater === n ? ' selected' : ''}>By ${esc(n)}</option>`).join('')}
                </select>`}
                <button class="wt-char-remove" title="Stop tracking ${esc(name)}"><i class="fa-solid fa-trash"></i></button>
            </div></div>`);
            $c.find('.wt-char-present').on('click', () => handlers.onSetPresent?.(name, absent));
            $c.find('.wt-updater').on('change', function () { handlers.onSetUpdater?.(name, this.value); });
            $c.find('.wt-char-remove').on('click', () => handlers.onRemoveCharacter?.(name));
            const $fields = $('<div class="wt-char-fields"></div>');
            appendFieldRows($fields, Object.entries(entry.fields), 'char',
                (key, f) => fieldRow(`characters.${name}.fields.${key}`, f, state, rowOpts(`characters.${name}.fields.${key}`, key)));
            $c.append($fields);
            return $c;
        };

        const isMain = (n) => n === pName || state.characters[n].updater !== 'narrator';
        const otherMain = sortByPresence(names.filter((n) => isMain(n) && n !== pName));
        const mainNames = names.includes(pName) ? [pName, ...otherMain] : otherMain;
        const npcNames = sortByPresence(names.filter((n) => !isMain(n)));

        const onReorder = () => {
            const order = [...$cs[0].querySelectorAll('.wt-char')].map((el) => el.dataset.name).filter(Boolean);
            handlers.onReorderCharacters?.(order);
        };

        const $mainList = $('<div class="wt-char-main-list"></div>');
        for (const name of mainNames) $mainList.append(buildCard(name));
        $cs.append($mainList);
        makeSortable($mainList[0], { itemSelector: '.wt-char:not(.wt-char-player)', handleSelector: '.wt-char-grip', onDrop: onReorder });

        if (npcNames.length) {
            const collapsed = !!settings.npcCollapsed;
            const $g = $(`<div class="wt-npc-group${collapsed ? ' wt-collapsed' : ''}">
                <button class="wt-npc-toggle"><i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i> NPCs (${npcNames.length})</button>
                <div class="wt-npc-list"></div>
            </div>`);
            $g.find('.wt-npc-toggle').on('click', () => handlers.onToggleNpc?.(!collapsed));
            if (!collapsed) {
                const $list = $g.find('.wt-npc-list');
                for (const name of npcNames) $list.append(buildCard(name));
                makeSortable($list[0], { itemSelector: '.wt-char', handleSelector: '.wt-char-grip', onDrop: onReorder });
            }
            $cs.append($g);
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
    $bar.find('.wt-update').on('click', () => handlers.onUpdateButton?.());
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
    if (anchor && anchor.mode === 'sibling') patchSheld(anchor.sheld);

    let $root;
    if (anchor && anchor.mode === 'inline') {
        $root = $(`<div id="${INLINE_ID}"${expanded ? ' class="wt-expanded"' : ''}></div>`);
    } else if (anchor && anchor.mode === 'sibling') {
        $root = $(`<div id="${BAR_ID}" class="wt-bar${expanded ? ' wt-expanded' : ''}"></div>`);
    } else {
        $root = $(`<div id="${ROOT_ID}" class="wt-bar wt-bar-floating${expanded ? ' wt-expanded' : ''}"></div>`);
    }

    // chip strip
    const sec = settings.sections || {};
    const $strip = $('<div class="wt-strip"></div>');
    $strip.append(chip('clock', 'Time', displayValue('clock', state.clock, state), state.clock.locked));
    if (sec.world !== false) {
        for (const [key, f] of Object.entries(state.world)) {
            $strip.append(chip(`world.${key}`, key, displayValue(`world.${key}`, f, state), f.locked));
        }
    }
    if (sec.userStats) {
        for (const [key, f] of Object.entries(state.userStats)) {
            $strip.append(chip(`userStats.${key}`, key, displayValue(`userStats.${key}`, f, state), f.locked));
        }
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

    if (anchor && anchor.mode === 'inline') anchor.tib.appendChild($root[0]);
    else if (anchor && anchor.mode === 'sibling') anchor.sheld.insertBefore($root[0], anchor.before);
    else $('body').append($root);

    // Expand sheet: a fixed-position element on <body>, positioned under the
    // strip. Fixed + high z-index sidesteps every clipping / stacking-context
    // issue from whatever the theme does to #extensionTopBar or #sheld.
    if (expanded) {
        const $sheet = $(`<div id="${SHEET_ID}" class="wt-sheet"></div>`).append(buildDetailBody());
        $('body').append($sheet);
    }

    // Re-add / size the chat spacer synchronously so there's no frame where it
    // vanished (destroyPanel removed it) — that gap would jump the scroll.
    // Re-measure after TopInfoBar's height transition settles. (Window-resize is
    // handled by renderPanel's single handler, which re-runs this whole path.)
    const reflow = () => { padChatForBar(); positionSheet(); };
    padChatForBar();
    requestAnimationFrame(reflow);
    setTimeout(reflow, 250);
    setTimeout(reflow, 900);

    vlog(`banner rendered (${anchor ? anchor.mode : 'fixed-fallback'}), ${Object.keys(state.characters).length} character(s), ${pendingCount} pending`);
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
// Float / Dock  (narrow-screen fallback is handled in renderPanel)
// ---------------------------------------------------------------------------

function collapseBtn() {
    const collapsed = !!cfg.settings.panelCollapsed;
    const $b = $(`<button class="wt-btn wt-collapse-btn" title="${collapsed ? 'Expand' : 'Collapse'}"><i class="fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i></button>`);
    $b.on('click', () => cfg.handlers.onCollapse?.(!collapsed));
    return $b;
}

function renderFloat() {
    const { settings, handlers } = cfg;
    const collapsed = !!settings.panelCollapsed;
    const p = settings.floatPos || { x: 80, y: 80 };
    const s = settings.floatSize || { w: 340, h: 420 };
    const x = Math.max(0, Math.min(p.x, window.innerWidth - 120));
    const y = Math.max(0, Math.min(p.y, window.innerHeight - 60));
    const hStyle = collapsed ? '' : `height:${s.h}px;`;
    const $root = $(`<div id="${ROOT_ID}" class="wt-float${collapsed ? ' wt-collapsed' : ''}" style="left:${x}px;top:${y}px;width:${s.w}px;${hStyle}"></div>`);
    const $head = $('<div class="wt-float-head"><span><i class="fa-solid fa-compass"></i> WorldTracker</span></div>')
        .append($('<div class="wt-toolbar-wrap"></div>').append(collapseBtn()).append(buildToolbar()));
    $root.append($head);
    if (!collapsed) $root.append($('<div class="wt-float-body"></div>').append(buildDetailBody()));
    $('body').append($root);

    makeDraggable($root[0], $head[0], 'wtFloat', ({ x: nx, y: ny }) => {
        settings.floatPos = { x: nx, y: ny };
        handlers.onPersistLayout?.();
    }, '.wt-toolbar-wrap');
    if (!collapsed) {
        makeResizable($root[0], 'wtFloat', ({ w, h }) => {
            settings.floatSize = { w, h };
            handlers.onPersistLayout?.();
        });
    }
}

function renderDock() {
    const { settings } = cfg;
    const collapsed = !!settings.panelCollapsed;
    const side = settings.dockSide === 'left' ? 'left' : 'right';
    const $root = $(`<div id="${ROOT_ID}" class="wt-dock wt-dock-${side}${collapsed ? ' wt-collapsed' : ''}"></div>`);
    const $head = $(`<div class="wt-dock-head"><span><i class="fa-solid fa-compass"></i> WorldTracker</span></div>`);
    const $flip = $(`<button class="wt-btn wt-dock-flip" title="Dock to the other side"><i class="fa-solid fa-left-right"></i></button>`);
    $flip.on('click', () => cfg.handlers.onDockSide?.(side === 'left' ? 'right' : 'left'));
    $head.append($('<div class="wt-toolbar-wrap"></div>').append(collapseBtn()).append($flip).append(buildToolbar()));
    $root.append($head);
    if (!collapsed) $root.append($('<div class="wt-dock-body"></div>').append(buildDetailBody()));
    $('body').append($root).addClass(`wt-has-dock wt-dock-${side}${collapsed ? ' wt-dock-collapsed' : ''}`);
}
