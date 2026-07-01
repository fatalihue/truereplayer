<div align="center">

# TrueReplayer — User Guide

**English** · [Português (BR)](GUIDE.pt-BR.md) &nbsp;·&nbsp; [← Back to README](../README.md)

</div>

The complete reference for everything TrueReplayer can do. New here? Start with the [Quick start](../README.md#quick-start) in the README, then come back for the details.

## Contents

- [Core concepts](#core-concepts)
- [Recording](#recording)
- [Replaying & execution settings](#replaying--execution-settings)
- [The action grid](#the-action-grid)
- [Action reference](#action-reference)
- [Conditional blocks (If / Else / EndIf)](#conditional-blocks-if--else--endif)
- [Profiles & folders](#profiles--folders)
- [Hotkeys & hotstrings](#hotkeys--hotstrings)
- [Window targeting & relative coordinates](#window-targeting--relative-coordinates)
- [Clicker mode (auto-clicker)](#clicker-mode-auto-clicker)
- [Game mode](#game-mode)
- [Send Text](#send-text)
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
- **Right-click** a row for **Duplicate, Delete, Edit, Insert Else** (inside an If block), and more.
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
| **Pause** | Halt until a **resume hotkey** is pressed or a **timeout** expires (whichever comes first). Needs at least one of the two. |
| **Wait Image** | Block until a reference image appears on screen (optionally within a cropped search region; confidence default ≈ 85%). |
| **Wait Pixel Color** | Block until the pixel at `(x, y)` matches a target hex color (within tolerance). |
| **Run Profile** | Run another profile as a sub-step — optionally a set number of times. Cycles and chains deeper than 5 levels are blocked automatically. |
| **If / Else / EndIf** | Conditional branch — see [Conditional blocks](#conditional-blocks-if--else--endif). |
| **Browser actions** | Click / Type / Navigate / Wait element / Select option in Chrome — see [Browser automation](#browser-automation). |

Insert actions from the **toolbar** (Send Keystroke, Send Text, Pause, Wait, Conditional, Browser, Run Profile) or the **command palette** (`Ctrl+K`). Most actions open a small dialog to configure them; click an action's Details cell later to edit it.

> **Tip — match by colour, not confidence.** Image matching compares the whole reference, so it's great for shape/text but a blunt tool for telling apart two states that differ only in **colour** (e.g. an enabled *green* vs a disabled *grey* button). For that, use **Wait Pixel Color** (or an **If** on *Pixel Color Match*): sample a point in the solid fill and match the colour within a tolerance. Also don't set **confidence to 100%** — a live screen never reproduces a reference pixel-for-pixel, so a 100% match times out (it's capped just under 100% internally).

---

## Conditional blocks (If / Else / EndIf)

Make a macro react to what's on screen.

<p align="center">
  <img src="img/conditionals.png" width="820" alt="Two If/Else/EndIf blocks in the action grid" /><br>
  <sub><i>A negated pixel check (<code>if NOT</code>) and an image check with an <code>else</code> branch.</i></sub>
</p>

- An **If** runs a **probe**: *Image Found* (is this image visible?) or *Pixel Color Match* (does this pixel match this color?).
- If the probe is **true**, the actions between **If** and **Else/EndIf** run; if **false**, execution jumps to the **Else** branch (if present) or past the **EndIf**.
- **Negate (IFNOT)** flips the test — the *true* branch runs when the probe **fails**.
- **Wait for condition (optional)** — by default an **If** checks once and branches instantly. Set a *Wait for condition* value (ms) and it polls that long for the condition to become true before deciding: satisfied in time → **true** branch; time runs out → **Else / false**. Great for *"wait up to 3 s for the button to enable, else take a fallback path."* `0` = instant (the default).
- Blocks can be **nested** — each nesting level shows in its own colour (with matching scope rails) so deep conditionals stay readable. To create a nested block, select a row **inside** an existing block, then **Insert Conditional**. Add an **Else** via the row's *Insert Else*. The structure is validated and auto-repaired on load (orphan markers removed, missing `EndIf` added).

**Editing a block's contents** — actions *inside* a block edit granularly; an operation only snaps to the **whole block** when your selection includes a marker (*If / Else / EndIf*), so markers can never be orphaned:
- **Drag** one or more body actions freely **in or out** of a block (single, multiple, even non-contiguous).
- **Delete** body rows and the block stays — select the **If** row to delete the whole block.
- **Reorder** with **Move ↑/↓** or **`Alt+↑` / `Alt+↓`**: a body-only selection moves on its own; a selection touching a marker carries the whole block.
- **Duplicate** an **If** to copy the whole block as a sibling.
- Dragging the **If** itself (or any selection that includes a marker) always moves the whole block together.

---

## Profiles & folders

- **New / Save / Rename / Duplicate / Delete** from the Profiles panel (left) or the command palette.
- **Pin** a profile to keep it at the top; **drag** it into a **folder** to group it.
- **Folders** — create, rename, recolor, collapse. A folder can hold a default **window target** that its profiles inherit.
- **Profile info** — give a profile an **emoji icon**, **description** and **tags** (right-click → Info). Tags are searchable.
- **Search** filters the list by name or tag.
- **Import / Export** — export selected profiles to a `.trprofile` file (actions + metadata + reference images + optional folder/pin layout). Import shows a conflict-resolution screen for name clashes and a security note if the file contains auto-firing actions.

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

> Trigger modes apply to **hotkeys** only. **Hotstrings** always fire when typed.

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
- **Token chips** — each token shows as an editable chip; click it to tweak its parameters.
- **Snippets** — save reusable text under a name for quick insertion later.
- Confirm with **`Ctrl+Enter`**; `Esc` cancels.

---

## Browser automation

Drive Google Chrome by **CSS selector** instead of screen coordinates — robust against layout shifts. Requires the **TrueReplayer Chrome extension** to be connected (browser menu items are disabled until it is). See the **[extension setup guide](https://github.com/fatalihue/TrueReplayer-releases/blob/main/docs/extension-setup/README.md)** to install it.

| Action | What it does |
| --- | --- |
| **Browser Click / Right Click** | Click an element by selector — or by visible **text** (Exact / Contains / Regex). |
| **Browser Type** | Type into a field, with the same token/clipboard support as Send Text, plus *paste vs type* and a per-character delay. |
| **Navigate** | Open a URL; optionally wait until the URL matches a pattern and/or an element appears. |
| **Wait Element** | Pause until an element appears (or disappears). |
| **Select Option** | Choose an option in a native `<select>` by text, value or index. |

A **selector quality** badge (S → C) hints how stable each captured selector is likely to be.

---

## Themes & appearance

Open the **Theme Editor** from Settings → Global → Appearance → *Customise* (or `Ctrl+K` → Theme editor).

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

The Settings panel (right side) has two tabs; everything **auto-saves** (no Save button). Collapse it to a slim icon rail to reclaim space.

**Profile tab** (per profile / mode):
- **Execution** — Delay, Loops, Interval, Jitter (Macro mode).
- **Game Mode** — Smooth movement + Fast approach (and their knobs).
- **Recording** — the capture filters + **Profile Keys** master switch + Browser selector capture.
- **Clicker** — replaces Execution/Recording while in Clicker mode.

**Global tab** (app-wide):
- **Hotkeys** — Recording, Replay, Mode toggle, Foreground, and the Clicker hotkeys. Defaults: Record `Ctrl+PageUp`, Replay `Ctrl+PageDown`, Mode `ScrollLock`, Profile-keys `Pause`, Foreground `Insert`, Clicker start `PageDown`, Clicker pause `PageUp`.
- **Window** — Always on top, Minimize to tray, Run on startup, Start minimized, Run as administrator.
- **Appearance** — opens the Theme Editor.
- **Language** — tooltip language: **Português (BR)** (default) or English. Names and menus stay in English; only tooltips localize.
- **Updates** — manual "check for updates" (it also auto-checks on launch).

---

## Where your data lives

- **Profiles:** `Documents\TrueReplayer\Profiles\*.json`
- **App settings:** `appsettings.json` under the app's local data.
- **Reference images, themes, WebView2 data:** `%LocalAppData%\TrueReplayer\…` — pinned here so it **survives auto-updates**.

---

## Troubleshooting

**A hotkey / replay doesn't fire.**
Check: the profile's **window target** matches the foreground app; the **Profile Keys** master switch (`Pause`) is on; the profile isn't **disabled**; and (for elevated target apps) that TrueReplayer runs **as administrator** (Settings → Global → Window).

**Clicks land in the wrong place after the window moved.**
Enable a **window target** + **relative coordinates** for that profile, then **Convert to Relative**.

**Clicks fire twice.**
**Focus-click** is enabled on those rows (a focus icon shows on the pill). Turn it off unless the target is a small text field that needs it; never use it on buttons.

**A game ignores the clicks.**
Keep **Game mode** on (smooth movement). If a specific game still misclicks, try turning **Fast approach** off, or lowering **Path step** px.

**The UI doesn't load.**
Install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — the app prompts for it on first run if it's missing.

---

<div align="center">

[← Back to README](../README.md) &nbsp;·&nbsp; [Português (BR)](GUIDE.pt-BR.md)

</div>
