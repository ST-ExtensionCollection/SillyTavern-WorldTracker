// WorldTracker — separate-request world-state tracker with field locking and an
// approve/decline gate. Entry point.

import { loadSettings, MODULE_NAME } from './src/settings.js';
import * as state from './src/state.js';
import * as clockUtil from './src/clock.js';
import { log, vlog, setVerbose } from './src/log.js';
import { buildTrackerPrompt, buildResponseSchema } from './src/prompt.js';
import { parseTrackerResponse } from './src/parse.js';
import { runTrackerRequest, listProfiles } from './src/request.js';
import { diffToProposals, applyProposal } from './src/merge.js';
import { updateInjection, buildSummary } from './src/inject.js';
import * as profiles from './src/profiles.js';
import { openSettingsModal } from './src/ui/settings-modal.js';
import { initPanel, renderPanel, replaceBanner, setBusy, groupMemberNames } from './src/ui/panel.js';

const ctx = SillyTavern.getContext();
const {
    eventSource,
    event_types,
    extensionSettings,
    saveSettingsDebounced,
} = ctx;

let settings = null;

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

function getState() {
    return state.get(settings.schema);
}

function refresh() {
    renderPanel();
    try { updateInjection(ctx, settings.enabled ? getState() : null, settings); } catch (e) { log('injection error', e); }
}

// ---------------------------------------------------------------------------
// Handlers wired into the panel
// ---------------------------------------------------------------------------

/** swipe_id of a chat message, for tagging history records. */
function swipeIdOf(mesId) {
    try { return SillyTavern.getContext().chat?.[mesId]?.swipe_id ?? 0; } catch { return 0; }
}

function onEdit(path, val, opts = {}) {
    const st = getState();
    if (!st) return;
    if (path === 'clock' && val && typeof val === 'object') {
        const beforeIso = st.clock.iso;
        if (val.__expected) {
            st.clock.expectedInterval = {
                days: Math.max(0, Number(val.__expected.days) || 0),
                hours: Math.max(0, Number(val.__expected.hours) || 0),
                minutes: Math.max(0, Number(val.__expected.minutes) || 0),
                seconds: Math.max(0, Number(val.__expected.seconds) || 0),
            };
        }
        if (val.__elapsed) {
            st.clock.iso = clockUtil.addElapsed(st.clock.iso, val.__elapsed);
        } else if (val.__setIso) {
            st.clock.iso = clockUtil.toIso(val.__setIso);
        }
        state.save();
        if (st.clock.iso !== beforeIso) {
            state.pushHistory(st, { mesId: null, trigger: opts.trigger || 'edit', changes: [{
                path: 'clock', label: 'Time', kind: 'clock',
                before: clockUtil.format(beforeIso, st.clock.displayFormat),
                after: clockUtil.format(st.clock.iso, st.clock.displayFormat),
                beforeIso, afterIso: st.clock.iso, rawBefore: beforeIso, rawAfter: st.clock.iso,
            }] });
        }
        vlog(`clock ->`, st.clock.iso, val.__expected ? `(expected ${JSON.stringify(st.clock.expectedInterval)})` : '');
        refresh();
        return;
    }
    const f = state.fieldAt(st, path);
    const rawBefore = f ? f.value : undefined;
    state.applyValue(st, path, val, null);
    if (f && String(rawBefore) !== String(val)) {
        state.pushHistory(st, { mesId: null, trigger: opts.trigger || 'edit', changes: [{
            path, label: state.labelFor(path), kind: 'field',
            before: String(rawBefore ?? '—'), after: String(val ?? '—'), rawBefore, rawAfter: val,
        }] });
    }
    vlog(`edit ${path} ->`, val);
    refresh();
}

function onToggleLock(path, locked) {
    const st = getState();
    if (!st) return;
    state.setLock(st, path, locked);
    vlog(`${locked ? 'lock' : 'unlock'} ${path}`);
    refresh();
}

function onToggleExpand(expand) {
    settings.bannerExpanded = !!expand;
    saveSettingsDebounced();
    refresh();
}

function onModeChange(mode) {
    settings.uiMode = mode;
    saveSettingsDebounced();
    refresh();
}

function onPersistLayout() {
    saveSettingsDebounced();
}

function onDockSide(side) {
    settings.dockSide = side === 'left' ? 'left' : 'right';
    saveSettingsDebounced();
    refresh();
}

function onCollapse(v) {
    settings.panelCollapsed = !!v;
    saveSettingsDebounced();
    refresh();
}

function onToggleNpc(v) {
    settings.npcCollapsed = !!v;
    saveSettingsDebounced();
    refresh();
}

