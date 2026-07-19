<div align="center">

<img src="Assets/Square150x150Logo.png" width="104" alt="TrueReplayer logo" />

# TrueReplayer

**Record what you do. Replay it any time — on demand or with a hotkey.**

A fast, lightweight **macro recorder & automation tool for Windows**. Capture your mouse clicks, key presses and scrolls, then play them back perfectly — or go further with waits, conditions, text injection, a built-in auto-clicker, and input that real games actually accept.

[![Latest release](https://img.shields.io/github/v/release/fatalihue/TrueReplayer-releases?style=flat-square&color=60CDFF&label=download)](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011%20(x64)-0078D4?style=flat-square&logo=windows)](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)
![Built with .NET 8 + React](https://img.shields.io/badge/built%20with-.NET%208%20%C2%B7%20React-6bcb77?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-9b8cff?style=flat-square)](LICENSE)

[Português (BR)](README.md) · **English**

</div>

<p align="center">
  <img src="docs/img/main.png" width="860" alt="TrueReplayer main window — a profile's action list with the profiles panel on the left and settings on the right" />
</p>

---

## Contents

- [What is TrueReplayer?](#what-is-truereplayer)
- [Features](#features)
- [Download & install](#download--install)
- [Quick start](#quick-start)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Full guide](#full-guide)
- [FAQ](#faq)
- [Built with](#built-with)
- [License](#license)

---

## What is TrueReplayer?

TrueReplayer records your real input — every click, keystroke and scroll — and plays it back exactly, as many times as you want. Bind a macro to a **hotkey** and it fires even while another app is focused. Organize your macros into **profiles and colored folders**, then make them smart: add pauses, wait for an image or a pixel color to appear, type text, run another macro, or branch with **IF conditions**.

It sends input the way real apps and **games** expect (tested in Roblox and others), runs as a tiny native Windows app, and **updates itself** automatically.

---

## Features

### 🎬 Record & replay
- **One-tap recording** — press **`Ctrl+PageUp`** (or the Recording button), do your thing, press again to stop.
- **Pixel-perfect playback** — replay with **`Ctrl+PageDown`**, with full control over **delay, loops** (0 = forever), **interval** between loops, and **jitter** (random ± variation so it's not robotic).
- **Capture filters** — record only what you want: mouse clicks, scroll, keyboard — together or separately.
- **Editable action grid** — every step is a row you can reorder (drag or `Alt+↑/↓`), edit inline, duplicate, skip, or bulk-edit.

### ⌨️ Triggers
- **Hotkeys** — bind any key combo to a profile; it fires globally, even over other apps.
- **Hotstrings** — type a short text trigger (e.g. `qqsig`) and a macro runs.
- **6 trigger modes** — *On Press*, *On Release*, *While Pressed* (autofire while held), *Toggle* (on/off), *Double-tap* and *Hold* (long-press, ~0.6 s). Mouse side buttons work as hotkeys too.

### 🧩 Smart steps — beyond plain recording
- **Pause** — wait for a hotkey or a timeout before continuing.
- **Wait for Image / Pixel Color** — block until something appears on screen (great for syncing with slower apps).
- **Send Text** — paste rich text with tokens like `{enter}`, `{tab}`, `{clipboard}`, dates, saved snippets and clipboard transforms.
- **Run Profile** — call another macro as a sub-step and build modular, reusable automations.
- **Variables, slots & prompts** — remember a value with `{var:name}`, keep several clipboards with `{clip:name}`, or have the macro ask you for a value mid-run with `{input:Label}`.
- **Conditionals (If / Else / EndIf)** — branch on ten checks: image found, pixel color, window open, clipboard, browser element, a variable, a running process, a file, the time of day, or a random chance; supports *IFNOT*, nesting, and an optional per-condition timeout (wait for the condition, then branch).
- **Browser actions** — drive Chrome by CSS selector (Click, Type, Navigate, Wait for element, Select option) via the [companion Chrome extension](https://github.com/fatalihue/TrueReplayer-releases/blob/main/docs/extension-setup/README.md).

<p align="center">
  <img src="docs/img/conditionals.png" width="760" alt="An If/Else/EndIf conditional block in the action grid" /><br>
  <sub><i>If / Else / EndIf blocks branch on what's on screen — an image being found, or a pixel color matching.</i></sub>
</p>

### 🖱️ Built-in auto-clicker
A dedicated **Clicker mode** (switch with **`ScrollLock`**) for fast, steady clicking: pick the button, set a rate (clicks/sec or delay), add random jitter, restrict it to a screen region, and watch **live stats** (count, rate, elapsed, ETA, loop progress).

<p align="center">
  <img src="docs/img/clicker.png" width="760" alt="The Clicker mode live dashboard with click count, rate and progress" /><br>
  <sub><i>The Clicker dashboard — live count, rate, elapsed time, loop progress and ETA.</i></sub>
</p>

### 🎮 Game mode
- **Smooth movement** — moves the cursor along a path instead of teleporting, so games (e.g. Roblox) that reject single jumps accept the clicks.
- **Fast approach** — teleports most of the way and only "settles" the last stretch smoothly, so far clicks stay fast.
- **Focus-click** — an opt-in double-tap for tiny text fields that need a second click to take focus.

### 🎯 Window targeting
- Bind a profile to a **specific window** so its hotkey only fires there.
- **Relative coordinates** — clicks anchor to the window's top-left, so the macro keeps working when the window moves or resizes.
- **Bring to focus / restore position & size** before replay for reproducible runs.

### 🎨 Make it yours
- **40+ built-in themes** plus a full **Theme Editor** (colors, fonts, row height, per-action colors; export/import themes as JSON).
- **Profiles & folders** with icons, descriptions, tags and colors.
- **Bilingual tooltips** — English or **Português (BR)** (Settings → App → Interface).
- **Import / export** profiles as portable `.trprofile` files (includes reference images and organization).

<p align="center">
  <img src="docs/img/theme.png" width="820" alt="The Theme Editor with 40+ presets and a live preview" /><br>
  <sub><i>The Theme Editor — 40+ presets with a live preview, plus full color &amp; layout control.</i></sub>
</p>

---

## Download & install

1. Download the latest **`TrueReplayer-win-Setup.exe`** from the **[Releases page](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)**.
2. Run it — it installs in seconds and pins to your Start menu.
3. That's it. TrueReplayer **checks for updates on launch** and updates itself in the background (delta updates, usually a few MB).

> **Requirements:** Windows 10 or 11 (64-bit). The [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) powers the UI — it ships with modern Windows, and the app offers to install it if it's missing.

---

## Quick start

1. **Record** — press **`Ctrl+PageUp`**, perform your actions, press it again to stop.
2. **Replay** — press **`Ctrl+PageDown`** (or click **Replay**) to play it back.
3. **Save** — click **Save** and give it a name.
4. **Assign a hotkey** — right-click the profile → **Assign hotkey**, pick a combo and a trigger mode. Now it runs any time you press it.

That's all you need. Everything else — waits, conditions, the auto-clicker, themes — is there when you want it.

---

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Start / stop **recording** | `Ctrl+PageUp` |
| Start / stop **replay** | `Ctrl+PageDown` |
| Switch **Macro ↔ Clicker** mode | `ScrollLock` (or `Ctrl+ScrollLock`) |
| Start / stop the **clicker** | `PageDown` |
| Pause / resume the **clicker** | `PageUp` |
| Enable / disable **profile hotkeys** | `Pause` |
| Bring the app **to the front** | `Insert` |
| **Command palette** | `Ctrl+K` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Save profile | `Ctrl+S` |
| Move selected rows up / down | `Alt+↑` / `Alt+↓` |
| Delete selected rows | `Delete` |

> All hotkeys (record, replay, mode, etc.) are configurable in **Settings → Keys → Hotkeys**. The defaults are shown above.

---

## Full guide

The complete reference — every action type, conditionals, the clicker, game mode, window targeting, Send Text tokens, browser automation, themes and settings — lives in the guide:

📖 **[docs/GUIDE.en.md](docs/GUIDE.en.md)** &nbsp;·&nbsp; 📖 **[Guia completo em Português](docs/GUIDE.md)**

Prefer to learn by doing? Start with **[Recipes](docs/GUIDE.en.md#recipes--learn-by-doing)** — fourteen short, real tasks (a canned reply, waiting for the screen, filling a form from a list), each one a few steps long.

---

## FAQ

**Does it work in games?**
Yes — it sends real input via `SendInput`, with optional *Game mode* (smooth movement) for engines like Roblox that reject teleported cursors. Toggle it off for normal apps that don't need it.

**Where are my profiles stored?**
Profiles are `.json` files under `Documents\TrueReplayer\Profiles`. App settings, themes, reference images and WebView2 data live under `%LocalAppData%\TrueReplayer` (this survives updates).

**Can I share a macro?**
Yes — select profiles → **Export** to a `.trprofile` file (it bundles actions, metadata and reference images). The other person **Imports** it, with conflict resolution for name clashes.

**My clicks are duplicating / firing twice.**
Check whether **Focus-click** is enabled on those click rows (a small focus icon shows on the action pill). It's an opt-in that deliberately clicks twice to focus tiny text fields — turn it off (row right-click → *Focus click*) unless you need it, and never use it on buttons.

---

## Built with

- **Host:** WinUI 3 (.NET 8) + WebView2 — a tiny native Windows shell.
- **UI:** React + TypeScript + Vite + Tailwind, rendered in WebView2.
- **Engine:** C# / .NET 8 using native Windows input APIs (`SendInput`, low-level hooks).
- **Updates:** [Velopack](https://velopack.io) (delta auto-updates).

Two repositories:
- **Code** — [`fatalihue/truereplayer`](https://github.com/fatalihue/truereplayer)
- **Releases** (auto-update source) — [`fatalihue/TrueReplayer-releases`](https://github.com/fatalihue/TrueReplayer-releases)

---

## License

[MIT](LICENSE) © fatalihue
