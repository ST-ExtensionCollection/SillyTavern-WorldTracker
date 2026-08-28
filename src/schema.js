// WorldTracker — default field schema.
//
// The schema defines WHICH fields exist and their type / defaults. It lives in
// global settings and is only used to SEED a fresh chat's canonical state
// (see state.js). Once a chat has state, its own per-field data (values, locks)
// is authoritative; changing the schema later only affects new chats and adds
// missing fields to existing ones (never removes or overwrites).

export const FIELD_TYPES = ['text', 'number', 'enum', 'clock'];

// Relationship enum reused for character relationship fields.
export const RELATIONSHIP_OPTIONS = ['Lover', 'Partner', 'Friend', 'Ally', 'Acquaintance', 'Neutral', 'Rival', 'Enemy'];

export const UPDATER_NARRATOR = 'narrator';
export const UPDATER_SELF = 'self';

/**
 * The default schema. `world` fields are scene-level; `userStats` track the
 * player persona; `character` is the template applied to each tracked NPC.
 */
export function defaultSchema() {
    return {
        // Canonical in-world clock. Advanced by ELAPSED time reported by the
        // model, never regenerated wholesale. `displayFormat` is a
        // date-fns-style token string used purely for rendering.
        clock: {
            enabled: true,
            startIso: '2024-06-01T09:00:00',
            displayFormat: 'HH:mm — EEE, MMM d yyyy',
            lockedByDefault: false,
        },

        // Scene-level fields shown in the banner and detail sheet.
        world: [
            { key: 'location', label: 'Location', type: 'text', lockedByDefault: false, default: 'Unknown' },
            { key: 'weather', label: 'Weather', type: 'text', lockedByDefault: false, default: 'Clear' },
            { key: 'temperature', label: 'Temperature', type: 'number', unit: '°C', lockedByDefault: false, default: 20 },
        ],

        // Player persona stat bars.
        userStats: [
            { key: 'Health', label: 'Health', type: 'number', max: 100, lockedByDefault: false, default: 100 },
            { key: 'Energy', label: 'Energy', type: 'number', max: 100, lockedByDefault: false, default: 100 },
        ],

        // Per-character fields. `updater` defaults to narrator (updates every
        // turn); can be set per-character to 'self' (updates only when that
        // character authored the triggering message) or a specific name.
        character: {
            defaultUpdater: UPDATER_NARRATOR,
            fields: [
                { key: 'status', label: 'Status', type: 'text', lockedByDefault: false, default: '' },
                { key: 'location', label: 'Location', type: 'text', lockedByDefault: false, default: '' },
                { key: 'relationship', label: 'Relationship', type: 'enum', options: RELATIONSHIP_OPTIONS, lockedByDefault: false, default: 'Neutral' },
            ],
        },
    };
}