function onToggleFieldGroup(gkey, collapsed) {
    if (!settings.fieldGroupCollapsed || typeof settings.fieldGroupCollapsed !== 'object') settings.fieldGroupCollapsed = {};
    settings.fieldGroupCollapsed[gkey] = !!collapsed;
    saveSettingsDebounced();
    refresh();
}

let updateJob = null;

/** ⟳ button: start an update, or stop the running one. */
function onUpdateButton() {
    if (updateJob) return stopUpdate('user');
    return onManualUpdate();
}

function stopUpdate(who) {
    if (!updateJob) return;
    const job = updateJob;
    job.superseded = true;
    try { job.controller.abort(); } catch { /* ignore */ }
    updateJob = null;
    setBusy(false);
    log(`update aborted (${who})`);
    if (who === 'user') toastr.info('WorldTracker: update cancelled.');
}

async function onManualUpdate(opts = {}) {
    const st = getState();
    if (!st) { toastr.warning('WorldTracker: no active chat.'); return; }

    if (updateJob) {
        updateJob.superseded = true;
        try { updateJob.controller.abort(); } catch { /* ignore */ }
    }

    const c = SillyTavern.getContext();
    if (settings.trackPlayer) state.syncPersonaCard(st, settings.schema); // catch a persona swap before this pass
    const n = Math.max(1, Number(settings.includeLastXMessages) || 6);
    const chat = c.chat || [];
    const srcId = Number.isInteger(opts.sourceMessageId)
        ? opts.sourceMessageId
        : Math.max(0, chat.length - 1);
    const srcMsg = chat[srcId];
    const authorName = srcMsg && !srcMsg.is_user ? srcMsg.name : null;
    // Context window ends AT the source message — never leak messages that come
    // after it (e.g. when re-rolling an older reply).
    const hi = Math.min(srcId, chat.length - 1);
    const lo = Math.max(0, hi - n + 1);
    const recent = chat.slice(lo, hi + 1).map((m) => ({ name: m.name, is_user: !!m.is_user, mes: m.mes }));
    const firstTurn = srcId === 0;

    // Re-processing a message (pressing the arrows again) must recompute the
    // clock from the PRE-turn time, not from where a prior pass already left it,
    // or repeated passes compound the advance. Other fields may churn freely.
    if (st.snapshots && (srcId in st.snapshots)) {
        const baseData = state.peekSnapshot(st, srcId); // exact key exists -> pre-turn state
        if (baseData && baseData.clock && baseData.clock.iso) st.clock.iso = baseData.clock.iso;
    }

    const { messages } = buildTrackerPrompt(st, recent, { settings, playerName: c.name1, authorName, firstTurn });

    // Snapshot the pre-query state (write-once) so a later swipe/regen/delete of
    // this message can revert cleanly.
    state.snapshot(st, srcId);

    const job = { controller: new AbortController(), superseded: false };
    updateJob = job;
    setBusy(true);
    log(`tracker request: ${recent.length} msg(s), src #${srcId}${authorName ? ` by ${authorName}` : ''}, ${messages.reduce((a, m) => a + m.content.length, 0)} chars`);

    try {
        const schema = settings.structuredOutput ? buildResponseSchema(st, settings.sections || {}, firstTurn) : null;
        const text = await runTrackerRequest(messages, settings, c, job.controller.signal, schema);
        if (job.superseded) { log('response ignored (superseded)'); return; }
        vlog('tracker response (first 500):', String(text || '').slice(0, 500));
        const res = parseTrackerResponse(text);
        if (!res.ok) {
            log('parse FAILED. data:', res.data, 'raw:', res.raw);
            toastr.warning('WorldTracker: could not parse tracker response (see console).');
            return;
        }
        log('parsed tracker data:', res.data);
        ingestProposals(st, diffToProposals(st, res.data, {
            sourceMessageId: srcId, authorName, sections: settings.sections || {},
            narratorName: settings.narratorName || '', playerName: c.name1 || '',
        }));
    } catch (err) {
        if (job.superseded || job.controller.signal.aborted) { log('request aborted'); return; }
        log('request error:', err);
        toastr.error(`WorldTracker request failed: ${err?.message || err}`);
    } finally {
        if (updateJob === job) { updateJob = null; setBusy(false); }
    }
}

function onSetUpdater(name, updater) {
    const st = getState();
    if (!st || !st.characters[name]) return;
    st.characters[name].updater = updater;
    state.save();
    refresh();
}

function onRemoveCharacter(name) {
    const st = getState();
    if (!st) return;
    state.removeCharacter(st, name);
    refresh();
}

async function promptText(title, def = '') {
    try {
        const v = await ctx.Popup.show.input(title, '', def);
        return (v ?? '').trim();
    } catch {
        return (window.prompt(title, def) ?? '').trim();
    }
}

