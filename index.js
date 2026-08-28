// WorldTracker — separate-request world-state tracker with field locking and an
// approve/decline gate. Entry point.

import { loadSettings, MODULE_NAME } from './src/settings.js';
import * as state from './src/state.js';
import * as clockUtil from './src/clock.js';
import { log } from './src/log.js';
import { buildTrackerPrompt } from './src/prompt.js';
import { parseTrackerResponse } from './src/parse.js';
import { runTrackerRequest, listProfiles } from './src/request.js';
import { initPanel, renderPanel, destroyPanel, replaceBanner, setBusy } from './src/ui/panel.js';

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
        if (res.ok) {
            log('parsed tracker data:', res.data);
            toastr.success('WorldTracker: parsed OK — merge/approval is the next milestone.');
        } else {
            log('parse FAILED. data:', res.data, 'raw:', res.raw);
            toastr.warning('WorldTracker: could not parse tracker response (see console).');
        }
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

function onApprove(id) {
    const st = getState();
    if (!st) return;
    const p = st.pending.find((x) => x.id === id);
    if (!p) return;
    if (p.path === 'clock') st.clock.iso = p.toIso ?? p.to;
    else state.applyValue(st, p.path, p.rawTo ?? p.to, p.sourceMessageId);
    state.removePending(st, id);
    refresh();
}

function onDecline(id) {
    const st = getState();
    if (!st) return;
    state.removePending(st, id);
    refresh();
}

function onApproveAll() {
    const st = getState();
    if (!st) return;
    for (const p of [...st.pending]) onApprove(p.id);
}

function onDeclineAll() {
    const st = getState();
    if (!st) return;
    state.clearPending(st);
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
                    <small class="notes">Auto-update fires in a later milestone; setting is stored now.</small>
                </div>
                <div class="wt-setting-row">
                    <label for="wt-ctx-msgs">Messages of context</label>
                    <input type="number" id="wt-ctx-msgs" class="text_pole" min="1" max="40">
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

    $enabled.on('change', function () {
        settings.enabled = this.checked;
        saveSettingsDebounced();
        if (settings.enabled) refresh();
        else destroyPanel();
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
        onSetUpdater, onRemoveCharacter, onApprove, onDecline, onApproveAll,
        onDeclineAll, onOpenSettings,
    } });

    buildSettingsDrawer();
    registerSlashCommands();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        let id;
        try { id = ctx.getCurrentChatId?.(); } catch { /* ignore */ }
        log(`chat changed -> ${id ?? '(none)'}`);
        state.get(settings.schema); // seed/reconcile for the new chat
        refresh();
    });

    // The chat layout (#sheld) and sibling extensions like TopInfoBar may not be
    // in the DOM yet when we boot. Re-place the banner once things settle.
    if (event_types.APP_READY) eventSource.once(event_types.APP_READY, () => replaceBanner());
    setTimeout(() => replaceBanner(), 1500);

    refresh();
    log('loaded');
});
