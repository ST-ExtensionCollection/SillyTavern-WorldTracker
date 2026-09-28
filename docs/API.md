# WorldTracker — integration surface for other extensions

This file lists everything another SillyTavern extension can rely on when it
works alongside WorldTracker (WT). If something isn't listed here, it's
internal and may change without notice.

## Detecting WorldTracker

```js
globalThis.WorldTracker?.handlesRetconEvent === true
```

WT sets `globalThis.WorldTracker` at boot and merges into any existing object;
it never replaces one. Currently the only flag is `handlesRetconEvent`.

A chat that WT has touched has `chat_metadata.WorldTracker` (an object).

## Events WorldTracker listens to

### `timeline_retcon_applied` (custom)

Emit this on `eventSource` whenever you splice messages into the middle of a
chat or out of it, so WT can re-key its per-message data.

```js
await eventSource.emit('timeline_retcon_applied', {
    direction: 'merge' | 'undo',
    chatId,          // getCurrentChatId() of the chat you changed; WT ignores it for another chat
    start,           // first index touched
    removed,         // messages that were at [start, start+removed) before the splice
    inserted,        // messages now at [start, start+inserted)
    retconId,        // optional, stable id shared by a merge and its undo
});
```

- **Timing:** emit it after `chat` is spliced. Because WT awaits
  `saveMetadata()` inside the handler, `await` the emit before you reload the
  chat.
- **Remap rule:** indices `< start` stay as they are. Indices
  `>= start + removed` shift by `inserted - removed`. Indices inside the span
  are dropped. The one exception is the saved state at `start` when both
  `removed` and `inserted` are > 0: it stays, as the pre-state for the new
  first message.
- **Undo:** on `merge`, WT stashes whatever it dropped under `retconId`, in
  `chat_metadata.WorldTracker.retconStash`, keeping the 20 newest. On an `undo`
  with the same `retconId`, WT first remaps and then puts the stashed entries
  back at `start + offset`. If there's no `retconId`, the remap still works, but
  undo can't restore the dropped entries.
- WT leaves its live world state (clock, world, characters) alone during a
  retcon. It updates only the data kept per message.

### Standard ST events worth knowing about

| Event | What WT does |
|---|---|
| `MESSAGE_DELETED` | Compares the chat against the messages WT last saw to work out which range went. **Tail delete:** rolls live state back to the saved state for the first deleted message. **Mid-chat delete:** re-keys only, same as a retcon with `inserted: 0`. If WT can't work out the range, it falls back to the tail-delete behavior. |
| `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED` | May start a debounced tracker LLM request, depending on the user's auto mode. `first_message` renders are ignored. If you bulk-insert messages, don't fire these once per message. Reload with `reloadCurrentChat()` instead, which fires only `CHAT_CHANGED`. |
| `MESSAGE_SWIPED`, `MESSAGE_SWIPE_DELETED` | Rebuilds live state for the active swipe from that message's saved pre-state plus the swipe's own history. |
| `CHAT_CHANGED` | Reloads per-chat state, the profile and the narrator, and records which messages the chat holds. |

Don't emit `MESSAGE_DELETED` for a splice that also inserts messages. WT would
read it as a deletion. Use `timeline_retcon_applied` instead.

## Per-chat data: `chat_metadata.WorldTracker`

This is readable, but treat it as **read-only**. Everything under `snapshots`,
`history` and `pending` is keyed by message index. If you change message
positions, tell WT with `timeline_retcon_applied` instead of editing these
yourself.

```
{
  clock:      { iso, displayFormat, locked, expectedInterval, intervalPresets },
  world:      { <key>: { value, type, unit?, group?, locked, lastChangedBy } },
  userStats:  { <key>: { value, type, max?, group?, locked, lastChangedBy } },
  characters: { <name>: { updater, fields: { <key>: { value, type, options?, locked, lastChangedBy } }, rels, isPersona? } },
  pending:    [ { id, path, label, from, to, reason, sourceMessageId, ts } ],
  history:    [ { id, mesId, swipeId, ts, trigger, changes: [...] } ],
  snapshots:  { <mesId>: { kf: true, data } | { base: <mesId>, patch } },   // state before each message; deltas chain back to a keyframe
  retconStash:{ <retconId>: { ts, dropped } },                              // only present after a merge
  settings:   { discoverNpcs, npcBlacklist, requireRecentMention },
  _v: 2
}
```

- `snapshots` values may be deltas. Don't read `data` directly; use `/wt-get`
  for live values.
- **Field paths**, used by the slash commands and in `pending[].path`:
  `clock`, `world.<key>`, `userStats.<key>`, `characters.<name>.fields.<key>`.

## Slash commands (STscript)

| Command | Effect |
|---|---|
| `/wt-get <path>` | Returns the live value, or `''` if there's no such field. For `clock`, returns the ISO timestamp. |
| `/wt-set <path> <value>` | Sets a field as a user edit, which is recorded in history. Numbers are coerced. |
| `/wt-track` | Runs a tracker update now. |
| `/wt-char add\|remove <name>`, `/wt-char rename <old> <new>`, `/wt-char sync` | Manages tracked characters. |

## Prompt injection

WT injects the live state via
`setExtensionPrompt('worldtracker-state', text, IN_CHAT, depth, false, SYSTEM)`.
The text starts with `[World State]`. Another extension can find or override
the injection by that key.
