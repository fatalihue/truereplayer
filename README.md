<p align="center">
  <img src="TrueReplayer.ico" width="80" />
</p>

<h1 align="center">TrueReplayer</h1>

<p align="center">
  A modern macro recorder and replayer for Windows built with WinUI 3.<br/>
  Record mouse clicks, keyboard inputs, scroll actions, and browser elements — then replay them with precision.
</p>

<p align="center">
  <a href="https://github.com/fatalihue/TrueReplayer-releases/releases/latest">
    <img src="https://img.shields.io/github/v/release/fatalihue/TrueReplayer-releases?style=flat-square&color=60CDFF" alt="Latest Release" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/.NET-8.0-512BD4?style=flat-square" alt=".NET 8" />
</p>

---

![Main Window](Image%20App/TrueReplayerNew.png)

## Download

<a href="https://github.com/fatalihue/TrueReplayer-releases/releases/latest">
  <img src="https://img.shields.io/badge/Download-Latest%20Release-60CDFF?style=for-the-badge&logo=windows" alt="Download" />
</a>

**Installer** — Run `TrueReplayer-win-Setup.exe` for automatic installation with auto-updates.

**Portable** — Extract `TrueReplayer-win-Portable.zip` and run `TrueReplayer.exe` — no installation needed.

**Chrome Extension** — Download `TrueReplayer-ChromeExtension-1.1.0.zip`, extract it, then load unpacked in `chrome://extensions` (enable Developer mode).

> **Requires:** Windows 10 (1809) or later — x64

---

## Features

### Recording & Replay

- **Mouse clicks** — Left, right, and middle button (press and release captured separately)
- **Mouse scroll** — Scroll up and down events
- **Keyboard** — All keys including modifiers, function keys, numpad, and symbols
- **Delays** — Capture real timing between actions or use a fixed delay
- **Raw Input support** — Works with games that use Raw Input (e.g., Roblox)
- **Insert mode** — Click any row to record new actions at that position
- **Looping** — Set a repeat count (or infinite) with optional delay between iterations
- **Live highlighting** — Current action highlights during replay with auto-scroll
- **Replay progress** — Status bar shows action counter, progress bar, and elapsed timer

### Action Table

- **Inline editing** — Double-click any cell to edit delay, coordinates, key, or notes
- **Sheet panel** — Double-click a row to open a detailed side panel editor
- **Drag & drop reordering** — Drag grip handles to reorder; supports multi-row drag
- **Multi-selection** — Ctrl+click, Shift+click, or Ctrl+A to select multiple rows
- **Bulk operations** — Set delay, duplicate, or delete all selected actions at once
- **Column visibility** — Show or hide Action, Key, X, Y, Delay, Notes columns from the toolbar
- **Color-coded actions** — Each action type (mouse, key, scroll, browser, text, image) has a distinct color pill

### Send Text

Insert blocks of text as typed keystrokes with special capabilities:

- **Emoji picker** — Search and insert any emoji
- **Dynamic variables** — `{clipboard}`, `{date}`, `{time}`, `{datetime}`
- **Special keys** — `{enter}`, `{tab}`, `{backspace}`
- **Snippets** — Save and reuse frequently used text blocks

![Send Text](Image%20App/TrueReplayer3.png)

### Browser Automation (Chrome Extension)

Automate web interactions using CSS selectors instead of screen coordinates:

- **Browser Left Click / Right Click** — Click elements by CSS selector or visible text
- **Browser Input Text** — Type into input fields with `{clipboard}`, `{date}`, `{time}`, `{datetime}` placeholders
- **Browser Wait** — Wait for an element to appear before proceeding
- **Browser Navigate** — Open a URL in the current tab or a new tab
- **Pick Element** — Visual element picker with blue highlights — click to capture the CSS selector
- **Text Match** — Match elements by visible text (e.g., "Submit") as an alternative to CSS selectors
- **Auto-detect inputs** — Recording automatically creates Input Text actions when clicking input fields
- **Alarm-based reconnect** — Extension reconnects reliably even after Chrome idles for a long time

### Profiles

Organize macros into reusable profiles stored as JSON files:

- **Hotkeys** — Assign a keyboard shortcut to instantly load and replay a profile
- **Hotstrings** — Type a trigger sequence to auto-execute a profile (instant or terminator mode)
- **Window targeting** — Restrict a profile hotkey to fire only when a specific window is active (by process name or window title with Contains/Regex matching)
- **Click-to-detect** — Click on any window to set it as the target
- **Search & filter** — Find profiles by name instantly
- **Import & Export** — Share profiles as `.trprofile` files with conflict resolution

### Command Palette

Press **Ctrl+K** to open a fuzzy search overlay across:

- All commands and actions
- Profile names
- Settings and options

### Theme Editor

Personalize the interface with 14 built-in presets or fully custom colors:

- **Presets** — Midnight, Carbon, Amethyst, Emerald, Rose, Ocean, Amber, Slate, Nord, Dracula, Monokai, Copper, Sakura, Neon
- **Custom colors** — Accent, semantic (recording red, replay green), action type pill colors
- **Mono font selector** — Choose between Consolas, Cascadia Mono, Cascadia Code, Courier New, Lucida Console
- **Import & Export** — Share custom themes as JSON

![Theme Editor](Image%20App/TrueReplayer2.png)

### Settings

| Section | Options |
|---------|---------|
| **Execution** | Fixed delay (ms), loop count, loop delay |
| **Recording** | Toggle mouse clicks, scroll, keyboard, profile keys, browser actions |
| **Hotkeys** | Recording, replay, profile keys toggle, bring-to-front |
| **Window** | Always on top, system tray, run on startup, startup minimized |
| **Updates** | Auto-check and manual check for updates |

### Additional

- **Auto-updates** — Built-in update system checks for new versions automatically
- **Multi-monitor support** — Coordinates work across all displays
- **Clipboard integration** — `{clipboard}` reads current clipboard content at replay time
- **Unsaved changes guard** — Prompts to save before closing or switching profiles
- **Toast notifications** — Success, error, and info messages with stacked queue
- **Minimize to tray** — Keeps the app running in the background
- **Self-contained** — No .NET installation required; everything is bundled

## Default Hotkeys

| Action | Default Key |
|--------|-------------|
| Start/Stop Recording | `Ctrl+PageUp` |
| Start/Stop Replay | `Ctrl+PageDown` |
| Toggle Profile Keys | `Pause` |
| Bring to Foreground | `Ctrl+Insert` |
| Command Palette | `Ctrl+K` |

All hotkeys can be changed in the **Hotkeys** section of Global settings.