/** Rename a tracked character everywhere in live state. */
function renameCharacter(oldName, newName) {
    const st = getState();
    if (!st) return;
    const r = state.renameCharacter(st, oldName, newName);
    if (!r.ok) { toastr.warning(`WorldTracker: ${r.reason}.`); return; }
    if (settings.narratorName === oldName) { settings.narratorName = newName; saveSettingsDebounced(); }
    log(`renamed "${oldName}" -> "${newName}"`);
    refresh();
}

async function onRenameCharacter(oldName) {
    const newName = await promptText(`Rename tracked character "${oldName}" to:`, oldName);
    if (newName) renameCharacter(oldName, newName);
}

function onSetPresent(name, present) {
    const st = getState();
    if (!st) return;
    state.setPresent(st, name, present);
    vlog(`presence ${name} -> ${present ? 'present' : 'away'}`);
    refresh();
}

/** Set/clear how `subject` regards `object`; optionally mirror the reverse. */
function onSetRel(subject, object, value, mirror) {
    const st = getState();
    if (!st || !st.characters[subject]) return;
    const rec = (a, b) => {
        const before = st.characters[a]?.rels?.[b];
        if (String(before ?? '') === String(value ?? '')) return null;
        return {
            path: `characters.${a}.rels.${b}`, label: `${a} → ${b}`, kind: 'rel',
            before: before || '—', after: value || '—', rawBefore: before ?? '', rawAfter: value ?? '',
        };
    };
    const changes = [rec(subject, object)];
    if (mirror && st.characters[object]) changes.push(rec(object, subject));
    state.setRel(st, subject, object, value, { mirror: !!mirror });
    const real = changes.filter(Boolean);
    if (real.length) state.pushHistory(st, { mesId: null, trigger: 'edit', changes: real });
    vlog(`rel ${subject} -> ${object} = ${value || '(cleared)'}${mirror ? ' (mirrored)' : ''}`);
    refresh();
}

function onToggleRels(collapsed) {
    settings.relsCollapsed = !!collapsed;
    saveSettingsDebounced();
    refresh();
}

let lastCharOrderSig = '';
function onReorderCharacters(names) {
    const st = getState();
    if (!st) return;
    const sig = names.join(String.fromCharCode(30));
    if (sig === lastCharOrderSig) return; // drag ended without moving anything
    lastCharOrderSig = sig;
    state.reorderCharacters(st, names);
    vlog(`character order -> ${names.join(', ')}`);
    refresh();
}

/** Undo every tracked/edited change recorded for one message+swipe. */
function onRevertTurn(mesId, swipeId) {
    const st = getState();
    if (!st) return;
    const recs = (st.history || [])
        .filter((r) => r.mesId === mesId && (swipeId == null || r.swipeId === swipeId) && r.trigger !== 'revert-turn')
        .sort((a, b) => b.ts - a.ts); // newest first — unwind in reverse order
    if (!recs.length) { toastr.info('WorldTracker: nothing to revert on this message.'); return; }
    const inverse = [];
    for (const r of recs) {
        for (let i = (r.changes || []).length - 1; i >= 0; i--) {
            const ch = r.changes[i];
            if (ch.kind === 'new-character') {
                if (ch.rawAfter?.name) state.removeCharacter(st, ch.rawAfter.name);
                inverse.push({ path: ch.path, label: ch.label, kind: 'field', before: ch.after, after: '—', rawBefore: ch.rawAfter, rawAfter: null });
                continue;
            }
            state.applyChange(st, { ...ch, rawAfter: ch.rawBefore, afterIso: ch.beforeIso });
            inverse.push({
                path: ch.path, label: ch.label, kind: ch.kind,
                before: ch.after, after: ch.before, rawBefore: ch.rawAfter, rawAfter: ch.rawBefore,
                beforeIso: ch.afterIso, afterIso: ch.beforeIso,
            });
        }
    }
    state.pushHistory(st, { mesId, swipeId, trigger: 'revert-turn', changes: inverse });
    log(`revert turn @${mesId}#${swipeId ?? '-'}: ${inverse.length} change(s) undone`);
    refresh();
}

/** Human-readable [World State] summary as it stood right after `mesId`'s turn. */
function getStateAsOf(mesId) {
    const st = getState();
    if (!st) return '';
    const sec = settings.sections || {};
    // Pre-query snapshot of THIS message + this swipe's own tracker changes
    // replayed on top = the state as it stood once the turn was applied.
    const base = state.peekSnapshot(st, mesId);
    if (!base) return buildSummary(st, sec);
    const sid = swipeIdOf(mesId);
    const recs = (st.history || [])
        .filter((r) => r.mesId === mesId && (r.swipeId == null || r.swipeId === sid))
        .sort((a, b) => a.ts - b.ts);
    for (const r of recs) for (const ch of r.changes || []) state.applyChange(base, ch, settings.schema);
    return buildSummary(base, sec);
}

