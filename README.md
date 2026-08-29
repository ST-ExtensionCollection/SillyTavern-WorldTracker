# WorldTracker

A SillyTavern extension that tracks the state of your roleplay — time, place,
weather, your stats, the characters around you — and keeps it consistent.

It asks a model (in a **separate request**, so it never slows your chat) what
changed after each message, shows you the proposed changes, and **nothing is
applied until you approve it**. Fields you lock never change. Time advances by
*elapsed duration* instead of being re‑invented every turn.

It grew out of three existing extensions:

| From | What WorldTracker takes | What it fixes |
|---|---|---|
| **RPG Companion** | rich typed fields, per‑field locking, per‑character tracking, narrator concept | locking is *enforced* (locked fields aren't even offered to the model); the panel doesn't eat the group‑control gutter |
| **WTracker** | separate async request, results attached per‑message | tolerant parsing (no more discarded updates), field locking, an approve/decline gate, no wholesale overwrite |
| **Story Mode** | draggable floating panel | adds real resize, a banner mode, and a narrow‑screen fallback |

---

## Install

Third‑party extension. Copy the `WorldTracker/` folder into
`SillyTavern/data/<user>/extensions/` (or install from the extension manager
with the repo URL), then reload SillyTavern. It shows up in **Extensions →
WorldTracker**.

No build step — it's plain ES modules + the jQuery SillyTavern already ships.

---

## Quick start

1. **Extensions → WorldTracker**: pick a **Connection profile** for the tracker
   query. "Main API (fallback)" reuses your chat model, but a small/cheap
   profile is better — the query is short and frequent. Set **Auto‑update** to
   *After AI messages* if you want it to run on its own.
2. Open a chat. A compact **banner** appears (inside the Chat Top Bar if you
   have that extension, otherwise as its own row above the chat).
3. Send a couple of messages, then click the **↻** button on the banner (or run
   `/wt-track`). A separate request goes out; when it returns you get a card of
   **proposed changes** on the triggering message and a review list in the
   panel.
4. **✓ / ✗** each change, or *Approve all* / *Decline all*. Approved values
   become the tracked state and (optionally) get fed back into your chat so the
   model stays consistent.
5. Click a field to hand‑edit it. Click the **padlock** to lock it — locked
   fields are never proposed for change and aren't sent to the model as
   editable.

---

## Concepts

### The panel — banner / float / dock

Switch modes from the panel's mode dropdown.

- **Banner** (default): a thin strip of chips. Docks *inside* the Chat Top Bar
  when that extension is present so it looks native; otherwise it's its own row
  above the chat. Click the chevron for the full detail sheet.
- **Float**: a draggable, resizable window. Drag the header, resize from the
  bottom‑right grip; position and size are remembered.
- **Dock**: a side rail (left or right, with a flip button). Collapses to a thin
  edge.

Float and dock fall back to the banner on narrow screens (≤ 1000 px). The panel
is hidden entirely when no chat is open, and sits below SillyTavern's nav
drawers — opening the Extensions panel etc. covers it.

### Locking

Every field has a padlock. A locked field:

- is presented to the model as *"CURRENT (do not change)"* — it isn't offered as
  editable;
- is skipped when diffing the response, so it can never enter the review queue.

Locks are **per chat** (stored in that chat's metadata).

### Approve / decline

A parsed response is diffed against the current state. Each real change becomes
a *proposal*. Proposals surface in two places at once: an inline card on the
message that triggered the update, and a review list in the panel (with a
badge count). Approve applies it; decline drops it. *Auto‑approve all changes*
in settings skips the queue entirely.

### The clock

The model is **never** asked for a date/time. It's asked only *how much in‑world
time passed* (`{days, hours, minutes, seconds}`), and WorldTracker does the
arithmetic on a stored timestamp — so the year can't drift.

Editing the clock gives you three rows: **Set** (an absolute date/time picker),
**Advance** (add a duration), and **Expected next** (your guess for how long the
next reply covers). Pace presets — Fighting / Conversational / Narration /
Classes — fill the Expected fields. On a clock proposal you can hit **exp** to
advance by *your* expected interval instead of the model's number.

### Character update ownership

Each tracked character has an **updater** (dropdown on its card in the detail
sheet):

- **Narrator** (default) — updated on the narrator's turns. If no narrator
  character is set (gear dialog → *Narrator character*, default *"any turn"*),
  this means every turn.
- **Self only (\<name\>)** — updated only on a turn that character authored.
- **By \<name\>** — updated only on that named author's turns. The list is
  populated from the current group's members plus your other tracked
  characters; pick **By a custom name…** to match any author name (useful when
  the "characters" are voiced by a single narrator card rather than being real
  group members).

Out‑of‑scope characters are told *"do not report this turn"* and any proposals
for them are dropped.

### Injecting state into the chat

*Feed tracked state to the roleplay model* (on by default) inserts a compact
`[World State]` block into the prompt at a configurable depth, so the model
sees the values you've accepted.

### Sections

The **gear** button on the panel opens the schema editor:

- **Narrator character** — which group member counts as the narrator for the
  "Narrator" updater (default *"any turn"*).
- section pills — toggle **World fields**, **User stats**, **Characters** on/off.
  **User stats are off by default** (like RPG Companion); flip the pill to get
  Health/Energy back.
- add / remove / rename fields, pick a type (`text` / `number` / `enum`), set a
  unit / enum options / max. An enum's default is kept across edits as long as
  it stays a valid option.
- edit the clock display format and start time.
- reset buttons per list, plus *Restore all defaults*.

The schema is **global** (shared by every chat). Saving it re‑shapes the current
chat's data — new fields added, removed fields dropped, existing values kept.

### Swipe / regenerate / delete safety

Before each tracker query, a snapshot of the state is taken (keyed by message
index, last 40 kept). Swiping, regenerating, or deleting a message reverts the
state to the nearest earlier snapshot and prunes proposals from that message
onward — so a re‑roll doesn't compound tracker changes.

---

## Settings

**Extensions → WorldTracker** (global):

| Setting | Meaning |
|---|---|
| Connection profile | which connection the tracker query uses; blank = main API |
| Auto‑update | off / after AI / after mine / after every message |
| Messages of context | how many recent messages the query sees |
| Feed tracked state to the model + Injection depth | the `[World State]` block |
| Answer / Extra think token budget | request `max_tokens` = answer + think, so a reasoning model isn't cut off before it writes the JSON |
| Reasoning effort | sent as `reasoning_effort`; *low* is usually plenty |
| Auto‑approve all changes | skip the review queue |
| Request structured JSON output | pass a `json_schema` to the backend |
| Verbose console logging | detailed `[WorldTracker]` logs |
| System prompt override / Extra instruction | replace / append to the query prompt |

**Panel gear button**: sections + field schema + clock format (see *Sections*).

## Slash commands

- `/wt-track` — run a tracker update now.
- `/wt-char add <name>` / `/wt-char remove <name>` — start / stop tracking a
  character.

---

## How it works

```
index.js            bootstrap: settings, panel, events, slash commands,
                    auto-update timing, swipe/revert handling
src/
  settings.js       global config + schema, extension_settings.WorldTracker
  schema.js         default field definitions
  state.js          canonical per-chat state in chat_metadata; path helpers,
                    pending queue, pre-query snapshots, applySchema()
  clock.js          dependency-free parse / format / addElapsed
  prompt.js         buildTrackerPrompt(), buildResponseSchema(), inScope()
  request.js        runTrackerRequest() — Connection Manager (streamed) or
                    generateRaw fallback
  parse.js          parseTrackerResponse() — reasoning strip, brace scan,
                    repair, envelope unwrap; never throws
  merge.js          diffToProposals(), applyProposal()
  inject.js         [World State] block via setExtensionPrompt
  log.js            log() always / vlog() gated by the debug setting
  ui/
    panel.js        banner / float / dock, detail sheet, inline cards
    fields.js       one editable field row (incl. the clock editor)
    format.js       display helpers (comma-formatted numbers)
    drag.js         makeDraggable / makeResizable (pointer + touch)
    settings-modal.js  the gear-button schema editor
```

**Request → apply flow:** trigger (button / `/wt-track` / auto after a message)
→ snapshot state → build query from current state + last N messages → separate
streamed request → tolerant parse → diff vs state → proposals → your
approve/decline → apply → refresh panel + re‑inject.

**Data:** global config in `extension_settings.WorldTracker`; per‑chat state
(values, locks, pending, snapshots) in that chat's `chat_metadata.WorldTracker`.

---

## Known limitations / rough edges

Things worth fixing or at least being aware of:

1. **Mid‑chat deletes revert wrong.** `MESSAGE_DELETED` fires with the new
   `chat.length`, not the deleted index. That's only the deleted message's
   index when you delete the *last* message. Deleting a message in the middle
   restores from the wrong snapshot and doesn't prune the right proposals, and
   every later snapshot / proposal is now off by the shift. Swipe and
   last‑message delete are fine.
2. **Updates always use the last N messages.** When the triggering message
   isn't the newest (e.g. re‑rolling an older reply), the query still includes
   messages *after* it — leaking later context into a past update. Should slice
   up to the source message.
3. **No per‑swipe tracker state.** Swiping left/right between already‑generated
   swipes reverts to "before this message ran", losing whatever each swipe's
   own tracker pass produced.
4. **Schema is global.** You can't run a different field set in a sci‑fi chat
   vs a medieval one. Per‑chat or per‑character schema presets would fix this.
5. **`autoApproveFields` has no UI.** Only the all‑or‑nothing *Auto‑approve*
   toggle is exposed, though the per‑path list is honored if set by hand.
6. **Snapshots are full‑state JSON copies** (up to 40) stored in chat metadata —
   noticeable bloat on long chats with many fields/characters. Deltas or a
   smaller cap would help.
7. **Structured output is `strict: false`** with no `additionalProperties`
   constraint — some backends ignore the schema; the tolerant parser is the
   real safety net. Turn it off if a backend errors on `json_schema`.
8. **Legacy empty `intervalPresets` doesn't self‑heal.** If you ran a very
   early build and never touched the schema editor, the pace presets may be
   missing — use *Restore all defaults* in the gear dialog.
9. **`/wt-char add`** doesn't validate the name against chat participants, and
   there's no auto‑discovery of group members (the model proposing a new
   character partly covers this).
10. **Dead ternary** in `request.js` (`m.role === 'system' ? m.content :
    m.content`) — harmless, should be cleaned.
11. **No timezone handling** in `clock.js` — in‑world time is fictional so it
    doesn't matter, but adding elapsed time across a real DST boundary could
    shift an hour.

---

## Development

Pure ES modules, no bundler. Edit a file, reload SillyTavern. Turn on *Verbose
console logging* in settings for a full trace; otherwise the console shows only
milestone events (`[WorldTracker] tracker request…`, `parsed tracker data…`,
`proposals: N…`, `revert @N…`).
