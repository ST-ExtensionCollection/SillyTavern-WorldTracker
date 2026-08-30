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
  above the chat. Click the chevron for the full detail sheet — clicking into
  the chat input rolls that sheet back up.
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

Per field, the **⚡** button on its detail‑sheet row auto‑approves just that
field from then on — handy for `clock`, `world.location`, a stat you don't want
to gate. (The list is global, so a `characters.<name>.fields.<key>` entry only
matches while a character of that name is tracked; `clock` / `world.*` /
`userStats.*` are stable.)

### The clock

The model is **never** asked for a date/time. It's asked only *how much in‑world
time passed* (`{days, hours, minutes, seconds}`), and WorldTracker does the
arithmetic on a stored timestamp — so the year can't drift.

Editing the clock gives you three rows: **Set** (an absolute date/time picker),
**Advance** (add a duration), and **Expected next** (your guess for how long the
next reply covers). Pace presets — Fighting / Conversational / Narration /
Classes — fill the Expected fields. On a clock proposal you can hit **exp** to
advance by *your* expected interval instead of the model's number. If the model
reports `0/0/0/0` elapsed (it didn't really answer), the proposal falls back to
the Expected next interval automatically and is tagged **expected**.

### Character update ownership

Each tracked character has an **updater** (dropdown on its card in the detail
sheet):

- **Narrator** (default) — updated on the narrator's turns. If no narrator
  character is set (gear dialog → *Narrator character*, default *"any turn"*),
  this means every turn.
- **Self only (\<name\>)** — updated only on a turn that character authored.
- **By \<name\>** — updated only on that named author's turns. The list is the
  current group's members plus your other tracked characters.

If your group is voiced by a single narrator card, leave characters on
**Narrator** and set the *Narrator character* — per‑cast‑member ownership isn't
possible because every message is authored by the one narrator.

New characters are only picked up from the model's output on the **narrator's**
turns (any turn if no narrator is set) — the narrator is who introduces them.

In the detail sheet, main cast (Self / By) show at the top; narrator‑run
characters are grouped under a collapsible **NPCs (N)**.

Out‑of‑scope characters are told *"do not report this turn"* and any proposals
for them are dropped.

### Your own character

The character whose name matches your **persona name** is tracked automatically
(toggle **Track my character** in the extension settings to stop that) and gets
its **own** field template — by default *Status* (conditions / injuries) plus
the *Outfit / State of dress / Appearance / Pose* group, edited under **Your
character** in the gear dialog. No *Relationship*, no *Location*.

Its card is pinned to the top of the list, tagged *you*, and has no updater
dropdown or presence toggle — the player is always writable (on **every** turn,
so the model updates *your* appearance from your own messages and the
narration) and always present. The usual *"never report the player"* prompt
line is dropped; the tracker is told to report your fields instead.

### Adding characters

- The **person‑plus** button in the Characters section header (or `/wt-char
  sync`) tracks every current chat participant at once — group members, or the
  solo character. The **Narrator character** is skipped (unless *"any turn"*);
  anyone already tracked is left alone.
- The **name box** next to it adds one character by name (`/wt-char add <name>`
  does the same). These stick — they aren't provisional like auto‑added cards.
- The model can also introduce a character on the narrator's turn.

### Presence

Each character card has an **eye** toggle. Marking a character *away* fades the
card, folds its fields, and drops it below the present characters (most recently
present first). The tracker can also set presence on its own — it's asked for a
`present` boolean per character and proposes a change when the scene shows
someone arrive or leave.

Absent characters are kept out of the injected `[World State]` block so NPCs
from other scenes don't pile up: one who has been present before shows only as
`<name> — not present`; one who never appeared is left out entirely. (The
tracker query still sees them, so they come back cleanly when they return.)

### Reordering cards

Drag a card by its **grip** (`⠿`, left of the eye toggle) to reorder it. Your
order is the sort key within each block; the player card stays pinned on top and
absent characters still sink to the bottom. Order is **per chat** (stored in
that chat's metadata) and reverts with a swipe/regenerate like any other tracked
value.

### Character relationships

Each card has a collapsible **Relationships** block: pick another tracked
character and how this one regards them (Lover / Friend / Rival / …). Entries
are shown grouped by value — `Friend: Alice, Bob`. Relationships are
**directional** (A→B is separate from B→A); tick **↔** in the add row to also
write the reverse. The tracker proposes changes when a scene clearly shifts a
bond, and relationships appear in the `[World State]` injection as
`rels: Friend→Alice,Bob; Rival→Carol`.

### Renaming & auto‑cleanup

The **pencil** on a card renames it everywhere in live state — its fields,
relationships, history, other cards' *"By \<name\>"* updater, and the *Narrator
character* setting all follow. (Snapshots keep the old name, so reverting *past*
a rename resurrects it.) Also `/wt-char rename <old> <new>`.

Cards added automatically (the persona auto‑track, **+ participants**, a
model‑introduced NPC) are marked provisional. On a chat change / before a
tracker pass, any that are **untouched** — no edited field, no relationship,
still present, no history — and aren't a current participant are dropped, so
switching character/persona doesn't leave a stale empty card behind. Edit
anything on a card and it's kept for good.

If you swap **persona**, its card (with whatever it accumulated) is renamed to
the new persona name automatically — no stale card, no lost data — unless the
new name is already tracked.

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
- **Character fields** is the template for each tracked NPC; **Your character**
  is a separate template for the persona's own card (see *Your own character*).
- add / remove / rename fields, pick a type (`text` / `number` / `enum`), set a
  unit (number) or max. Drag a field row by its **grip** to reorder it (the row
  order is the panel display order). For `enum`, the pencil button opens an
  editor: drag to reorder, rename, star one as the default, delete, or import
  from a comma list.
- **Collapsible #** (the small `–` / `0`–`9` picker per field row) — fields in
  the same section sharing a digit fold into one collapsible group in the panel
  (placed where the group's first field sits). `–` = its own row. The default
  character schema puts *Outfit / State of dress / Appearance / Pose* in group
  `0` so wardrobe detail stays one line until you open it. Collapse state is
  remembered globally per section+digit.
- edit the clock display format and start time.
- reset buttons per list, plus *Restore all defaults* (rebuilds the editor only,
  not other profiles).

Saving re‑shapes the current chat's data — new fields added, removed fields
dropped, existing values kept.

### Profiles

The gear dialog's **Profile** bar stores named copies of everything below it
(schema + section toggles + narrator):

- dropdown of profiles (the default is marked ★);
- **New** (from built‑in defaults) / **Save** (into the selected profile) /
  **Save as…** / **Rename** / **Delete**;
- **Use this profile for the current chat / group** — binds it to that group
  (or character); it's auto‑applied whenever you open that chat;
- **Default profile** — applied to any chat with no binding.

Switching or creating a profile applies it immediately. On chat change the
extension picks binding → default → whatever's active.

### Turn history & per‑message cards

Every applied change (tracker‑approved or hand‑edited) is appended to a per‑chat
**history log** (last 120 records). From it:

- Each tracked message shows an inline **"changes this turn"** card. Still
  pending proposals sit at the top with per‑row ✓/✗ and an Approve/Decline‑all
  in the header; once applied they fold into a collapsed `N changes this turn`
  strip (click to expand) with **Revert turn** and **State as of here** (the
  `[World State]` block reconstructed for that point).
- Every field row with a past value gets a **⟲** button — a dropdown of prior
  values (with the message # and how long ago) to restore in one click. Handy
  for "put the outfit back after the gym scene" or undoing a bad accept.
- Deleting a message or swipe prunes the log from there on, same as snapshots.

### Swipe / regenerate / delete safety

Before each tracker query a snapshot of the state is taken (keyed by message
index, last 40 kept — stored as **forward deltas** off a full keyframe every 8th
capture, so long chats don't bloat the chat metadata). Deleting or regenerating
a message rewinds state to the nearest earlier snapshot and prunes
proposals/history from that point. A snapshot is **write‑once per message** —
re‑running the tracker on the same message keeps the original pre‑turn baseline
so repeated passes recompute from the same point instead of compounding (matters
most for the clock).

**Swipes are tracked per candidate.** Each swipe's tracker pass is logged
against `(message, swipe_id)`; flipping between already‑generated swipes rebuilds
that swipe's state from its own records (pre‑query snapshot + replay) instead of
wiping it. A brand‑new swipe starts from the pre‑query state.

---

## Settings

**Extensions → WorldTracker** (global):

| Setting | Meaning |
|---|---|
| Connection profile | which connection the tracker query uses; blank = main API |
| Auto‑update | off / after AI / after mine / after every message |
| Messages of context | how many recent messages the query sees |
| Feed tracked state to the model + Injection depth | the `[World State]` block |
| Track my character | auto‑add a card for your persona, seeded from the *Your character* template |
| Answer / Extra think token budget | request `max_tokens` = answer + think, so a reasoning model isn't cut off before it writes the JSON |
| Reasoning effort | sent as `reasoning_effort`; *low* is usually plenty |
| Auto‑approve all changes | skip the review queue |
| Request structured JSON output | pass a `json_schema` to the backend |
| Verbose console logging | detailed `[WorldTracker]` logs |
| System prompt override / Extra instruction | replace / append to the query prompt |

**Panel gear button**: sections + field schema + clock format (see *Sections*).

**Export / Import** (bottom of the drawer): copy this chat's tracked state
(time, fields, characters, history, snapshots) as JSON, or replace it from a
paste — for backup, sharing a tuned setup, or cloning it into another chat.

## Slash commands

- `/wt-track` — run a tracker update now.
- `/wt-char add <name>` / `/wt-char remove <name>` / `/wt-char rename <old> <new>`
  — start / stop tracking / rename a character.
- `/wt-char sync` — track every current chat participant (skips the narrator
  unless it's *"any turn"*).
- `/wt-get <path>` / `/wt-set <path> <value>` — read / write one tracked field
  from STScript. `path` = `clock` | `world.<key>` | `userStats.<key>` |
  `characters.<name>.fields.<key>`. A `/wt-set` is logged like a hand‑edit.

---

## How it works

```
index.js            bootstrap: settings, panel, events, slash commands,
                    auto-update timing, swipe/revert handling
src/
  settings.js       global config + schema, extension_settings.WorldTracker
  schema.js         default field definitions (world / userStats / character / player)
  state.js          canonical per-chat state in chat_metadata; path helpers,
                    pending queue, keyframe+delta snapshots, turn-history log,
                    per-swipe restore, applySchema()
  diff.js           diffJson() / applyJsonPatch() — array-path deep JSON delta
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
    drag.js         makeDraggable / makeResizable (pointer + touch); makeSortable (HTML5 DnD list reorder)
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

1. **Structured output is `strict: false`** with no `additionalProperties`
   constraint — some backends ignore the schema; the tolerant parser is the
   real safety net. Turn it off if a backend errors on `json_schema`.
2. **`/wt-char add`** doesn't validate the name against chat participants
   (`/wt-char sync` and the Characters‑header button now cover bulk discovery of
   group members).
3. **Dead ternary** in `request.js` (`m.role === 'system' ? m.content :
   m.content`) — harmless, should be cleaned.
4. **No timezone handling** in `clock.js` — in‑world time is fictional so it
   doesn't matter, but adding elapsed time across a real DST boundary could
   shift an hour.
5. **New default schema fields don't reach existing installs.** `loadSettings`
   keeps a persisted `settings.schema` as‑is, so fields added to
   `defaultSchema()` in a later version (e.g. the wardrobe group) only appear
   in new chats / fresh installs. Add them by hand in the gear dialog, or
   *Restore all defaults*.
6. **Renaming your persona mid‑chat orphans the player card.** A fresh card is
   auto‑created for the new name; the old one is now a normal tracked
   character. If it was never touched it's dropped on the next chat change
   (see *Renaming & auto‑cleanup*); otherwise rename or remove it by hand.
7. **Reverting past a rename** restores the character's old name — snapshots are
   not rewritten by a rename.

---

## Development

Pure ES modules, no bundler. Edit a file, reload SillyTavern. Turn on *Verbose
console logging* in settings for a full trace; otherwise the console shows only
milestone events (`[WorldTracker] tracker request…`, `parsed tracker data…`,
`proposals: N…`, `revert @N…`).
