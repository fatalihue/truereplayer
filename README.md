<p align="center">
  <img src="TrueReplayer.ico" width="80" />
</p>

<h1 align="center">TrueReplayer</h1>

<p align="center">
  A modern macro recorder and replayer for Windows built with WinUI 3.<br/>
  Record mouse clicks, keyboard inputs, and scroll actions — then replay them with precision.
</p>

<p align="center">
  <a href="https://github.com/fatalihue/truereplayer/releases/latest">
    <img src="https://img.shields.io/github/v/release/fatalihue/truereplayer?style=flat-square&color=60CDFF" alt="Latest Release" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/.NET-8.0-512BD4?style=flat-square" alt=".NET 8" />
  <img src="https://img.shields.io/github/license/fatalihue/truereplayer?style=flat-square" alt="License" />
</p>

---

![Main Window](Image%20App/Main%20Window.png)

## Features

### Recording

- **Mouse clicks** — Left, right, and middle button (press and release captured separately)
- **Mouse scroll** — Scroll up and down events
- **Keyboard** — Key down and key up for all keys including modifiers, function keys, numpad, and symbols
- **Delays** — Capture real timing between actions (auto delay) or use a fixed delay value
- **Raw Input support** — Works with games that use Raw Input (e.g., Roblox) via a 4-step mouse simulation method
- **Insert mode** — Click any row to record new actions at that position instead of appending to the end

### Replay

- **One-click replay** — Start and stop with a hotkey or the UI button
- **Looping** — Set a repeat count (or infinite) with optional delay between iterations
- **Live highlighting** — The current action highlights during replay with auto-scroll
- **Cancellable** — Stop replay instantly at any point

### Action Table

- **Inline editing** — Double-click any cell to edit delay, coordinates, key, or notes directly
- **Drag & drop reordering** — Drag the grip handle to reorder rows; supports multi-row drag
- **Multi-selection** — Ctrl+click, Shift+click, or Ctrl+A to select multiple rows
- **Bulk operations** — Delete, or update delay for all selected actions at once
- **Color-coded actions** — Each action type has a distinct color and icon for quick identification

### Send Text

Insert blocks of text with special capabilities:

- **Emoji picker** — Search and insert any emoji
- **Dynamic variables** — `{clipboard}`, `{date}`, `{time}`, `{datetime}`
- **Special keys** — `{enter}`, `{tab}`, `{backspace}`
- **Snippets** — Save and reuse frequently used text blocks

![Send Text](Image%20App/Insert%20Text.png)

### Profiles

Organize macros into reusable profiles stored as JSON files:

- **Hotkeys** — Assign a keyboard shortcut to instantly load and replay a profile
- **Hotstrings** — Type a trigger sequence to auto-execute a profile (instant or terminator mode)
- **Window targets** — Restrict a profile hotkey to fire only when a specific window is active
- **Search** — Filter profiles by name
- **Auto-refresh** — Profile list updates automatically when files change on disk

### Import & Export

Share profiles between machines or users:

- **Export** — Select one or multiple profiles to export as `.trprofile` files
- **Import** — Load profiles with conflict resolution (overwrite, rename, or skip duplicates)

![Import & Export](Image%20App/Import%20Export.png)

### Themes

Personalize the interface with built-in theme presets or custom colors:

- **14 presets** — Midnight, Carbon, Amethyst, Emerald, Rose, Ocean, Amber, Slate, Nord, Dracula, Monokai, Copper, Sakura, Neon
- **Custom accent color** — Pick any hex color
- **Color editor** — Fine-tune individual UI colors
- **Import / Export** — Share custom themes

![Themes](Image%20App/Themes.png)

### Settings

| Section | Options |
|---------|---------|
| **Execution** | Fixed delay (ms), loop count, loop delay |
| **Recording** | Toggle mouse clicks, scroll, keyboard, profile keys |
| **Hotkeys** | Customizable hotkeys for recording, replay, profile keys toggle, and bring-to-front |
| **Window** | Always on top, minimize to system tray |

### Additional

- **Multi-monitor support** — Coordinates work across all displays using virtual desktop metrics
- **Clipboard integration** — `{clipboard}` placeholder reads current clipboard content at replay time
- **Unsaved changes guard** — Prompts to save before closing or switching profiles
- **Minimize to tray** — Keeps the app running in the background
- **Self-contained** — No .NET installation required; everything is bundled

## Download

Download the latest release from the [Releases page](https://github.com/fatalihue/truereplayer/releases/latest).

Extract the `.zip` and run `TrueReplayer.exe` — no installation needed.

> **Requires:** Windows 10 (1809) or later

## Default Hotkeys

| Action | Default Key |
|--------|-------------|
| Start/Stop Recording | `F9` |
| Start/Stop Replay | `F10` |
| Toggle Profile Keys | `Ctrl+Shift+K` |
| Bring to Foreground | `Ctrl+Shift+L` |

All hotkeys can be changed in the **Hotkeys** section of the settings panel.

## Building from Source

**Prerequisites:** .NET 8 SDK, Node.js

```bash
# Build the frontend
cd frontend && npm install && npm run build && cd ..

# Publish (x64)
dotnet publish TrueReplayer.csproj -c Release -p:PublishProfile=Properties/PublishProfiles/win-x64.pubxml
```

Output will be in `bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/`.
