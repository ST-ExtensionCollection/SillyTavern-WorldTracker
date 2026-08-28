// WorldTracker — separate-request world-state tracker with field locking and an
// approve/decline gate. Entry point.

import { loadSettings, MODULE_NAME } from './src/settings.js';
import * as state from './src/state.js';
import * as clockUtil from './src/clock.js';
import { log } from './src/log.js';
import { buildTrackerPrompt } from './src/prompt.js';
import { parseTrackerResponse } from './src/parse.js';
import { runTrackerRequest, listProfiles } from './src/request.js';
import { diffToProposals, applyProposal } from './src/merge.js';
import { updateInjection } from './src/inject.js';
import { initPanel, renderPanel, replaceBanner, setBusy } from './src/ui/panel.js';

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

function onEdit(path, val) {
    const st = getState();
    if (!st) return;
    if (path === 'clock' && val && typeof val === 'object') {
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
        log(`clock ->`, st.clock.iso, val.__expected ? `(expected ${JSON.stringify(st.clock.expectedInterval)})` : '');
        refresh();
        return;
    }
    state.applyValue(st, path, val, null);
    log(`edit ${path} ->`, val);
    refresh();
}

function onToggleLock(path, locked) {
    const st = getState();
    if (!st) return;
    state.setLock(st, path, locked);
    log(`${locked ? 'lock' : 'unlock'} ${path}`);
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

async function onManualUpdate() {
    const st = getState();
    if (!st) { toastr.warning('WorldTracker: no active chat.'); return; }

    if (updateJob) {
        updateJob.superseded = true;
        try { updateJob.controller.abort(); } catch { /* ignore */ }
    }

    const c = SillyTavern.getContext();
    const n = Math.max(1, Number(settings.includeLastXMessages) || 6);
    const recent = (c.chat || []).slice(-n).map((m) => ({ name: m.name, is_user: !!m.is_user, mes: m.mes }));
    const { messages } = buildTrackerPrompt(st, recent, { settings, playerName: c.name1 });

    const job = { controller: new AbortController(), superseded: false };
    updateJob = job;
    setBusy(true);
    log(`tracker request: ${recent.length} msg(s), ${messages.reduce((a, m) => a + m.content.length, 0)} chars`);

    try {
        const text = await runTrackerRequest(messages, settings, c, job.controller.signal);
        if (job.superseded) { log('response ignored (superseded)'); return; }
        log('tracker response (first 500):', String(text || '').slice(0, 500));
        const res = parseTrackerResponse(text);
        if (!res.ok) {
            log('parse FAILED. data:', res.data, 'raw:', res.raw);
            toastr.warning('WorldTracker: could not parse tracker response (see console).');
            return;
        }
        log('parsed tracker data:', res.data);
        const srcId = Math.max(0, (c.chat?.length ?? 1) - 1);
        ingestProposals(st, diffToProposals(st, res.data, { sourceMessageId: srcId }));
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
    let applied = 0;
    let queued = 0;
    for (const p of proposals) {
        if (settings.autoApprove || auto.has(p.path)) {
            applyProposal(st, p, settings.schema);
            applied++;
        } else {
            state.addPending(st, p);
            queued++;
        }
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
    applyProposal(st, p, settings.schema);
    state.removePending(st, id);
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
        st.clock.iso = clockUtil.addElapsed(st.clock.iso, exp);
        state.save();
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
    for (const p of [...st.pending]) applyProposal(st, p, settings.schema);
    state.clearPending(st);
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

function onOpenSettings() {
    // Full in-panel settings modal comes later. For now, open the Extensions
    // tab and expand our drawer.
    const $wand = $('#extensions-settings-button, #sys-settings-button').first();
    const $drawerContent = $('#wt-settings-drawer .inline-drawer-content');
    const $toggle = $('#wt-settings-drawer .inline-drawer-toggle');
    if ($drawerContent.length && !$drawerContent.is(':visible')) $toggle.trigger('click');
    if ($toggle.length) $toggle[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    else toastr.info('WorldTracker settings live in the Extensions tab for now.');
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
                    <input type="checkbox" id="wt-auto-approve">
                    <span>Auto-approve all changes (skip review)</span>
                </label>
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
    $profile.on('change', function () { settings.profileId = this.value; saveSettingsDebounced(); log('profile ->', this.value || '(main API)'); });
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
        helpString: 'WorldTracker: add or remove a tracked character. /wt-char add|remove (name)',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'add|remove', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            SlashCommandArgument.fromProps({ description: 'character name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        callback: (_args, value) => {
            const parts = String(value).trim().split(/\s+/);
            const op = parts.shift();
            const name = parts.join(' ');
            const st = getState();
            if (!st || !name) return '';
            if (op === 'add') state.ensureCharacter(st, name, settings.schema);
            else if (op === 'remove') state.removeCharacter(st, name);
            log(`/wt-char ${op} ${name} -> now tracking ${Object.keys(st.characters).length}`);
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
    state.init();

    initPanel({ context: ctx, settings, getState, handlers: {
        onEdit, onToggleLock, onToggleExpand, onModeChange, onManualUpdate,
        onUpdateButton, onSetUpdater, onRemoveCharacter, onApprove, onApproveExpected,
        onDecline, onApproveAll, onDeclineAll, onOpenSettings,
    } });

    buildSettingsDrawer();
    registerSlashCommands();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        let id;
        try { id = ctx.getCurrentChatId?.(); } catch { /* ignore */ }
        log(`chat changed -> ${id ?? '(none)'}`);
        stopUpdate('chat-changed'); // don't apply another chat's tracker result here
        state.get(settings.schema); // seed/reconcile for the new chat
        refresh();
    });

    // --- auto-update after messages ---
    let genActive = false;
    let autoTimer = null;
    const autoUpdate = (why) => {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            if (!settings.enabled || genActive || updateJob) {
                log(`auto-update skipped (${why}): enabled=${settings.enabled} genActive=${genActive} inFlight=${!!updateJob}`);
                return;
            }
            if (!getState()) return;
            log(`auto-update firing (${why})`);
            onManualUpdate();
        }, Math.max(200, Number(settings.debounceMs) || 1200));
    };
    // Ignore dry-run generations (prompt itemization fires GENERATION_STARTED
    // with dryRun=true and no matching GENERATION_ENDED).
    eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) genActive = true; });
    eventSource.on(event_types.GENERATION_ENDED, () => { genActive = false; });
    eventSource.on(event_types.GENERATION_STOPPED, () => { genActive = false; });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        log(`CHARACTER_MESSAGE_RENDERED id=${id} autoMode=${settings.autoMode}`);
        if (['ai', 'both'].includes(settings.autoMode)) autoUpdate('ai message');
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
        if (['user', 'both'].includes(settings.autoMode)) autoUpdate('user message');
    });

    // The chat layout (#sheld) and sibling extensions like TopInfoBar may not be
    // in the DOM yet when we boot. Re-place the banner once things settle.
    if (event_types.APP_READY) eventSource.once(event_types.APP_READY, () => replaceBanner());
    setTimeout(() => replaceBanner(), 1500);

    refresh();
    log('loaded');
});
