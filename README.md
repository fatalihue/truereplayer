<sub>**English** · [Português (BR)](README.pt-BR.md)</sub>

# TrueReplayer

A fast, lightweight macro recorder and replayer for Windows. Record clicks, keystrokes, and scrolls — replay them on demand or via hotkey. Supports image matching, browser automation, profile chaining, and a dedicated auto-clicker mode.

## Why TrueReplayer

- **Record once, replay anywhere** — captures real input via Windows low-level hooks
- **Profile-based** — organize macros into colored folders, assign hotkeys, bind them to specific windows
- **Beyond recording** — insert pauses, image waits, sub-macros, and browser actions manually
- **Game-friendly** — proper `SendInput` with Raw Input compatibility (works in Roblox, Unity titles, etc.)
- **Anti-detection** — randomized jitter on delays and click positions

## Install

Download the latest build from [TrueReplayer-releases](https://github.com/fatalihue/TrueReplayer-releases/releases/latest):

- `TrueReplayer-win-Setup.exe` — installer with built-in auto-updates
- `TrueReplayer-win-Portable.zip` — no-install version

Windows 10/11, x64.

## Quick start

1. Click **Recording**, perform any actions in your target app, click **Recording** again to stop
2. Click **Replay** to play it back
3. Click **Save** to store the profile, then assign a **Hotkey** for one-press triggering

That's it. For everything else — image waits, sub-macros, window targeting, hotstrings, the auto-clicker — see the tutorial below.

## Documentation

See [**TUTORIAL.md**](TUTORIAL.md) for a complete feature reference: every action type, every setting, profile options, hotkey modes, and the typical workflow.

## License

[MIT](LICENSE) © fatalihue
