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
        maxMessageChars: 1500,      // per-message cap when building the query
        maxResponseTokens: 1024,    // budget for the JSON answer itself
        maxThinkTokens: 3072,       // extra budget so a reasoning model doesn't
                                    // get cut off before it writes the JSON
        reasoningEffort: 'low',     // '' | 'minimal' | 'low' | 'medium' | 'high'
        structuredOutput: true,     // pass a json_schema to force valid JSON
        debug: false,               // verbose console logging

        // --- approval ---
        autoApprove: false,
        autoApproveFields: [],      // array of field paths always applied without review

        // --- ui ---
        uiMode: 'banner',           // 'banner' | 'float' | 'dock'
        bannerExpanded: false,
        // Which state groups are shown / tracked. User stats off by default.
        sections: { world: true, userStats: false, characters: true },
        // Auto-track the persona as its own character card (name = ctx.name1),
        // seeded from schema.player. Off => add it by hand if you want it.
        trackPlayer: true,
        // The chat's narrator character, live-resolved per chat/group from
        // narratorByChat on CHAT_CHANGED (not part of a profile). '' = any
        // turn counts as the narrator's (updater 'narrator' fires every turn).
        narratorName: '',
        narratorByChat: {},         // chatKey -> narrator character name
        floatPos: { x: 80, y: 80 },
        floatSize: { w: 340, h: 420 },
        dockSide: 'right',          // 'left' | 'right'
        panelCollapsed: false,      // roll-up for float / dock modes
        npcCollapsed: false,        // collapse the narrator-run NPC character group
        // Collapse state for schema field groups, keyed 'world:<n>' / 'stat:<n>'
        // / 'char:<n>' (fields sharing a `group` digit fold into one section).
        fieldGroupCollapsed: {},
        showLockIcons: true,
        showMessageCards: true,     // inline per-message "what changed this turn" card
        relsCollapsed: true,        // collapse the per-character Relationships block

        // --- history ---
        // (turn-history log itself lives in per-chat state, not here)

        // --- injection into the main chat ---
        injectState: true,          // feed the tracked state to the roleplay model
        injectionDepth: 1,          // IN_CHAT depth for the injection

        // --- prompt ---
        promptOverrides: {},        // { system?: string, instruction?: string }

        // --- schema (seeds new chats) ---
        schema: defaultSchema(),

        // --- named profiles (shaped by profiles.ensureProfiles) ---
        profiles: {},
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
    // The schema is user-owned (settings modal). Keep their edits; only fill a
    // missing schema or missing clock sub-keys from code.
    const ds = defaultSchema();
    if (!existing.schema || typeof existing.schema !== 'object') existing.schema = ds;
    existing.schema.clock = { ...ds.clock, ...(existing.schema.clock || {}) };
    if (!Array.isArray(existing.schema.world)) existing.schema.world = ds.world;
    if (!Array.isArray(existing.schema.userStats)) existing.schema.userStats = ds.userStats;
    if (!existing.schema.character || !Array.isArray(existing.schema.character.fields)) {
        existing.schema.character = ds.character;
    }
    if (!existing.schema.player || !Array.isArray(existing.schema.player.fields)) {
        existing.schema.player = ds.player;
    }
    if (!existing.sections || typeof existing.sections !== 'object') existing.sections = { ...defaults.sections };
    else for (const k of Object.keys(defaults.sections)) if (!(k in existing.sections)) existing.sections[k] = defaults.sections[k];
    if (!existing.promptOverrides || typeof existing.promptOverrides !== 'object') existing.promptOverrides = {};
    existing.formatVersion = FORMAT_VERSION;
    return existing;
}