/**
 * Track every chat participant in one go. Group members (or the solo chat's
 * character) minus the narrator — but only when a narrator IS set; "(any turn)"
 * (empty narratorName) means track everyone.
 */
function onAddParticipants() {
    const st = getState();
    if (!st) { toastr.warning('WorldTracker: no active chat.'); return; }
    const c = SillyTavern.getContext();
    const members = groupMemberNames();
    const pool = members.length ? members : [c.name2].filter(Boolean);
    const narrator = settings.narratorName || '';
    let added = 0;
    for (const name of pool) {
        if (!name || name === narrator || st.characters[name]) continue;
        state.ensureCharacter(st, name, settings.schema, { auto: true });
        added++;
    }
    log(`add participants: +${added} (pool ${pool.length}${narrator ? `, narrator "${narrator}" skipped` : ''})`);
    if (added) toastr.success(`WorldTracker: now tracking ${added} more character(s).`);
    else toastr.info('WorldTracker: no new participants to add.');
    refresh();
}

/**
 * Route fresh proposals: auto-approved ones apply now, the rest go to the
 * pending queue (shown in the panel + as an inline card on the message).
 */
function ingestProposals(st, proposals) {
    if (!proposals.length) {
        toastr.info('WorldTracker: no changes.');
        refresh();
        return;
    }
    const auto = new Set(settings.autoApproveFields || []);
    const appliedChanges = [];
    let firstSrc = null;
    let applied = 0;
    let queued = 0;
    for (const p of proposals) {
        if (settings.autoApprove || auto.has(p.path)) {
            const ch = applyProposal(st, p, settings.schema);
            if (ch) appliedChanges.push(ch);
            if (firstSrc == null && Number.isInteger(p.sourceMessageId)) firstSrc = p.sourceMessageId;
            applied++;
        } else {
            state.addPending(st, p);
            queued++;
        }
    }
    if (appliedChanges.length) {
        state.pushHistory(st, {
            mesId: firstSrc, swipeId: firstSrc != null ? swipeIdOf(firstSrc) : null,
            trigger: 'tracker', changes: appliedChanges,
        });
    }
    log(`proposals: ${applied} auto-applied, ${queued} queued`);
    if (applied && !queued) toastr.success(`WorldTracker: applied ${applied} change(s).`);
    else if (queued) toastr.info(`WorldTracker: ${queued} change(s) to review${applied ? ` (${applied} auto-applied)` : ''}.`);
    refresh();
}

function onApprove(id) {
    const st = getState();
    if (!st) return;
    const p = st.pending.find((x) => x.id === id);
    if (!p) return;
    const ch = applyProposal(st, p, settings.schema);
    state.removePending(st, id);
    if (ch) {
        state.pushHistory(st, {
            mesId: p.sourceMessageId, swipeId: Number.isInteger(p.sourceMessageId) ? swipeIdOf(p.sourceMessageId) : null,
            trigger: 'tracker', changes: [ch],
        });
    }
    log('approved', p.path);
    refresh();
}

/** Clock only: advance by the user's expected interval instead of the model's. */
function onApproveExpected(id) {
    const st = getState();
    if (!st) return;
    const p = st.pending.find((x) => x.id === id);
    if (!p || p.kind !== 'clock') return;
    const exp = st.clock.expectedInterval || {};
    if (clockUtil.deltaToSeconds(exp) > 0) {
        const beforeIso = st.clock.iso;
        st.clock.iso = clockUtil.addElapsed(st.clock.iso, exp);
        state.save();
        state.pushHistory(st, {
            mesId: p.sourceMessageId, swipeId: Number.isInteger(p.sourceMessageId) ? swipeIdOf(p.sourceMessageId) : null,
            trigger: 'tracker', changes: [{
                path: 'clock', label: 'Time', kind: 'clock',
                before: clockUtil.format(beforeIso, st.clock.displayFormat),
                after: clockUtil.format(st.clock.iso, st.clock.displayFormat),
                beforeIso, afterIso: st.clock.iso, rawBefore: beforeIso, rawAfter: st.clock.iso,
            }],
        });
        log('clock: applied expected interval instead', exp);
    }
    state.removePending(st, id);
    refresh();
}

function onDecline(id) {
    const st = getState();
    if (!st) return;
    const p = st.pending.find((x) => x.id === id);
    state.removePending(st, id);
    if (p) log('declined', p.path);
    refresh();
}

