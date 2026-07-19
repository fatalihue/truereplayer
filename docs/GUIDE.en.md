<div align="center">

# TrueReplayer — User Guide

[Português (BR)](GUIDE.md) · **English** &nbsp;·&nbsp; [← Back to README](../README.en.md)

</div>

The complete reference for everything TrueReplayer can do. New here? Start with the [Quick start](../README.en.md#quick-start) in the README, then come back for the details.

## Contents

- [Core concepts](#core-concepts)
- [Recipes — learn by doing](#recipes--learn-by-doing)
- [Recording](#recording)
- [Replaying & execution settings](#replaying--execution-settings)
- [The action grid](#the-action-grid)
- [Action reference](#action-reference)
- [Conditional blocks (If / Else / EndIf)](#conditional-blocks-if--else--endif)
- [Profiles & folders](#profiles--folders)
- [Hotkeys & hotstrings](#hotkeys--hotstrings)
- [Automation (fire without a hotkey)](#automation-fire-without-a-hotkey)
- [Key remaps](#key-remaps)
- [Window targeting & relative coordinates](#window-targeting--relative-coordinates)
- [Multi-window automation (Activate Window)](#multi-window-automation-activate-window)
- [Clicker mode (auto-clicker)](#clicker-mode-auto-clicker)
- [Game mode](#game-mode)
- [Send Text](#send-text)
- [Variables, slots & prompts](#variables-slots--prompts)
- [Data Loop](#data-loop)
- [Browser automation](#browser-automation)
- [Themes & appearance](#themes--appearance)
- [Settings reference](#settings-reference)
- [Where your data lives](#where-your-data-lives)
- [Troubleshooting](#troubleshooting)

---

## Core concepts

- **Profile** — a single macro: an ordered list of actions plus its own settings (delays, loops, window target, etc.). Saved as a `.json` file.
- **Action** — one step in a profile (a click, a keystroke, a pause, an *If*, …). Shown as a row in the grid.
- **Folder** — an organizational, colored group of profiles. A profile lives in at most one folder.
- **Macro mode vs Clicker mode** — *Macro mode* records and replays action lists; *Clicker mode* is a dedicated auto-clicker. Switch with **`ScrollLock`** or the Macro/Clicker toggle at the bottom.

---

## Recipes — learn by doing

Fourteen short, complete tasks, easiest first. Each one names the exact buttons you click, and each is a real job somebody automates every day. Do two or three and you'll know the app.

Most useful macros are **tiny** — one or two actions. Don't feel you have to record something long.

### 1. A canned reply you can type anywhere

**You get:** typing `.cp` in any chat box expands into a full answer and sends it.

1. Toolbar → **Send Text**. Write the message.
2. From the token palette on the right, click **Enter** to put `{enter}` at the very end — that's what sends the message.
3. **`Ctrl+Enter`** to confirm, then **Save** the profile.
4. Right-click the profile → **Assign hotstring…** → type `.cp` → **Assign**.

*In practice:* a support desk keeps one of these per answer — `.cp` for the discount code, `/ve` for "it's on its way", `/pg` for the payment link. One action each.

### 2. Put whatever you copied inside the reply

**You get:** you copy the customer's username, press one key, and a full set of instructions goes out with that name already in it.

1. In **Send Text**, write your text and put `{clipboard}` where the copied value belongs.
2. Need only part of it? Add modifiers: `{clipboard:trim}` (drop stray spaces and line breaks), `{clipboard:line:3}` (just the third line), `{clipboard:upper}`.

Your own clipboard is restored right after, so nothing is lost.

*In practice:* copy a multi-line account block and re-emit only the lines you need with `{clipboard:line:1}` and `{clipboard:line:3}`.

### 3. Stamp the time and close the ticket

**You get:** one key posts the "delivered" message with today's date, then fires your helpdesk's own *resolve* shortcut.

1. **Send Text** → your message, then `Finished at {datetime}`, then `{enter}`.
2. Toolbar → **Send Keystroke** → press `Ctrl+Alt+R` (whatever your app uses) → **Add**.
3. Right-click the profile → **Assign hotkey…** → press `F1` → **Assign**.

Two actions, and the whole close-out is a single keypress.

### 4. Ask me for a value when it runs

**You get:** the macro stops, asks you a question, and types your answer into the right place.

1. In **Send Text**, type `{input:Order number}` where the answer should land.
2. Want a pick-list instead of a text box? Use `{input:Priority|menu:Low,Medium,High}`.

You're asked **once per run** — reuse the same `{input:Order number}` later and it types the same answer without asking again.

### 5. Make it work only in one app

**You get:** the macro's hotkey fires only when the right window is in front, and the clicks follow that window when it moves.

1. Right-click the profile → **Window target…**.
2. Click **Detect Window (click on target)**, then click the real window — the process and title fill themselves in.
3. Click **Test front window** to confirm it says *Matches*.
4. Turn on **Relative Coordinates** so clicks are stored relative to the window's corner.
5. If the macro was already recorded, accept the **Convert to Relative** prompt.

> Without this, a window moved by 20 px makes every click land in the wrong place.

### 6. Wait for the screen instead of guessing

**You get:** the macro waits for the button to actually appear, instead of clicking a spot that isn't ready yet.

1. Toolbar → **Wait for Image / Pixel** → **Wait for Image**.
2. The screen freezes — drag a rectangle around the button (or icon) you're waiting for.
3. In the panel that opens, click **Test match** to check it against the live screen. Aim for a comfortable match; leave confidence near **85%**.

> **Never set confidence to 100%.** A live screen never reproduces a reference pixel-for-pixel, so a 100% match simply times out.

*In practice:* this is the fix for "it works when the internet is fast and breaks when it's slow".

### 7. Do the optional click only when it appears

**You get:** a confirmation dialog gets clicked *if* it shows up, and the macro carries on normally when it doesn't.

1. Toolbar → **Conditional** → **Pixel Color Match**.
2. Pick a point inside the confirm button's solid color.
3. Select the **If** row and set **Wait for condition** to `5000` — it now waits up to 5 seconds for that color before deciding.
4. Put the click *between* **If** and **EndIf**.

Color beats an image when two states differ only by color — a green enabled button vs a grey disabled one.

### 8. Remember a value between steps

**You get:** compute or capture something once, reuse it anywhere later in the run.

1. Toolbar → **Set Variable**. Give it a **Name** (e.g. `customer`) and a **Value** — the value can itself contain tokens, like `{clipboard:trim}`.
2. Anywhere later, type `{var:customer}`.

Variables are cleared at the start of every run. Set the mode to **Cycle** and the value becomes a list — each run takes the *next* line, wrapping at the end.

### 9. Collect several values, paste them all later

**You get:** grab three things from three different places, then fill a form with all of them.

1. Settings → **Keys** → **Hotkeys** → **Capture Slot** → press a combo.
2. Select some text anywhere and press that combo. Repeat — captures land in slots 1, 2, 3… up to 9, then wrap.
3. In a profile, type `{clip:1}`, `{clip:2}`, `{clip:3}` wherever they belong.

Slots survive between runs, unlike variables. To capture *during* a macro instead of by hand, use the **Copy to Slot** action with a named slot and read it back with `{clip:name}`.

### 10. Type the next item from a list on every press

**You get:** one hotkey that works through a checklist — a different item each time you press it.

1. Toolbar → **Data Loop** → **Paste / bulk edit…** → paste your list from Excel → **Replace table**.
2. Leave **Loop over data** **off**.
3. In **Send Text**, type `{row:col1}` (or your column's name) and `{enter}`.

Each press uses the next row and advances; at the end it wraps back to the top and chimes. Right-click a row → **Reset row position** to start over.

### 11. Replace 20 repeated steps with one loop

**You get:** one small macro plus a table, instead of the same five actions copy-pasted seventeen times.

1. Build the macro **once**, for a single item.
2. Toolbar → **Data Loop** → paste a table with a column per changing value (e.g. `item` and `qty`).
3. Replace the fixed values in your actions with `{row:item}` and `{row:qty}`.
4. Turn **Loop over data** **on** — the macro now runs once per row.
5. Set **On row error** to **Skip row** if one bad row shouldn't stop the batch.

*In practice:* an 87-action macro that loads 17 items into a form becomes 5 actions and a 17-row table — and adding an item is a new row, not a re-recording.

### 12. Reuse one ending in many macros

**You get:** twenty macros that all finish with the same confirmation steps — fixed in one place.

1. Put the shared steps in their own profile (e.g. `Confirm`).
2. In each macro, toolbar → **Run Profile** → pick `Confirm` → **Add**.

Fix the confirm flow once and all twenty improve. Chains deeper than 5 levels are blocked automatically.

> The sub-profile's own **Loops** are ignored — only the **Repeat** count in the dialog applies.

### 13. Click a website by name, not by position

**You get:** web steps that survive the page moving around.

1. Install the Chrome extension (see [Browser automation](#browser-automation)) and make sure it's connected.
2. Toolbar → **Browser** → **Browser Click**, and pick the element on the page.
3. Prefer matching by visible **text** (e.g. `text=Send`) when the layout changes often.

*In practice:* three selector clicks move a helpdesk conversation to another inbox — no coordinates at all, so it keeps working when the window is resized.

### 14. Run it without pressing anything

**You get:** the macro fires on its own — every N minutes, at a set time, or when something appears on screen.

1. Settings → **App** → **Automation** → **Manage ›**.
2. **+ Add automation** → pick the profile.
3. Choose the **Trigger**: **Interval**, **Schedule** or **Condition**.
4. **Save**, then flip the row's **Armed** toggle in the list.

> Saving is not arming. A configured automation does nothing until you arm it — that toggle is the one people miss.

Turn on **Run on Startup** + **Startup Minimized** (Settings → App → Startup) and TrueReplayer becomes a background helper in the tray.

---

## Recording

1. Make sure a profile is active (or start a new one).
2. Press **`Ctrl+PageUp`** (or click **Recording**). The Recording badge and button start glowing so you can't miss that capture is live.
3. Do your actions — clicks, typing, scrolling.
4. Press **`Ctrl+PageUp`** again to stop.

**Where new steps land:** if you have rows **selected**, recording inserts **before** the first selected row; with **no selection**, it **appends** to the end. Clear the selection to append.

### Capture filters (Settings → Recording)

| Toggle | Effect |
| --- | --- |
| **Mouse Clicks** | Capture left / right / middle clicks and double-clicks. |
| **Mouse Scroll** | Capture scroll-wheel up/down. |
| **Keyboard** | Capture key presses and modifiers. |
| **Combined Actions** | **On** → input is merged into single rows (e.g. `Ctrl+C` = one *Keystroke* row). **Off** → recorded as separate `KeyDown`/`KeyUp` (and `LeftClickDown`/`LeftClickUp`) rows — needed for drags or holding a key while doing other things. |

All four default to **On**.

---

## Replaying & execution settings

Press **`Ctrl+PageDown`** (or click **Replay**) to run the active profile; press again or click **Stop** to halt immediately (any held buttons are released). During replay the **"Replaying"** badge and **Stop** button pulse so the running state is obvious, and the status bar shows progress, elapsed time and the loop counter.

**Execution** settings (Settings → Profile tab) control timing:

| Setting | What it does | Default |
| --- | --- | --- |
| **Delay** | A fixed delay (ms) applied before each action, overriding recorded timing. | 100 ms (on) |
| **Loops** | How many times to repeat the whole macro. **0 = forever.** | 1 |
| **Interval** | Pause (ms) between loop iterations. | off |
| **Jitter** | Random ± % applied to each delay, so playback isn't perfectly regular. | off |

---

## The action grid

The central table lists every action in the profile. Columns: **selection checkbox · Action (colored pill) · Details · Delay · Notes**.

<p align="center">
  <img src="img/main.png" width="820" alt="The TrueReplayer main window and action grid" /><br>
  <sub><i>Profiles &amp; folders on the left, the action grid in the center, settings on the right.</i></sub>
</p>

- **Select** — click a row (single), `Ctrl+Click` (toggle), `Shift+Click` (range), or use the checkboxes.
- **Edit inline** — click a cell to edit **Delay**, **Notes**, **coordinates** (`x, y` for mouse rows — separators can be comma/semicolon/space) or the **Key** (keyboard rows capture the next key you press). Commit with **Enter/Tab**, cancel with **Esc**.
- **Reorder** — drag a row, or select and press **`Alt+↑` / `Alt+↓`**.
- **Right-click** a row for **Duplicate**, **Delete**, **Edit** and more. (**Else** isn't here — it goes in via the dashed **+ Add Else branch** row inside the If block.)
- **Skip** — unchecking a row keeps it in the list but it won't run during replay.
- **Bulk bar** — when multiple rows are selected, a bar appears with **Set delay**, **Set X / Set Y** (a `+10` / `-5` offset adjusts each; a plain number sets all), **Set notes**, **Move ↑/↓**, **Skip**, **Delete**.
- **Sheet panel** — right-click → Edit (or open the Sheet) for a full form with every field of the selected row.

> **Note:** *Else / EndIf* are pure jump markers — their Delay cell is blank and not editable, and a bulk "set delay" skips them. The opening **If** *does* take a delay: it's a **pre-probe wait** applied before the condition is checked, so a slow-to-appear image/pixel isn't read as "false" and the block wrongly skipped.

---

## Action reference

| Action | What it does |
| --- | --- |
| **Left / Right / Middle Click** | A single click of that button at `(x, y)`. |
| **Double Click** | Two left clicks at the same point, timed below the system double-click threshold so apps treat it as a real double-click. |
| **Keystroke** | Press a key or combo once — or **N times** with a configurable gap. |
| **Hold Key** | Hold a single key down for a set duration (default 1000 ms). Modifiers are dropped. |
| **Key Down / Key Up** | A standalone press or release — for holds and drags where down/up must be separate. |
| **Scroll Up / Down** | One mouse-wheel notch at the cursor. |
| **Send Text** | Inject text (with tokens, snippets, clipboard transforms) — see [Send Text](#send-text). |
| **Set Variable** | Store a named value for the rest of the run, read back with `{var:name}`. In *Cycle* mode the value is a list and each run takes the next line — see [Variables, slots & prompts](#variables-slots--prompts). |
| **Copy to Slot** | Copy whatever is **currently selected** in the focused app into a named clipboard slot, read back with `{clip:name}`. |
| **Pause** | Halt until a **resume hotkey** is pressed or a **timeout** expires (whichever comes first). Needs at least one of the two. |
| **Wait Image** | Block until a reference image appears on screen (optionally within a cropped search region; confidence default ≈ 85%). |
| **Wait Pixel Color** | Block until the pixel at `(x, y)` matches a target hex color (within tolerance). |
| **Run Profile** | Run another profile as a sub-step — optionally a set number of times. Cycles and chains deeper than 5 levels are blocked automatically. |
| **Activate Window** | Act on another app's window mid-run: **Activate** (bring to the front — launching it first if needed), **Maximize**, **Minimize** or **Close**. *Activate* changes the OS focus target only, never the coordinate context. See [Multi-window automation](#multi-window-automation-activate-window). |
| **If / Else / EndIf** | Conditional branch — see [Conditional blocks](#conditional-blocks-if--else--endif). |
| **Browser actions** | Click / Type / Navigate / Wait element / Assert element / Select option in Chrome — see [Browser automation](#browser-automation). |

Insert actions from the **toolbar** (Send Keystroke, Send Text, Set Variable, Copy to Slot, Pause, Wait, Conditional, Browser, Run Profile, Activate Window, Data Loop). Most actions open a small dialog to configure them; click an action's Details cell later to edit it.

> **Tip — match by colour, not confidence.** Image matching compares the whole reference, so it's great for shape/text but a blunt tool for telling apart two states that differ only in **colour** (e.g. an enabled *green* vs a disabled *grey* button). For that, use **Wait Pixel Color** (or an **If** on *Pixel Color Match*): sample a point in the solid fill and match the colour within a tolerance. Also don't set **confidence to 100%** — a live screen never reproduces a reference pixel-for-pixel, so a 100% match times out (it's capped just under 100% internally).

---

## Conditional blocks (If / Else / EndIf)

Make a macro react to what's on screen.

<p align="center">
  <img src="img/conditionals.png" width="820" alt="Two If/Else/EndIf blocks in the action grid" /><br>
  <sub><i>A negated pixel check (<code>if NOT</code>) and an image check with an <code>else</code> branch.</i></sub>
</p>

- An **If** runs a **probe** — a quick yes/no check. Pick the type from the toolbar's **Conditional** menu when you insert the block:

| Condition | True when |
| --- | --- |
| **Image Found** | A reference image is visible on screen. |
| **Pixel Color Match** | The pixel at `(x, y)` matches a color (within tolerance). |
| **Window Open** | A window matching a process/title exists — optionally only when it's in the foreground. |
| **Clipboard** | The clipboard text matches (Contains / Exact / Regex / Empty). |
| **Browser Element** | An element in Chrome is present, visible or enabled. |
| **Random** | A dice roll lands under N% — for macros that shouldn't look perfectly regular. |
| **Variable** | A `{var:name}` compares true against a value (equals, contains, greater than, …). |
| **Process Running** | A named process is alive. |
| **File Exists** | A file or folder exists on disk. |
| **Time** | The clock is inside a start–end window, on the weekdays you pick. |

- If the probe is **true**, the actions between **If** and **Else/EndIf** run; if **false**, execution jumps to the **Else** branch (if present) or past the **EndIf**.
- **Negate (IFNOT)** flips the test — the *true* branch runs when the probe **fails**.
- **Wait for condition (optional)** — by default an **If** checks once and branches instantly. Set a *Wait for condition* value (ms) and it polls that long for the condition to become true before deciding: satisfied in time → **true** branch; time runs out → **Else / false**. Great for *"wait up to 3 s for the button to enable, else take a fallback path."* `0` = instant (the default).
- Blocks can be **nested** — each nesting level shows in its own colour (with matching scope rails) so deep conditionals stay readable. To create a nested block, select a row **inside** an existing block, then **Insert Conditional**. Add an **Else** via the dashed **+ Add Else branch** row inside the block. The structure is validated and auto-repaired on load (orphan markers removed, missing `EndIf` added).

**Editing a block's contents** — actions *inside* a block edit granularly; an operation only snaps to the **whole block** when your selection includes a marker (*If / Else / EndIf*), so markers can never be orphaned:
- **Drag** one or more body actions freely **in or out** of a block (single, multiple, even non-contiguous).
- **Delete** body rows and the block stays — select the **If** row to delete the whole block.
- **Reorder** with **Move ↑/↓** or **`Alt+↑` / `Alt+↓`**: a body-only selection moves on its own; a selection touching a marker carries the whole block.
- **Duplicate** an **If** to copy the whole block as a sibling.
- Dragging the **If** itself (or any selection that includes a marker) always moves the whole block together.

### Worked example — the dialog that only shows up sometimes

**The situation.** Every time you close a ticket, the system *sometimes* pops a "Are you sure?" dialog — and sometimes doesn't. When it shows up, the macro types straight over it and wrecks the run; when it doesn't, a fixed 3-second pause just makes you wait for nothing. What you want is simple: if the dialog is there, click **OK**; if it isn't, carry on immediately.

**Step 1 — pick where the block goes.** Click the grid row that comes right after the moment the dialog usually appears. The block is inserted **before** the selected row (with nothing selected, it lands at the end of the list).

**Step 2 — insert the block.** Toolbar → the branch-icon button (its tooltip reads **Conditional**) → the flyout is headed **Insert Conditional** and lists the ten condition types. For a real dialog window, use **Window Open**. Two rows go in at once: **If** and **EndIf**.

**Step 3 — describe the window.** The editor opens on its own. Fill in **Process Name** (say `notepad.exe`) and/or **Title** — either one is enough. Leave **Foreground window only** unchecked if the dialog can sit behind another window. With the dialog on screen, hit **Test**: it should read *Found* followed by the matched window's process and title.

**Step 4 — put the click inside the block.** Drag the action that clicks **OK** to sit between the **If** and the **EndIf** (a lone body row drags freely). Now it only runs when the dialog exists.

| Row | When it runs |
| --- | --- |
| **If** — Window Open · `Confirm` | always — it's the check |
| Left Click (612, 428) | only if the window exists |
| **EndIf** | closes the block |

**Step 5 — give the dialog time to appear.** Open the **If** row's editor (hover the row and click the pencil, or select the row and press **Enter**, or right-click → **Edit** — a plain click only toggles selection) and set **Wait for condition** to, say, `2000` ms. Instead of deciding in a blink, it keeps re-checking for up to 2 seconds: showed up in time → the block runs; time ran out → it jumps past the **EndIf**. And if it appears in 200 ms, the macro moves on in 200 ms — it doesn't sit through the full 2 seconds.

**Step 6 (optional) — the plan B.** If you want to do something else when the dialog *doesn't* appear, look inside the block: just above the **EndIf** there's a dashed **+ Add Else branch** row. Click it and the **Else** drops in there. Whatever sits after the **Else** runs only when the check comes back negative.

> **To flip it without an Else.** On the **If** row, the **Condition** field has two options: **Found** and **NOT Found** (that's IFNOT). With **NOT Found**, the block's body runs precisely when the window is **not** there — handy for "if the dialog never showed, something went wrong, grab a screenshot."

Here's the difference between the two waits: the **If** row's own **Delay** — which isn't in this editor at all, but in the grid's **Delay** column (click the cell to edit it) — is a **fixed wait before** the check, and it always burns the whole thing, even if the window was already there; **Wait for condition** burns only as long as it needs to. Fill in both and they add up. (**Else** and **EndIf** rows have no Delay field at all — the cell is blank and not editable, and a bulk "set delay" skips them.)

> **If it goes wrong.** Almost everyone hunts for **Else** in the right-click menu, doesn't find it, and concludes the app has no Else. It genuinely isn't there: **+ Add Else branch** is that dashed row inside the block, right before the **EndIf** — and it only shows while the block **doesn't yet have** an Else (once you add one it disappears, which is correct). It's also disabled while you're recording or replaying: stop the macro and it works again.

---

## Profiles & folders

- **New / Save / Rename / Duplicate / Delete** from the Profiles panel (left).
- **Pin** a profile to keep it at the top; **drag** it into a **folder** to group it.
- **Folders** — create, rename, recolor, collapse. A folder can hold a default **window target** that its profiles inherit.
- **Profile info** — give a profile an **emoji icon**, **description** and **tags** (right-click → Info). Tags are searchable.
- **Search** filters the list by name or tag.
- **Import / Export** — export selected profiles to a `.trprofile` file (actions + metadata + reference images + optional folder/pin layout). Import shows a conflict screen where each clashing profile gets **Rename** (the default — nothing is ever silently overwritten), **Overwrite** or **Skip**, plus a security note if the file contains auto-firing actions. A profile that needs a newer TrueReplayer than yours is greyed out with the reason.

### The command palette (`Ctrl+K`)

Commands that have no button of their own, in three groups:

- **Profiles** — *Duplicate profile*, *Reset profile*, *Import profiles*, *Export all profiles*.
- **Actions** — *Copy as Table* / *Paste Actions* (move steps between profiles as text), *Convert to Relative* / *Convert to Absolute* coordinates, and *Combined ↔ Paired* conversion (merge `KeyDown`+`KeyUp` rows into one, or split them apart).
- **Diagnostics** — *Toggle Live Variables*, plus the Automation and Theme Editor panels.

---

## Hotkeys & hotstrings

Bind a profile to a trigger so it runs without opening the app.

<p align="center">
  <img src="img/hotkey.png" width="320" alt="The Assign Hotkey dialog with trigger modes" /><br>
  <sub><i>Capture a key combo and pick a trigger mode.</i></sub>
</p>

- **Hotkey** — right-click a profile → **Assign hotkey**, press the combo (e.g. `Ctrl+Alt+F1`), pick a trigger mode. Fires globally.
- **Hotstring** — assign a typed sequence (e.g. `qqsig`); finishing it runs the profile.
- **Master switch** — `Pause` (or Settings → Recording → **Profile Keys**) enables/disables **all** hotkeys and hotstrings at once.

### Trigger modes

| Mode | Behavior |
| --- | --- |
| **On Press** | Fires once when the key goes down. |
| **On Release** | Fires once when the key is released (the press is swallowed while held). |
| **While Pressed** | Loops the macro continuously while held; stops on release (autofire). |
| **Toggle** | First press starts (respecting the profile's loops); second press stops. |
| **Double-tap** | Fires once when the key is tapped twice quickly (~0.4 s). Single taps do nothing. |
| **Hold (long-press)** | Fires **once** after the key has been held ~0.6 s; a quick tap does nothing. Unlike *While Pressed*, the run does **not** stop on release. |

> Trigger modes apply to **hotkeys** only. **Hotstrings** always fire when typed.

**Mouse side buttons.** The two side buttons (**XButton1** / **XButton2**, alone or with modifiers)
can be captured as hotkeys just like keys, with every trigger mode above — ideal for click-heavy
game macros. The wheel (`ScrollUp`/`ScrollDown`) also works but always fires On Press.

---

## Automation (fire without a hotkey)

An **Automation** fires a profile by itself — no hotkey press. Manage them in
**Settings → App → Automation → Manage** (or the tray menu → **Automations…**).
Three trigger kinds per profile (one automation each):

| Kind | Fires |
| --- | --- |
| **Interval** | Every N seconds (the field is in seconds; 300 = 5 minutes). The first fire comes one interval after arming. |
| **Schedule** | At a clock time (`HH:mm`) on the weekdays you pick. |
| **Condition** | When a watched condition **becomes true**: a window opens (or comes to the foreground), a process starts, a file appears, a pixel matches a color, an image appears on screen, or the clipboard changes. |

How it behaves:

- **Armed** — only armed automations run; they re-arm automatically at startup, so
  *Run on Startup* + *Startup Minimized* turns TrueReplayer into a tray daemon. Arming is
  **local to your machine**: imported, duplicated or copied profiles always arrive disarmed.
- **One run at a time** — a fire is **skipped** (and counted in the panel) while a replay or
  recording is running, while you have unsaved edits in the grid, or while a dialog is open.
  An automation never discards your unsaved work.
- **Condition fires** are edge-based by default: the condition must turn false again before the
  next fire (switch to **Continuous** to re-fire every cooldown while it stays true). A
  **Cooldown** (default 30 s) spaces fires; the clipboard watcher ignores clipboard traffic
  produced by TrueReplayer itself.
- **Master switch** — Settings → App → Automation, mirrored in the tray menu
  (**Enable Automations**). The tray tooltip shows how many automations are armed.
- Profiles without a window target act on whatever window is focused when the trigger fires —
  the editor warns you. Prefer targeted profiles (or *Activate Window* as the first action).

### Worked example — the 8 a.m. macro that runs itself

**The situation.** Every weekday at 8, someone has to open the system and post the shift-opening message. It's the same sequence of clicks, at the same time, every day — and it always depends on somebody remembering. A hotkey doesn't solve it: a hotkey needs a finger on the keyboard.

**Step 1 — open the panel.** Settings → **App** → **Automation** → **Manage ›**. (The tray menu opens it too, under **Automations…**.)

**Step 2 — create the automation.** Click **Add automation** (the button with the + icon) and pick the profile from the list. Only profiles that don't have one yet show up — each profile gets at most one automation.

**Step 3 — pick the trigger.** The **Trigger** field offers three:

| Trigger | Fires | Fields and limits |
| --- | --- | --- |
| **Interval** | Every N seconds (the field is in seconds; 300 = 5 minutes) | **Every** — the field is in **seconds** (`s` suffix): minimum 5, maximum 86,400 (24 h), default 300 (= 5 min). The first fire happens one interval after you arm it. |
| **Schedule** | At a clock time | **At** in `HH:mm` format, plus the **Mon** … **Sun** pills under **Days**. |
| **Condition** | When something becomes true | Six watched conditions: **Window open**, **Process running**, **File exists**, **Pixel color**, **Image on screen**, **Clipboard changed**. |

**Step 4 — set the time.** Choose **Schedule**, type `08:00` in **At**, and click the **Mon** through **Fri** pills in **Days**. Leaving all of them off means **every day**. Click **Save**.

**Step 5 — arm it.** Flip the toggle on the profile's row in the list on the left. It takes effect immediately, independent of **Save**. Check the master switch too — the panel footer labels it **Automations enabled**, while Settings → App → Automation and the tray menu label it **Enable Automations**.

**Step 6 — leave the app on watch.** Settings → **App** → **Startup** → turn on **Run on Startup**, then **Startup Minimized** (the second one stays greyed out while the first is off). TrueReplayer now starts with Windows, disappears into the tray, and re-arms its automations by itself.

That's the difference between the first two: **Interval** counts from the moment you armed it — arm at 9:47 with 5 minutes and it fires at 9:52, 9:57, and the clock times depend on when you flipped the switch. **Schedule** counts by the clock: 08:00 is 08:00, whenever you armed it. Use **Interval** for "every so often", **Schedule** for "every day at 8".

> Arming is **local to this machine**. Imported, duplicated or copied profiles always arrive **disarmed** — deliberately, so a profile someone sent you never starts acting on your computer on its own.

> **If it goes wrong.** By far the most common miss: **saving is not arming**. **Save** stores the trigger's configuration; the toggle on the list row is what actually brings the automation to life. If it's armed and still doesn't run, the fire was **skipped** — an automation never runs over your work: it skips while a replay, a recording or Clicker mode is going, while a dialog is open (or you're capturing a hotkey), or while the action list has unsaved edits. Once there are skips, the panel shows a **Skipped fires** line at the bottom of the editor, broken down by reason (*busy* · *unsaved changes* · *dialog open*) — it only appears after the first skip. A skipped **Schedule** keeps retrying for up to 3 minutes and then gives up for the day.

---

## Key remaps

**Settings → Keys → Key Remaps** — an always-on 1:1 layer, independent of profiles:

- **Remap a key** — e.g. `CapsLock → Esc`: everywhere, while TrueReplayer runs, pressing
  CapsLock types Esc. Mouse side buttons (**XButton1/2**) can be sources too (side button → key).
- **Disable a key** — map it to nothing.
- Remaps **pause automatically while you record** a macro (recordings capture the physical keys)
  and can be paused globally from the tray (**Enable Key Remaps**) — the mouse-only escape hatch
  if a remap ever makes typing awkward.
- Hotstrings follow the **remapped** keystream (what the apps see), and key combos treat a
  remapped modifier as the key it became. A key used as a remap **source** can't also be a
  profile hotkey — the remap wins.

---

## Window targeting & relative coordinates

Tie a profile (or a whole folder) to a specific application window.

<p align="center">
  <img src="img/target.png" width="360" alt="The Target Configuration dialog" /><br>
  <sub><i>Match a window by process / title, with relative coordinates and restore options.</i></sub>
</p>

- **Window target** — set a process name and/or window title (match *contains* or *regex*). The profile's **hotkey only fires when that window is in front**. Use **Detect window** to click a window and auto-fill the fields, and **Test** to check the match.
- **Relative coordinates** — store clicks relative to the window's top-left corner instead of the screen, so the macro keeps hitting the right spot when the window moves or resizes. Use **Convert to Relative / Absolute** to migrate an existing macro's coordinates.
- **Bring to focus** — restore + foreground the window before replay.
- **Restore position / size** — snap the window back to a saved geometry first (use **Update window** to capture the current one).

> If a profile uses relative coordinates and its target window isn't found at replay time, replay stops with an error (rather than clicking the wrong place).

### Worked example — the macro that worked yesterday and clicks the wrong place today

**The situation.** You recorded a macro that clicks three buttons inside your company's system, and it ran fine all week. Today it clicked empty space — or worse, the button next door. The macro didn't change: someone dragged the window, snapped it to half the screen, or the macro fired while the browser was in front. A recorded click stores a point **on the screen**, so the window only has to move ten pixels for every click to miss at once.

**Step 1 — name the window.** Right-click the profile → **Window target…** → **Detect Window (click on target)**, then click the real window. **Process Name** and the title fill themselves in (`Esc` cancels detection if you click the wrong one).

**Step 2 — check before you save.** Leave the system visible behind the dialog and hit **Test front window**. It has to read *✓ Matches* with the process name. TrueReplayer's own window is excluded from that test, so the verdict is always about the app behind it. The button resets on its own after a few seconds — just click again. If the title changes with every ticket, start with **Contains**: delete the part that varies and keep only the chunk that never changes — that's enough most of the time. **Regex** is the escape hatch for when the fixed part isn't one single chunk, e.g. when the steady text sits at both the start *and* the end of the title:

```
^Orders .* — Internal System$
```

In plain words: `^` anchors to the start of the title, `Orders ` is literal text, `.*` accepts anything in the middle (the order number, the customer name), ` — Internal System` is literal again, and `$` anchors to the end. So: it matches any title that **starts** with "Orders " and **ends** with " — Internal System".

**Step 3 — turn on Relative Coordinates.** Clicks are now stored against the window's top-left corner instead of the screen — and so are **WaitImage** search regions and **WaitPixel** coordinates, which is why the notice counts "actions" and not just clicks. Since the macro was already recorded, an amber notice appears — *"12 actions captured in absolute coords"* — with two buttons: press **Apply target & convert** to migrate the old actions — that's the label you'll see here, because Step 1's detection counts as editing the target fields. (It reads plain **Convert** only when the target was already saved and you changed nothing but the toggle.) **Skip** leaves the old numbers to be read as if they were already relative, which is exactly how a macro starts clicking in a corner.

**Step 4 (optional) — pin the window down.** In this order:

1. Turn on **Bring to Focus**, so the window comes to the front before a run.
2. If the app needs a particular size, arrange the window the way you want it and click **Update Window Size & Position** to capture the geometry.
3. Only then turn on **Restore Position** and **Restore Size**. Turning on **Restore Position** with nothing captured moves the window to the top-left corner of the screen (the saved X/Y default to 0,0); **Restore Size** with nothing captured simply does nothing.

**Step 5 — click Set Target.** This step is not optional: **nothing** from the earlier steps is written to the profile until you click it. Until that click the target and the toggles live only in the dialog, and closing it throws them away. (The one exception is **Update Window Size & Position**, which writes the geometry straight away.)

That's the difference between the two: **Relative Coordinates** lets the macro *follow* the window wherever it sits; **Restore Position / Size** *puts the window back* to a saved size and spot before anything starts. Together they're belt and braces — the second one earns its keep when the app's layout reflows with the window width.

> Once a target is set, the profile's **hotkey only fires when that window is in front** — *unless* you also turn on **Bring to Focus** (Step 4), which exempts the profile from the gate entirely and lets the hotkey fire from any window. Without it, no more "I pressed it by accident and the macro typed into my editor". And if the profile uses relative coordinates and the window isn't found at replay time, the run **stops with an error** (*Target window 'x' not found — open it and retry*) instead of clicking somewhere random.

> **If it goes wrong.** Two things look like a frozen dialog and aren't. First: the **Relative Coordinates** toggle stays greyed out and won't switch on while **Process Name** and the title are both empty — relative coordinates need a window to hang off, so fill the target in first. Second: while the conversion notice is up, **Set Target** is disabled — you have to pick **Apply target & convert** or **Skip** before you can save. Hover it and the tooltip says so.

---

## Multi-window automation (Activate Window)

The **Activate Window** action switches which app is in front *mid-run*, so one macro can drive several windows in turn. It's distinct from the profile-level [Window targeting](#window-targeting--relative-coordinates) above: that pins a *whole profile* to one window (and gates its hotkey); this is a single **action** you drop into the grid at each app switch.

**It changes only the OS foreground — never your coordinate context.** Clicks keep resolving against the profile's target (or the screen, when there's none), so the pattern you pick depends on whether the steps after a switch need clicks *relative to that new window*:

- **Simple multi-window (absolute clicks).** Leave the profile with **no target**, record clicks in absolute screen coordinates, and drop an **Activate Window** row before each app's steps. Fill **Path** so it launches the app if it isn't already open; leave Path empty to just wait-and-focus an already-running window.
- **Precision multi-window (relative clicks per window).** Make a target-less **orchestrator** profile that alternates **Activate Window X (launch)** → **Run Profile "X-steps"**, where each sub-profile owns *its own* window target + relative coordinates. Activating X first guarantees the sub-profile's target exists before its first relative click.
- **Return to your own window.** An **Activate Window** pointing at the profile's own target is a mid-run "come back here" step after a detour into another app.

**Fields.** Match the window by **Process** and/or **Title** (Contains or Regex) — use the **picker** to choose a running process, or **Detect window** to click the target. **Path / Args** launch the app when no window matches (a full path is safest; a bare `app.exe` only resolves if it's on `PATH`). **Placement** optionally moves/resizes the activated window — positional only; it does *not* change where clicks land. **Timeout / On timeout** decide how long to wait and whether to **Halt** (default — safe, since keystrokes follow whatever window is focused) or **Continue** if the window can't be found or focused. **Test** checks whether a matching window exists right now.

---

## Clicker mode (auto-clicker)

Switch to **Clicker** with **`ScrollLock`** (or the Macro/Clicker toggle). The Profile panel swaps to clicker settings:

| Setting | What it does | Default |
| --- | --- | --- |
| **Button** | Left / Right / Middle. | Left |
| **Rate** | Click speed, as a delay (ms) or clicks/second. | 100 ms (10/s) |
| **Loops** | Number of clicks. **0 = infinite.** | 0 |
| **Interval** | Pause between loop iterations. | off |
| **Jitter** | Random ± % on the delay. | off |
| **Position** | Randomize the click position slightly. | off |
| **Area** | Drag a rectangle to click random points inside it (mutually exclusive with Position jitter). | off |

Start/stop with **`PageDown`**, pause/resume with **`PageUp`**. While running, the **live dashboard** shows the click count, rate, elapsed time, loop progress and ETA.

<p align="center">
  <img src="img/clicker.png" width="820" alt="The Clicker dashboard while running" /><br>
  <sub><i>Live count, rate, elapsed time, loop progress, ETA and a progress bar.</i></sub>
</p>

---

## Game mode

For games (e.g. Roblox) that ignore an instant cursor "teleport", *Game mode* makes the movement look human. It's **on by default**; turn it off for normal apps that don't need it.

- **Smooth movement** — walks the cursor to the target in small steps (tune **Path step** px, **Step delay**, **Click delay**). Defaults: 20 px / 2 ms / 10 ms.
- **Fast approach** — for long moves, teleports invisibly to within **Settle distance** (default 80 px) of the target, then walks the final stretch — so far clicks stay quick.
- **Focus-click** *(per action)* — some tiny targets (a small Roblox text field) only take keyboard focus on a *second* click. Toggle **Focus click** on a click row (right-click) and it clicks twice a few pixels apart. **Use it only on small text fields, never on buttons** (a button would fire twice).

---

## Send Text

The **Insert Text** editor composes text that's injected via clipboard paste (so layouts and special characters survive).

<p align="center">
  <img src="img/sendtext.png" width="820" alt="The Send Text editor with token chips and a key/clipboard palette" /><br>
  <sub><i>Editable token chips inline, with a key &amp; clipboard palette on the side.</i></sub>
</p>

- **Tokens** — embed special keys and values: `{enter}`, `{tab}`, `{space}`, arrows and other keys; `{date}` / `{time}` / `{datetime}`; `{delay:500}` to pause mid-text. Repeatable keys take a count: `{enter:3}`.
- **Clipboard** — `{clipboard}` inserts the current clipboard; `{clipboard:upper}`, `{clipboard:trim}`, `{clipboard:line:1}` etc. transform it (trim → extract → limit → case order). Your real clipboard is restored afterward.
- **Run-state tokens** — `{var:name}`, `{clip:name}`, `{input:Label}`, `{counter}` and `{row:column}` pull in values from the running macro; see [Variables, slots & prompts](#variables-slots--prompts) and [Data Loop](#data-loop).
- **Token chips** — each token shows as an editable chip; click it to tweak its parameters.
- **Snippets** — save reusable text under a name for quick insertion later. Snippets live in the app, not in the profile, so they don't travel with export/import.
- Confirm with **`Ctrl+Enter`** (plain `Enter` makes a new line); `Esc` cancels.

**Delivery** decides how the formatting arrives, since every app understands something different:

| Mode | Sends |
| --- | --- |
| **Rich** | Real formatting (bold, lists, links) where the target accepts it — email clients, docs, most web editors. |
| **Markdown** | The `*bold*` / `_italic_` style WhatsApp-like apps expect. |
| **Discord** | Discord's own flavour (`**bold**`, `~~strike~~`). |
| **Plain** | Plain characters only — safest for search boxes, game chats and code fields. |

### Worked example — the reply you retype twenty times a day

**The situation.** Every day you send the same support reply, changing only the person's name and the time. Twenty-odd times a day: copy the name from the ticket, retype the text, check you didn't fumble a word, glance at the clock to write the timestamp. Five lines you know by heart, rewritten from scratch every single time.

**Step 1 — open the editor.** Toolbar → the **Send Text** button (a "T" icon; the name only shows on hover). The window that opens is titled **Insert Text** — same thing. Write the body of the message normally, as if you were typing it into the chat.

**Step 2 — drop tokens where the text changes.** In the right-hand panel, **Insert** tab, the chips sit in sections:

- **Clipboard** — **Clipboard** (`{clipboard}`) and **Advanced…**, which builds transforms like `{clipboard:trim}`.
- **Values** — **Date**, **Time**, **DateTime** and **Random**.
- **Keys & timing** — **Enter**, **Tab** and **Delay** (`{delay:500}`), plus a **More keys** toggle for the rarer keys.
- **Run state** — **Variable…**, **Counter**, **Row #** and others.

Click a chip and it lands at the cursor. The body ends up like this:

```
Hi {clipboard:trim}, how are you?
We got your ticket and we're on it.
You'll hear back within 2 business hours.
Logged at {datetime}.{delay:500}{enter}
```

**Step 3 — pick the Delivery.** At the bottom of the dialog, to the left of the **Cancel** and **Add** buttons, sits the **Delivery** selector: **Rich** for email and docs, **Markdown** for WhatsApp, **Discord** for Discord, **Plain** for search boxes and game chat. It ships on **Rich**.

**Step 4 — save it as a Snippet**, while the text is still on screen. At the bottom of the right-hand panel find **Snippets** and click the bookmark icon next to it. Give it a name (`standard-reply`) → **Save**. From then on, clicking that name in the list inserts the whole text, tokens and formatting included, into the **Insert Text** editor.

**Step 5 — confirm with `Ctrl+Enter`.** Plain `Enter` makes a new line inside the text; `Ctrl+Enter` — or the **Add** button in the bottom-right corner — is what closes the box and saves the action. `Esc` or **Cancel** discards.

**When you actually use it:** `{clipboard:trim}` picks up whatever is copied *at that moment*. So the gesture is always the same: select the customer's name, copy it with `Ctrl+C`, and only then fire the macro. Fire it with nothing copied and the message goes out with a hole where the name should be.

> **Every app understands a different flavour.** If the message arrives showing the asterisks on screen (`*bold*` instead of bold), you sent **Markdown** (or **Discord**) to an app that doesn't parse those marks — switch to **Rich** or **Plain**. If the opposite happens and the formatting vanishes entirely, the target won't take rich text: WhatsApp wants **Markdown**, Discord wants **Discord**, Gmail and Word want **Rich**. Test it once per app you use and you're set.

That's the difference between the two: a **Snippet** is a shortcut for *writing* — it saves you retyping while you build the action; the **Send Text** action saved in the profile is what actually *runs*. One is for you, the other is for the machine.

> **If it goes wrong.** Snippets are stored in the app, not in the profile. Export the profile and open it on another machine and the message travels fine (the text lives inside the action), but the **Snippets** list shows up empty over there — it doesn't travel with export/import. Worth recreating the snippets on the new machine. The other common stumble is pressing `Enter` thinking you confirmed: it only makes a new line, and the text sits there unsaved.

---

## Variables, slots & prompts

Three ways to make one macro handle changing values instead of writing a new macro per case.

| Tool | Lives for | Read it with |
| --- | --- | --- |
| **Set Variable** | The current run (cleared when it starts). | `{var:name}` |
| **Copy to Slot** / **Capture Slot** hotkey | Until you replace it — survives between runs and restarts. | `{clip:name}` or `{clip:1}`…`{clip:9}` |
| **`{input:Label}`** | Asked once per run, then remembered for that run. | Type the token itself |

**Set Variable** *(toolbar)* — give it a **Name** and a **Value**; the value is resolved first, so it can contain `{clipboard}`, `{row:col}`, `{date}` or another `{var:}`. Storing an empty value deletes the variable. Switch the mode to **Cycle** and the value becomes a list (one item per line): each run stores the **next** line and wraps at the end, so a hotkey walks the list one item per press. Right-click the row → **Reset row position** to start over at item 1.

**Copy to Slot** *(toolbar)* — copies whatever is **selected** in the focused app into a named slot. Make sure the text is actually selected first (a `Ctrl+A` keystroke just before it, for example). A failed grab leaves the previous value untouched rather than wiping it.

**Capture Slot** *(hotkey)* — the by-hand version: Settings → **Keys** → **Hotkeys** → **Capture Slot**. Each press stores the current selection into the next numbered slot, `{clip:1}` through `{clip:9}`, wrapping; a toast tells you which slot it landed in. It's ignored while a macro is running — use the **Copy to Slot** action there instead.

**`{input:Label}`** — pauses the run and asks you for the value: `{input:Order number}` shows a text box, `{input:Priority|menu:Low,Medium,High}` shows a pick-list. You're asked once per label per run; cancelling the prompt stops the run.

**`{counter}`** — the current loop iteration number, handy for numbering output.

> **Seeing what's set.** Press **`Ctrl+K`** → **Toggle Live Variables** to open a small card that shows every variable, every slot and the current data row *while the macro runs* — the quickest way to debug a token that resolves to nothing.

### Worked example — collecting three scattered values

**The situation.** To close an order you need to send one message containing three values that live on three different screens: the customer's name in the ticket, the order number in the admin panel, and the delivery code on the supplier's page. Copying them one at a time means three round trips between windows — and getting the order wrong means starting over.

**Step 1 — set the hotkey (once).** Settings → **Keys** → **Hotkeys** → **Capture Slot** → press any combo, say `Ctrl+Shift+C`. It ships empty, which means disabled.

**Step 2 — collect the three values.** Just select and press; no pasting anywhere:

1. Select the customer's name → `Ctrl+Shift+C`. A toast reads *Selection captured → {clip:1}*.
2. Select the order number → `Ctrl+Shift+C` → becomes `{clip:2}`.
3. Select the delivery code → `Ctrl+Shift+C` → becomes `{clip:3}`.

**Step 3 — write the message once.** Make a profile with one **Send Text** action:

```
Hi {clip:1}, your order {clip:2} has shipped!
Delivery code: {clip:3}
Any questions, just ask. {enter}
```

Give that profile a hotkey (right-click the profile → **Assign hotkey…**) and you're done: three taps to collect, one to send.

> Slots stay put from one run to the next: collect the three values now and run the macro a while later. They only change when you record something over them — but they are gone once you **close the app**.

**An alternative path — when the values are always in the same place.** Then you can automate the collecting too, and the three steps above stop being necessary: instead of the hotkey, use the **Copy to Slot** action inside the macro, with a name instead of a number:

1. A click (or a `Ctrl+A`) that leaves the text **selected**.
2. Toolbar → **Copy to Slot** → in **Slot**, type `order`.
3. Later on, use `{clip:order}`.

That's the difference between the two: the **hotkey** is for when *you* pick what to copy, on the spot; the **action** is for when the macro always finds the value in the same corner of the screen — and it's the only one that works *during* a run, since the hotkey is blocked while a macro is playing.

> **The numbers carry on from where they stopped.** The counter doesn't reset to 1 on its own: if you already captured two things today, the next one lands in `{clip:3}`, not `{clip:1}`. The toast always tells you where it landed — and **`Ctrl+K`** → **Toggle Live Variables** shows the whole list. When in doubt, capture all three in one go, in order, and use the numbers the toasts report.

> **If it goes wrong — a slot came back empty.** Both of them copy by sending a `Ctrl+C` to the focused app, so **the text has to be selected** first. If nothing is copied, the slot keeps its previous value (it never goes blank) and the hotkey's counter **does not advance** — just select properly and press again, without worrying that you skipped a number.

---

## Data Loop

Run the whole profile once for **each row** of a table — mail-merge style. Paste rows from Excel or a CSV, and every column header becomes a `{row:column}` token you drop into text, keystrokes or browser fields.

Open it from the **toolbar** (the table icon → *Data Loop*). The table is saved **inside the profile**, so it travels with export/import — a large table grows the profile file.

### Getting data in

- **Paste from Excel / Sheets** — **Paste / bulk edit…**, drop a copied range into the box, and pick **Replace table** or **Append rows**. Tabs, quotes and multi-line cells survive the paste. **First row is the header** turns the top line into column names (off → columns become `col1…colN` and every line is data).
- **Import CSV** — **Import CSV…** loads a `.csv` / `.tsv` / `.txt` file; the delimiter is auto-detected (comma, semicolon — as Brazilian Excel writes — or tab).
- **Edit in place** — click any cell to edit it; **Add row** / **Add column**, duplicate or delete rows, and the header **⋯** menu inserts / moves / renames / deletes columns. `Ctrl+Z` undoes the last grid change.
- **Copy back out** — **Copy table (TSV)** puts the whole grid on the clipboard to paste straight into Excel/Sheets. **Clear table…** empties it (saving an empty grid removes the table from the profile).

### Headers → tokens

Every column header becomes a token you can paste into **Insert Text**, a **Keystroke** key, or **Browser Type**:

| Token | Resolves to |
| --- | --- |
| `{row:column}` | The current row's value in that **column** (lookup is case-insensitive). |
| `{row}` | The current **row number** (1-based). |

- Copy a token from the **Columns · tokens** rail (click the chip) or the header **⋯** menu. The rail also shows how many actions use each column (`×N` / *unused*), and flags **orphans** — a `{row:…}` an action references but the table has no such column (it types empty text).
- Headers must be **letters, digits or `_`** to work as tokens. An invalid header is flagged ⚠; click the **wand** to auto-fix it (it still saves either way).
- A missing cell — or a `{row:column}` with no matching header — resolves to **empty text**, never an error. With duplicate columns, the **last** one wins.

### Running over the data

The **Loop over data** toggle decides how the table drives replay:

| Mode | Behavior |
| --- | --- |
| **Loop over data ON** | One **full run per row** — an N-row table = N iterations. **Overrides** the profile's Loop count *and* a While-Pressed / Toggle infinite replay. Replay **refuses to start** if the table has no rows. |
| **Loop over data OFF** (*cursor*) | Each replay uses the **next row** and advances, **wrapping** back to the top at the end — good for "process one record per hotkey press". Right-click any row → **Reset row position** to start over at row 1. **Notify on list complete** (rail checkbox, on by default) chimes when a run uses the **last** row, so the wrap isn't silent. |

> The row is chosen **once per run**, so a profile with its own inner Loop count repeats the *same* row that many times before moving to the next.

### Skip on error (loop-over-data only)

When looping over data, **On row error** decides what a failed row does:

| Policy | Behavior |
| --- | --- |
| **Halt** *(default)* | Stop the replay on the first row that errors. |
| **Skip row** | Log the failed row, release anything it left held, and continue with the next row. A one-line summary at the end reports how many rows were skipped (and the first reason). |

### Cell transforms — `{row:column:mods}`

A `{row:column}` token accepts the **same modifier chain as `{clipboard}`** (see [Send Text](#send-text)) — append the modifiers after the column name, e.g. `{row:name:trim:upper}`. Click a `{row:…}` chip inside a text editor to configure them in a popover with a live preview of the first row's value, or type the chain by hand. The pipeline runs in a fixed order: **trim → list ops (range / lines / sort / dedupe / reverse / join) → extract (line / word) → limit (first / last) → case (upper / lower / sentence / title)**.

### Run a sub-profile once per row

A **Run Profile** action can tick **Run once per data row**: the *called* profile runs once per
row of **its own** Data table, with `{row:column}` resolving from that row — so a parent macro
can do its setup once, then batch a sub-profile over a list mid-run (Repeat is ignored while
this is on). If the called profile's table opts into **Skip row**, failed rows are skipped and
summarized exactly like a top-level data loop; with no table, the sub-profile just runs once.

### Worked example — registering a list of products in a form

**The situation.** Every week a spreadsheet lands with 40-odd new products to register in a web system. It's always the same clicks: open the form, type the name, type the price, save. Only the typing changes. Doing it 40 times by hand eats an afternoon — and that's where the typos come from.

**Step 1 — build the macro for ONE product.** Record (or assemble) the actions normally, actually typing the name and price of some product. Test it until one run goes through cleanly. That's your template.

**Step 2 — bring in the spreadsheet.** Toolbar → table icon (**Data Loop**) → **Paste / bulk edit…**. Copy the range in Excel, drop it in the box, leave **First row is the header** ticked and click **Replace table**:

| product | price |
| --- | --- |
| HDMI cable 2m | 39.90 |
| Wireless mouse | 89.00 |
| ABNT2 keyboard | 129.90 |

Headers only become tokens if they're letters, digits or `_` — no accents, no spaces. A header that breaks the rule gets a ⚠ right in the paste preview (it still saves — it just won't work as a token). The **wand** that renames it in one click lives afterwards, in the right-hand **Columns · tokens** list.

**Step 3 — swap the fixed values for tokens.** In the **Columns · tokens** rail, click the `{row:product}` chip to copy it. Open the **Send Text** action that typed the name, delete the fixed text and paste the token in its place. Do the same with `{row:price}`. Then check the rail: each column should read `×1` instead of *unused*.

**Step 4 — turn the loop on.** Tick **Loop over data**, set **On row error** → **Skip row**, and click **Save**. Done: one hotkey press registers the whole spreadsheet, and if one product fails it gets logged and the macro moves on to the next (a line at the end reports how many rows were skipped, and the first reason).

> With **Loop over data** on, the table is in charge: it **overrides** the profile's **Loops** count (Settings → Profile → Execution → **Loops**) and a While-Pressed / Toggle infinite replay too — 40 rows = 40 runs, no more, no less. And if the table is empty, replay **won't even start**: you get *The data table has no rows*.

That's the difference between the two modes: with **Loop over data** on, the macro chews through the whole list in one go; with it off, each hotkey press handles **one** row and advances, and after the last one it starts again at the first — that's for working item by item, at your own pace.

> **If it goes wrong.** The usual mix-up: the table is right there, the macro runs… and registers **one product only**. That means **Loop over data** is unticked — not a bug, it's cursor mode, which walks one row per run. To tell which mode you're in, look at the right-hand rail: on, it shows a coloured notice *"N iterations — one full run per row"* and the **On row error** control appears; off, it reads *"Cursor mode: each run uses the next row and advances (wrapping). Right-click a row → Reset row position to start over."* — that **Reset row position** is how you send the list back to row 1. And **Notify on list complete** shows up where **On row error** used to be — it only appears once the table has more than one row.

### Worked example — the same ending in twenty macros

**The situation.** You have twenty support macros and they all end the same way: click **Confirm**, wait for the toast to clear, press `Esc`, go back to the list. Right now those five steps are copy-pasted into all twenty. When the site moved that button, you spent an afternoon fixing macro by macro — and still missed two.

**Step 1 — pull the shared block into its own profile.** You don't have to re-record anything: open one of the macros, select the five repeated rows and use **`Ctrl+K`** → **Copy as Table**. Create a new profile called `Confirm` and, inside it, **`Ctrl+K`** → **Paste Actions**. It needs no hotkey: nobody will trigger it by hand, it exists to be called by the others.

**Step 2 — call it from each macro.** Open the first macro, select the row where the block used to start, then toolbar → **Run Profile**. In the dialog:

1. Under **Profile to run**, pick `Confirm`.
2. Leave **Repeat** at `1` (the normal case — the caption beside the stepper reads *time per call*, and accepts 1–999).
3. **Add**.

**Step 3 — delete the duplicated steps.** Now select the five old rows and delete them. The macro gets shorter, and the confirmation block lives in exactly one place.

| Macro | Before | After |
| --- | --- | --- |
| `New order` | 12 steps (5 confirming) | 7 steps + **Run Profile** `Confirm` |
| `Exchange` | 9 steps (5 confirming) | 4 steps + **Run Profile** `Confirm` |
| `Refund` | 15 steps (5 confirming) | 10 steps + **Run Profile** `Confirm` |

Repeat across all twenty. Next time that button moves, you fix `Confirm` once and all twenty get better together.

> **The sub-profile doesn't control its own repetition.** The **Loops** and **Interval** set inside `Confirm` are ignored when another profile calls it — only the **Repeat** in the **Run Profile** dialog applies. If you want the block to run three times, put `3` in the caller's **Repeat**, not in the callee's **Loops**.

When the sub-profile has a data table of its own, there's **Run once per data row**: it runs once for every row of *its* table, with `{row:column}` pulling from that row. That's the difference between the two: **Repeat** runs the identical block N times; **Run once per data row** runs it once per row, with different values each time. Ticking the box greys out **Repeat** — it stops applying entirely.

Worth knowing too: disabled profiles don't show up in the **Profile to run** list (they'd be skipped at run time anyway, so they're hidden from the choice) — the one exception is editing an existing action whose target was disabled after the fact, where it stays visible so you can see what's stored. A profile also can't call itself or anything already in the chain, and the chain stops at 5 levels counting the macro you triggered — meaning four nested sub-profiles. In every one of those cases the action is **simply skipped, with no message on screen**: only the session log records it.

> **If it goes wrong.** The profile you want to call isn't in the **Profile to run** list? Nine times out of ten it's **disabled** — a disabled profile drops out of the picker, because it would be skipped at run time anyway. And it's an easy trap right here: since `Confirm` needs no hotkey, it's tempting to switch it off to keep it out of the way. Re-enable the profile and it's back in the list.

---

## Browser automation

Drive Google Chrome by **CSS selector** instead of screen coordinates — robust against layout shifts. Requires the **TrueReplayer Chrome extension** to be connected (browser menu items are disabled until it is). See the **[extension setup guide](https://github.com/fatalihue/TrueReplayer-releases/blob/main/docs/extension-setup/README.md)** to install it.

| Action | What it does |
| --- | --- |
| **Browser Click / Right Click** | Click an element by selector — or by visible **text** (Exact / Contains / Regex). |
| **Browser Type** | Type into a field, with the same token/clipboard support as Send Text, plus *paste vs type* and a per-character delay. |
| **Navigate** | Open a URL; optionally wait until the URL matches a pattern and/or an element appears. |
| **Wait Element** | Pause until an element appears (or disappears). |
| **Assert Element** | Check a page is in the expected state and stop the run (or carry on) if it isn't — a guard, not a wait. |
| **Select Option** | Choose an option in a native `<select>` by text, value or index. |

A **selector quality** badge (S → C) hints how stable each captured selector is likely to be.

---

## Themes & appearance

Open the **Theme Editor** from Settings → App → Interface → *Customise*.

<p align="center">
  <img src="img/theme.png" width="820" alt="The Theme Editor presets tab with a live preview" /><br>
  <sub><i>40+ presets, with a live preview that updates as you edit.</i></sub>
</p>

- **Presets** — 40+ curated themes grouped by hue; click to apply. The default is *Lavender Coal* (dark).
- **Colors** — fine-tune all 15 theme colors via picker, hex or HSL; a contrast checker flags low-contrast text.
- **Appearance** — adjust **font size, border radius, row height, zoom**, the per-action pill colors, and an optional **match-system (dark/light)** auto-switch.
- **Import / Export** — share a theme as JSON.
- **Animations** — a master toggle to disable transitions (accessibility / low-end hardware).

---

## Settings reference

The Settings panel (right side) has three tabs; everything **auto-saves** (no Save button). Collapse it to a slim icon rail to reclaim space.

**Profile tab** (per profile / mode):
- **Execution** — Delay, Loops, Interval, Jitter (Macro mode).
- **Game Mode** — Smooth movement + Fast approach (and their knobs).
- **Recording** — the capture filters + **Profile Keys** master switch + Browser selector capture.
- **Clicker** — replaces Execution/Game Mode/Recording while in Clicker mode.

**Keys tab** (everything that intercepts a key):
- **Hotkeys** — Recording, Replay, Profile Keys, Foreground, Mode toggle, [Capture Slot](#variables-slots--prompts). Defaults: Record `Ctrl+PageUp`, Replay `Ctrl+PageDown`, Profile-keys `Pause`, Foreground `Insert`, Mode `ScrollLock`, Capture Slot empty (disabled).
- **Clicker** — the Clicker Start/Pause hotkeys (`PageDown` / `PageUp`); they only fire in Clicker mode.
- **Key Remaps** — the always-on remap layer (master switch + the remap list; see [Key Remaps](#key-remaps)).

**App tab** (app-wide):
- **Window** — Always on top, Minimize to tray.
- **Startup** — Run on Startup, Startup Minimized, Run as Administrator.
- **Notifications** — flash / sound when a replay ends while the window is in the background.
- **Automation** — the Automations master switch + the panel opener.
- **Interface** — opens the Theme Editor; tooltip language: **Português (BR)** or English (names and menus stay in English; only tooltips localize).
- The tab's **footer** shows the running version and a manual **Check for Updates** (it also auto-checks on launch).

---

## Where your data lives

- **Profiles:** `Documents\TrueReplayer\Profiles\*.json`
- **App settings:** `appsettings.json` under the app's local data.
- **Reference images, themes, WebView2 data:** `%LocalAppData%\TrueReplayer\…` — pinned here so it **survives auto-updates**.

---

## Troubleshooting

**A hotkey / replay doesn't fire.**
Check: the profile's **window target** matches the foreground app; the **Profile Keys** master switch (`Pause`) is on; the profile isn't **disabled**; and (for elevated target apps) that TrueReplayer runs **as administrator** (Settings → App → Startup).

**Clicks land in the wrong place after the window moved.**
Enable a **window target** + **relative coordinates** for that profile, then **Convert to Relative**.

**Clicks fire twice.**
**Focus-click** is enabled on those rows (a focus icon shows on the pill). Turn it off unless the target is a small text field that needs it; never use it on buttons.

**A game ignores the clicks.**
Keep **Game mode** on (smooth movement). If a specific game still misclicks, try turning **Fast approach** off, or lowering **Path step** px.

**My automation never fires.**
Saving an automation doesn't start it — flip its **Armed** toggle in the list. Also check the **Enable Automations** master switch, and remember a fire is skipped while a replay is running, a dialog is open, or the grid has unsaved edits.

**A sub-profile ignores its own Loops.**
That's by design: only the **Repeat** count in the *Run Profile* dialog applies. Put the repetition in the parent, or use a data table.

**A recorded step went to the wrong place.**
Recording inserts **before the first selected row**. Click empty space to clear the selection if you meant to append to the end.

**A token typed nothing.**
It resolved to empty — a `{row:column}` whose column doesn't exist, or a `{var:}` that was never set, both resolve to empty text rather than erroring. Press **`Ctrl+K`** → **Toggle Live Variables** and run it again to see what's actually set.

**The UI doesn't load.**
Install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — the app prompts for it on first run if it's missing.

---

<div align="center">

[← Back to README](../README.en.md) &nbsp;·&nbsp; [Português (BR)](GUIDE.md)

</div>
