<sub>**English** · [Português (BR)](TUTORIAL.pt-BR.md)</sub>

# TrueReplayer — Feature Reference

A concise tour of every action and setting. New users: read top-to-bottom (5 min). Returning users: jump via the table of contents.

## Contents
- [Execution Modes](#execution-modes)
- [Primary Buttons](#primary-buttons)
- [Keyboard Actions](#keyboard-actions)
- [Mouse Actions](#mouse-actions)
- [Wait / Flow Actions](#wait--flow-actions)
- [Browser Actions](#browser-actions)
- [Settings — Execution](#settings--execution)
- [Settings — Recording](#settings--recording)
- [Settings — Clicker](#settings--clicker)
- [Profiles](#profiles)
- [Global Hotkeys](#global-hotkeys)
- [List Editing](#list-editing)
- [Other](#other)
- [Typical first run](#typical-first-run)

---

## Execution Modes
- **Macro** — runs the recorded action list in order
- **Clicker** — repeatedly clicks at the current cursor position (ignores the action list and profiles)

## Primary Buttons
- **Recording** (red) — captures mouse clicks, keys, and scrolls live
- **Replay** (green) — runs the action list
- **Save / Load** — persist or restore profiles

---

## Keyboard Actions
- **Send Key** — types a single key (e.g. `Enter`)
- **Send Keystroke** — atomic combo (e.g. `Ctrl+Shift+T`)
- **Press Key × N** — press a key N times with a configurable interval
- **Hold Key** — keep a key pressed for X ms (e.g. hold `W` for 1.5s)
- **Send Text** — pastes text, supports tokens `{clipboard}`, `{date}`, `{time}`, `{datetime}`

## Mouse Actions
Captured automatically during Recording. Each row can be edited or duplicated afterwards.
- **LeftClick / RightClick / MiddleClick** — split into Down + Up so drag gestures work
- **ScrollUp / ScrollDown**

## Wait / Flow Actions
- **Pause** — waits for a fixed time, or until a chosen hotkey is pressed
- **Wait for Image** — searches the screen for a reference image
  - Options: timeout, confidence threshold, search region, click-on-match, invert (wait until image disappears), on-timeout behavior (halt / continue / stop)
- **Run Profile** — runs another profile as a sub-routine, with a repeat count (chains supported, with cycle detection)

## Browser Actions
Available when the [Chrome extension](ChromeExtension) is installed and connected.
- **Click Element / Right Click Element** — click a CSS selector
- **Type Text** — type into a field (append or paste mode, configurable per-char delay)
- **Select Option** — pick a `<select>` option by text, value, or index
- **Wait Element** — wait for an element to appear, disappear, become enabled, or match text
- **Open URL** — open a URL (same tab or new tab); optional URL/selector wait after load

---

## Settings — Execution
- **Delay** — fixed time between actions (ms)
- **Jitter** — random ±% variation on delay (anti-detection)
- **Loops** — how many times to repeat the macro (0 = infinite)
- **Interval** — pause between loops

## Settings — Recording
Toggle capture for: **Mouse Clicks**, **Mouse Scroll**, **Keyboard**, **Profile Keys**, **Browser Actions**.

## Settings — Clicker
Dedicated panel that replaces Execution/Recording when Clicker mode is active.
- **Button** (Left / Right / Middle)
- **Rate** (clicks per second or ms delay — toggle the unit)
- **Jitter** (±% on delay)
- **Hold** (ms the button stays pressed)
- **Position jitter** (±px around the cursor)
- **Loops** (0 = infinite)
- **Interval** (pause between loops)

---

## Profiles
- **Colored folders** to organize macros
- **Pin** to keep a profile at the top
- **Per-profile hotkey** with four trigger modes:
  - `On Press` — fires once when the key is pressed
  - `On Release` — fires once when the key is released
  - `While Pressed` — loops while held, stops on release
  - `Toggle` — press to start, press again to stop
- **Hotstring** — trigger word that launches the profile when typed anywhere
- **Window Target** — bind a profile to a specific window (process name + title, `contains` or `regex` mode); the hotkey only fires when that window is focused
- **Relative coordinates** — clicks auto-adjust to the window's current position
- **Restore position / size** — moves the target window back to recorded geometry before replay
- **Bring to focus** — focuses the target window before replay
- **Export / Import** — share profiles between machines (folders + hotkeys included)

## Global Hotkeys
Set in **Global → Hotkeys**.
- **Recording** — start/stop recording
- **Replay** — start/stop the active profile (or current actions)
- **Profile Keys** — master switch to suspend all profile hotkeys at once
- **Foreground** — diagnostic: prints the current foreground window so you can configure a target

---

## List Editing
- **Undo / Redo** — `Ctrl+Z` / `Ctrl+Y`
- **Copy / Paste** actions — `Ctrl+C` / `Ctrl+V`
- **Move Up / Down** — `Alt+↑` / `Alt+↓`
- **Bulk edit** — select multiple rows, change delay / X / Y / notes / skip state at once
- **Skip** — disable an action without deleting it (replay jumps over skipped rows)
- **Notes** — per-action comment, shown in the Notes column

## Other
- **Always On Top**, **System Tray**, **Run on Startup**, **Run as Administrator**
- **Theme Editor** — fully customizable colors
- **Toggle Columns** — show/hide table columns (Action, Key, X, Y, Delay, Notes)
- **Command Palette** — fuzzy search every command (`Ctrl+K`)
- **Auto-update** — checks the releases feed and prompts when a new build is available

---

## Typical first run

1. Click **Recording**, perform the actions in your target app, click **Recording** again to stop
2. Adjust **Delay**, **Loops**, **Jitter** to taste
3. Click **Save** and name the profile
4. (Optional) Right-click the profile → **Assign Hotkey** → pick a key + trigger mode
5. (Optional) Right-click the profile → **Set Window Target** so the hotkey only fires in that app
6. Press your hotkey to trigger the macro

## Tips

- **Game not registering clicks?** Make sure the game runs as non-admin, or check **Global → Run as Administrator** so TrueReplayer matches its privilege level.
- **Profile hotkey "doesn't work"?** Check the **Window Target → Process Name** — the actual exe name on your machine may differ from the one configured. Use **Foreground** hotkey to capture it.
- **Need anti-detection for clickers?** Turn on **Jitter** (delay) and **Position jitter** in the Clicker panel.
- **Long sequences?** Use **Run Profile** to chain reusable building blocks instead of duplicating actions.