function onApproveAll() {
    const st = getState();
    if (!st) return;
    const changes = [];
    let firstSrc = null;
    for (const p of [...st.pending]) {
        const ch = applyProposal(st, p, settings.schema);
        if (ch) changes.push(ch);
        if (firstSrc == null && Number.isInteger(p.sourceMessageId)) firstSrc = p.sourceMessageId;
    }
    state.clearPending(st);
    if (changes.length) {
        state.pushHistory(st, {
            mesId: firstSrc, swipeId: firstSrc != null ? swipeIdOf(firstSrc) : null,
            trigger: 'tracker', changes,
        });
    }
    log('approved all');
    refresh();
}

function onDeclineAll() {
    const st = getState();
    if (!st) return;
    state.clearPending(st);
    log('declined all');
    refresh();
}

/** Re-apply the live settings.schema to the current chat and refresh the UI. */
function applyGearSettings() {
    const st = getState();
    if (st) state.applySchema(st, settings.schema);
    log('gear settings applied:', settings.schema.world.length, 'world,', settings.schema.userStats.length, 'stats,',
        (settings.schema.character?.fields || []).length, 'char fields; sections', JSON.stringify(settings.sections),
        'narrator', settings.narratorName || '(any)');
    refresh();
}

function onOpenSettings() {
    openSettingsModal(ctx, settings, applyGearSettings).catch((e) => { log('settings modal error', e); });
}

// ---------------------------------------------------------------------------
// Settings drawer (Extensions tab)
// ---------------------------------------------------------------------------

