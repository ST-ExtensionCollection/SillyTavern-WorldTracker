// WorldTracker — global settings (extension_settings.WorldTracker).
//
// Everything here is GLOBAL (shared by every chat): connection/profile choice,
// UI mode + geometry, approval behaviour, and the field SCHEMA used to seed new
// chats. Per-chat data (field values, per-field locks, pending changes) lives in
// chat_metadata — see state.js.

import { defaultSchema } from './schema.js';

export const MODULE_NAME = 'WorldTracker';
export const FORMAT_VERSION = 1;

function defaultSettings() {
    return {
        formatVersion: FORMAT_VERSION,
        enabled: true,

        // --- request ---
        profileId: '',              // Connection Manager profile id; '' => fall back to generateRaw
        autoMode: 'ai',             // 'off' | 'ai' | 'user' | 'both'
        debounceMs: 1200,
        includeLastXMessages: 6,
        maxResponseTokens: 2048,

        // --- approval ---
        autoApprove: false,
        autoApproveFields: [],      // array of field paths always applied without review

        // --- ui ---
        uiMode: 'banner',           // 'banner' | 'float' | 'dock'
        bannerExpanded: false,
        floatPos: { x: 80, y: 80 },
        floatSize: { w: 340, h: 420 },
        dockSide: 'right',          // 'left' | 'right'
        showLockIcons: true,

        // --- prompt ---
        promptOverrides: {},        // { system?: string, instruction?: string }

        // --- schema (seeds new chats) ---
        schema: defaultSchema(),
    };
}

/** Ensure extension_settings.WorldTracker exists and is shape-current. Returns it. */
export function loadSettings(extension_settings) {
    const existing = extension_settings[MODULE_NAME];
    if (!existing || typeof existing !== 'object') {
        extension_settings[MODULE_NAME] = defaultSettings();
        return extension_settings[MODULE_NAME];
    }
    // Shallow fill of any missing top-level keys (additive migration).
    const defaults = defaultSettings();
    for (const k of Object.keys(defaults)) {
        if (!(k in existing)) existing[k] = defaults[k];
    }
    if (!existing.schema || typeof existing.schema !== 'object') existing.schema = defaultSchema();
    existing.formatVersion = FORMAT_VERSION;
    return existing;
}
