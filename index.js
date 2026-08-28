// WorldTracker — separate-request world-state tracker with field locking and an
// approve/decline gate. Entry point.

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { loadSettings, MODULE_NAME } from './src/settings.js';
import * as state from './src/state.js';
import * as clockUtil from './src/clock.js';
import { initPanel, renderPanel, destroyPanel } from './src/ui/panel.js';

const ctx = SillyTavern.getContext();
const {
    eventSource,
    event_types,
    saveSettingsDebounced,
} = ctx;

// Ensure state.js has a reliable metadata-save fn even if the context object
// doesn't forward one.
if (typeof ctx.saveMetadataDebounced !== 'function') ctx.saveMetadataDebounced = saveMetadataDebounced;

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
    if (path === 'clock' && val && typeof val === 'object' && val.__elapsed) {
        const newIso = clockUtil.addElapsed(st.clock.iso, val.__elapsed);
        st.clock.iso = newIso;
        state.save();
        refresh();
        return;
    }
    state.applyValue(st, path, val, null);
    refresh();
}

function onToggleLock(path, locked) {
    const st = getState();
    if (!st) return;
    state.setLock(st, path, locked);
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

function onManualUpdate() {
    // Wired in milestone 4 (request + parse).
    toastr.info('WorldTracker: manual update not wired yet.');
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
    // Full settings modal comes later; for now jump to the drawer.
    const $drawer = $('#wt-settings-drawer .inline-drawer-toggle');
    if ($drawer.length) $drawer[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
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
                    <label for="wt-auto-mode">Auto-update</label>
                    <select id="wt-auto-mode" class="text_pole">
                        <option value="off">Off (manual only)</option>
                        <option value="ai">After AI messages</option>
                        <option value="user">After my messages</option>
                        <option value="both">After every message</option>
                    </select>
                </div>
                <label class="checkbox_label">
                    <input type="checkbox" id="wt-auto-approve">
                    <span>Auto-approve all changes (skip review)</span>
                </label>
                <small class="notes">Connection profile, prompt overrides and per-field options land in the panel's settings button (coming soon).</small>
            </div>
        </div>`;
    $('#extensions_settings2').append(html);

    const $enabled = $('#wt-enabled').prop('checked', settings.enabled);
    const $locks = $('#wt-show-locks').prop('checked', settings.showLockIcons !== false);
    const $auto = $('#wt-auto-mode').val(settings.autoMode || 'ai');
    const $approve = $('#wt-auto-approve').prop('checked', !!settings.autoApprove);

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
    settings = loadSettings(extension_settings);
    state.init(ctx);

    initPanel({ context: ctx, settings, getState, handlers: {
        onEdit, onToggleLock, onToggleExpand, onModeChange, onManualUpdate,
        onSetUpdater, onRemoveCharacter, onApprove, onDecline, onApproveAll,
        onDeclineAll, onOpenSettings,
    } });

    buildSettingsDrawer();
    registerSlashCommands();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        state.get(settings.schema); // seed/reconcile for the new chat
        refresh();
    });

    refresh();
    console.log(`[${MODULE_NAME}] loaded`);
});