function buildSettingsDrawer() {
    const html = `
        <div id="wt-settings-drawer" class="inline-drawer wt-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-compass"></i> WorldTracker</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-enabled">
                    <span>Enable WorldTracker</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-show-locks">
                    <span>Show lock icons</span>
                </label>
                <div class="wt-setting-row">
                    <label for="wt-profile">Connection profile</label>
                    <select id="wt-profile" class="text_pole"></select>
                    <small class="notes">Which connection the tracker query uses. "Main API (fallback)" reuses the chat's model via generateRaw.</small>
                </div>
                <div class="wt-setting-row">
                    <label for="wt-auto-mode">Auto-update</label>
                    <select id="wt-auto-mode" class="text_pole">
                        <option value="off">Off (manual only)</option>
                        <option value="ai">After AI messages</option>
                        <option value="user">After my messages</option>
                        <option value="both">After every message</option>
                    </select>
                    <small class="notes">Fires a tracker update automatically after a rendered message (debounced, skipped while generating).</small>
                </div>
                <div class="wt-setting-row">
                    <label for="wt-ctx-msgs">Messages of context</label>
                    <input type="number" id="wt-ctx-msgs" class="text_pole" min="1" max="40">
                </div>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-inject">
                    <span>Feed tracked state to the roleplay model</span>
                </label>
                <div class="wt-setting-row">
                    <label for="wt-inject-depth">Injection depth</label>
                    <input type="number" id="wt-inject-depth" class="text_pole" min="0" max="20">
                    <small class="notes">How deep in the chat the [World State] block is inserted (0 = most recent).</small>
                </div>
                <div class="wt-setting-row">
                    <label for="wt-answer-tok">Answer token budget</label>
                    <input type="number" id="wt-answer-tok" class="text_pole" min="128" max="8192" step="128">
                    <label for="wt-think-tok">Extra think budget</label>
                    <input type="number" id="wt-think-tok" class="text_pole" min="0" max="16384" step="256">
                    <small class="notes">Request max_tokens = answer + think. The extra think budget keeps a reasoning model from being cut off before it writes the JSON.</small>
                </div>
                <div class="wt-setting-row">
                    <label for="wt-effort">Reasoning effort</label>
                    <select id="wt-effort" class="text_pole">
                        <option value="">Model default</option>
                        <option value="minimal">Minimal</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                    </select>
                    <small class="notes">Sent as reasoning_effort. "Low" is usually plenty for extraction and much faster.</small>
                </div>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-track-player">
                    <span>Track my character (remembers your appearance &amp; conditions)</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-auto-approve">
                    <span>Auto-approve all changes (skip review)</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-structured">
                    <span>Request structured JSON output (json_schema)</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-debug">
                    <span>Verbose console logging</span>
                </label>
                <div class="wt-setting-row">
                    <label for="wt-sys-override">System prompt override</label>
                    <textarea id="wt-sys-override" class="text_pole wt-ta" rows="3" placeholder="(default)"></textarea>
                    <label for="wt-instr-override">Extra instruction</label>
                    <textarea id="wt-instr-override" class="text_pole wt-ta" rows="2" placeholder="(none) — appended to the query"></textarea>
                    <small class="notes">Leave blank for defaults. The query already contains the state block, constraints and recent messages.</small>
                </div>
            </div>
        </div>`;
    $('#extensions_settings2').append(html);

    const $enabled = $('#wt-enabled').prop('checked', settings.enabled);
    const $locks = $('#wt-show-locks').prop('checked', settings.showLockIcons !== false);
    const $auto = $('#wt-auto-mode').val(settings.autoMode || 'ai');
    const $approve = $('#wt-auto-approve').prop('checked', !!settings.autoApprove);
    const $ctxMsgs = $('#wt-ctx-msgs').val(Number(settings.includeLastXMessages) || 6);

    const $profile = $('#wt-profile');
    function fillProfiles() {
        const profiles = listProfiles(ctx);
        $profile.empty().append('<option value="">Main API (fallback)</option>');
        for (const p of profiles) $profile.append(`<option value="${p.id}">${$('<div>').text(p.name).html()}</option>`);
        $profile.val(settings.profileId || '');
    }
    fillProfiles();
    $profile.on('change', function () { settings.profileId = this.value; saveSettingsDebounced(); vlog('profile ->', this.value || '(main API)'); });
    $ctxMsgs.on('change', function () {
        settings.includeLastXMessages = Math.max(1, Math.min(40, Number(this.value) || 6));
        this.value = settings.includeLastXMessages;
        saveSettingsDebounced();
    });

    const $answerTok = $('#wt-answer-tok').val(Number(settings.maxResponseTokens) || 1024);
    const $thinkTok = $('#wt-think-tok').val(Number(settings.maxThinkTokens) || 0);
    const $effort = $('#wt-effort').val(settings.reasoningEffort || '');
    $answerTok.on('change', function () {
        settings.maxResponseTokens = Math.max(128, Math.min(8192, Number(this.value) || 1024));
        this.value = settings.maxResponseTokens;
        saveSettingsDebounced();
    });
    $thinkTok.on('change', function () {
        settings.maxThinkTokens = Math.max(0, Math.min(16384, Number(this.value) || 0));
        this.value = settings.maxThinkTokens;
        saveSettingsDebounced();
    });
    $effort.on('change', function () { settings.reasoningEffort = this.value; saveSettingsDebounced(); });

    const $inject = $('#wt-inject').prop('checked', settings.injectState !== false);
    const $injectDepth = $('#wt-inject-depth').val(Number(settings.injectionDepth) || 0);
    $inject.on('change', function () { settings.injectState = this.checked; saveSettingsDebounced(); refresh(); });
    $injectDepth.on('change', function () {
        settings.injectionDepth = Math.max(0, Math.min(20, Number(this.value) || 0));
        this.value = settings.injectionDepth;
        saveSettingsDebounced();
        refresh();
    });

    $enabled.on('change', function () {
        settings.enabled = this.checked;
        saveSettingsDebounced();
        refresh();
    });
    $locks.on('change', function () { settings.showLockIcons = this.checked; saveSettingsDebounced(); refresh(); });
    $auto.on('change', function () { settings.autoMode = this.value; saveSettingsDebounced(); });
    $approve.on('change', function () { settings.autoApprove = this.checked; saveSettingsDebounced(); });

    $('#wt-track-player').prop('checked', settings.trackPlayer !== false)
        .on('change', function () {
            settings.trackPlayer = this.checked;
            saveSettingsDebounced();
            if (this.checked) {
                const st = getState();
                if (st && state.ensurePlayerTracked(st, settings.schema)) state.applySchema(st, settings.schema);
            }
            refresh();
        });

    $('#wt-structured').prop('checked', settings.structuredOutput !== false)
        .on('change', function () { settings.structuredOutput = this.checked; saveSettingsDebounced(); });
    $('#wt-debug').prop('checked', !!settings.debug)
        .on('change', function () { settings.debug = this.checked; setVerbose(this.checked); saveSettingsDebounced(); });

    if (!settings.promptOverrides) settings.promptOverrides = {};
    $('#wt-sys-override').val(settings.promptOverrides.system || '')
        .on('change', function () { settings.promptOverrides.system = this.value.trim(); saveSettingsDebounced(); });
    $('#wt-instr-override').val(settings.promptOverrides.instruction || '')
        .on('change', function () { settings.promptOverrides.instruction = this.value.trim(); saveSettingsDebounced(); });
}

// ---------------------------------------------------------------------------
// Slash commands (temporary helpers until the request flow lands)
// ---------------------------------------------------------------------------

function registerSlashCommands() {
  try {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser || !SlashCommand || !SlashCommandArgument || !ARGUMENT_TYPE) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wt-char',
        helpString: 'WorldTracker: manage tracked characters. /wt-char add|remove (name), /wt-char rename (old) (new), or /wt-char sync to track every chat participant.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'add|remove|rename|sync', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            SlashCommandArgument.fromProps({ description: 'character name(s) (not needed for sync)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: (_args, value) => {
            const parts = String(value).trim().split(/\s+/);
            const op = parts.shift();
            const st = getState();
            if (!st) return '';
            if (op === 'sync' || op === 'all') { onAddParticipants(); return ''; }
            if (op === 'rename') {
                const newName = parts.pop();
                const oldName = parts.join(' ');
                if (oldName && newName) renameCharacter(oldName, newName);
                return '';
            }
            const name = parts.join(' ');
            if (!name) return '';
            if (op === 'add') state.ensureCharacter(st, name, settings.schema);
            else if (op === 'remove') state.removeCharacter(st, name);
            vlog(`/wt-char ${op} ${name} -> now tracking ${Object.keys(st.characters).length}`);
            refresh();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wt-track',
        helpString: 'WorldTracker: run a tracker update now.',
        callback: () => { onManualUpdate(); return ''; },
    }));
  } catch (err) {
    console.warn(`[${MODULE_NAME}] slash command registration failed`, err);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

jQuery(async () => {
    settings = loadSettings(extensionSettings);
    setVerbose(!!settings.debug);
    profiles.ensureProfiles(settings);
    state.init();

    initPanel({ context: ctx, settings, getState, handlers: {
        onEdit, onToggleLock, onToggleExpand, onModeChange, onManualUpdate,
        onUpdateButton, onSetUpdater, onRemoveCharacter, onApprove, onApproveExpected,
        onDecline, onApproveAll, onDeclineAll, onOpenSettings, onPersistLayout, onDockSide, onCollapse, onToggleNpc,
        onToggleFieldGroup, onSetPresent, onAddParticipants, onReorderCharacters,
        onRevertTurn, getStateAsOf, onSetRel, onToggleRels, onRenameCharacter,
        fieldHistory: (path) => { const s = getState(); return s ? state.fieldHistory(s, path) : []; },
    } });

    buildSettingsDrawer();
    registerSlashCommands();

    // Clicking into the chat input rolls the expanded banner sheet back up, so
    // it doesn't sit over the conversation while you type.
    $(document).on('pointerdown', '#send_textarea', () => {
        if (settings.enabled && settings.bannerExpanded && (settings.uiMode || 'banner') === 'banner') {
            onToggleExpand(false);
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        let id;
        try { id = ctx.getCurrentChatId?.(); } catch { /* ignore */ }
        vlog(`chat changed -> ${id ?? '(none)'}`);
        stopUpdate('chat-changed'); // don't apply another chat's tracker result here

        // Auto-apply a profile bound to this chat/group, else the default one.
        try {
            const want = profiles.resolveForChat(settings, ctx);
            if (want && want !== settings.profiles.activeId) {
                profiles.setActive(settings, want);
                profiles.applyData(settings, profiles.active(settings).data);
                saveSettingsDebounced();
                vlog(`profile -> "${profiles.active(settings)?.name}" for this chat`);
            }
        } catch (e) { vlog('profile resolve failed', e); }

        state.get(settings.schema); // seed/reconcile for the new chat
        const st = getState();
        if (st) {
            // Persona changed since this card was made? Carry its data over by
            // renaming, so a swap (even on message 0) doesn't leave a stale card.
            if (settings.trackPlayer && state.syncPersonaCard(st, settings.schema)) log('persona card renamed to match');
            const keep = new Set([ctx.name1, ctx.name2, ...groupMemberNames()].filter(Boolean));
            const pruned = state.pruneAutoCards(st, keep, settings.schema);
            if (pruned) vlog(`pruned ${pruned} untouched auto card(s)`);
            if (settings.enabled && settings.trackPlayer) state.ensurePlayerTracked(st, settings.schema);
            state.applySchema(st, settings.schema);
        }
        refresh();
    });
    // Group membership changed -> the "By <name>" / narrator lists depend on it.
    if (event_types.GROUP_UPDATED) eventSource.on(event_types.GROUP_UPDATED, () => refresh());

    // --- auto-update after messages ---
    let genActive = false;
    let autoTimer = null;
    const autoUpdate = (why, sourceMessageId) => {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            if (!settings.enabled || genActive || updateJob) {
                vlog(`auto-update skipped (${why}): enabled=${settings.enabled} genActive=${genActive} inFlight=${!!updateJob}`);
                return;
            }
            if (!getState()) return;
            log(`auto-update firing (${why})`);
            onManualUpdate(Number.isInteger(sourceMessageId) ? { sourceMessageId } : {});
        }, Math.max(200, Number(settings.debounceMs) || 1200));
    };
    // Ignore dry-run generations (prompt itemization fires GENERATION_STARTED
    // with dryRun=true and no matching GENERATION_ENDED).
    eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) genActive = true; });
    eventSource.on(event_types.GENERATION_ENDED, () => { genActive = false; });
    eventSource.on(event_types.GENERATION_STOPPED, () => { genActive = false; });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        if (['ai', 'both'].includes(settings.autoMode)) autoUpdate('ai message', id);
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
        if (['user', 'both'].includes(settings.autoMode)) autoUpdate('user message', id);
    });

    // --- delete safety: revert to the pre-query snapshot ---
    // MESSAGE_DELETED gives the post-splice chat.length — the truncation point.
    const onRevert = (rawId, why) => {
        const id = Number(rawId);
        vlog(`revert event: ${why}, rawId=${JSON.stringify(rawId)} -> ${id}`);
        const st = getState();
        if (!st || !Number.isFinite(id)) { vlog('revert: no state or bad id'); return; }
        stopUpdate('revert');
        const r = state.restoreFrom(st, id);
        log(`revert @${id} (${why}): restored=${r.restored} usedKey=${r.usedKey} pruned=${r.prunedPending} pending`);
        refresh();
    };

    // --- swipe safety ---
    // MESSAGE_SWIPED fires both when a NEW swipe is about to generate (empty
    // slot) and when cycling to an existing one. Either way: rebuild canonical
    // state from that swipe's own history replayed onto the pre-query snapshot.
    // For an empty new swipe there are no records yet, so this lands exactly on
    // the pre-query state — a clean slate for the incoming generation. It never
    // prunes, so sibling swipes' tracker passes survive the flip.
    const onSwiped = (rawId) => {
        const mesId = Number(rawId);
        const st = getState();
        if (!st || !Number.isFinite(mesId)) return;
        const m = SillyTavern.getContext().chat?.[mesId];
        const sid = m?.swipe_id ?? 0;
        // Untracked message -> swiping it must not touch tracked state.
        const tracked = (st.snapshots && (mesId in st.snapshots))
            || (st.history || []).some((r) => r.mesId === mesId);
        if (!tracked) { vlog(`swipe @${mesId}: untracked, ignoring`); return; }
        stopUpdate('swiped');
        const ok = state.restoreToSwipe(st, mesId, sid, settings.schema);
        log(`swipe @${mesId} -> #${sid}: rebuilt=${ok}`);
        refresh();
    };

    const onSwipeDeleted = (o) => {
        const st = getState();
        const mesId = Number(o?.messageId);
        const delSwipe = Number(o?.swipeId);
        const newSwipe = Number(o?.newSwipeId);
        if (!st || !Number.isFinite(mesId)) return;
        stopUpdate('swipe-deleted');
        if (Array.isArray(st.history)) {
            st.history = st.history.filter((r) => !(r.mesId === mesId && r.swipeId === delSwipe));
            for (const r of st.history) {
                if (r.mesId === mesId && Number.isInteger(r.swipeId) && r.swipeId > delSwipe) r.swipeId--;
            }
        }
        const m = SillyTavern.getContext().chat?.[mesId];
        const target = Number.isFinite(newSwipe) ? newSwipe : (m?.swipe_id ?? 0);
        state.restoreToSwipe(st, mesId, target, settings.schema);
        state.save();
        log(`swipe-deleted @${mesId} #${delSwipe} -> #${target}`);
        refresh();
    };

    eventSource.on(event_types.MESSAGE_SWIPED, (id) => onSwiped(id));
    eventSource.on(event_types.MESSAGE_DELETED, (id) => onRevert(id, 'deleted'));
    if (event_types.MESSAGE_SWIPE_DELETED) {
        eventSource.on(event_types.MESSAGE_SWIPE_DELETED, (o) => onSwipeDeleted(o));
    }

    // The chat layout (#sheld) and sibling extensions like TopInfoBar may not be
    // in the DOM yet when we boot. Re-place the banner once things settle.
    if (event_types.APP_READY) eventSource.once(event_types.APP_READY, () => replaceBanner());
    setTimeout(() => replaceBanner(), 1500);

    // A chat may already be open at boot (no CHAT_CHANGED fires for it).
    // Don't prune auto cards here — group/context isn't reliably loaded yet, so
    // keepNames would be wrong. The first CHAT_CHANGED handles it with real context.
    try {
        const st0 = getState();
        if (st0 && settings.enabled && settings.trackPlayer) {
            state.syncPersonaCard(st0, settings.schema);
            if (state.ensurePlayerTracked(st0, settings.schema)) state.applySchema(st0, settings.schema);
        }
    } catch (e) { vlog('boot ensurePlayerTracked failed', e); }

    refresh();
    log('loaded');
});
