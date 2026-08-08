namespace TrueReplayer.Models
{
    // Snapshot of every Clicker setting needed to start a run. Collapses the 13-parameter
    // signature that ToggleCursorClickReplay had across 4 layers (bridge → controller →
    // engine + hotkey caller). LoopCount == 0 means infinite; null Area means "click at
    // cursor" (positionJitter still applies). Position jitter / Area / UseFixed are the three
    // mutually-exclusive "where to click" modes; the engine applies precedence Area > Fixed >
    // cursor. UseFixed with a FixedPoint clicks exactly there; UseFixed with a null FixedPoint
    // locks to the cursor position captured on the first click ("lock on start").
    public sealed record ClickerRunConfig(
        int DelayMs,
        bool UseJitter,
        int JitterPercent,
        int LoopCount,
        int LoopIntervalMs,
        string Button,
        int HoldMs,
        int PositionJitter,
        ClickArea? Area,
        bool UseFixed,
        ClickPoint? FixedPoint,
        // Wall-clock cap in ms; 0 = unbounded. Independent of LoopCount — whichever limit
        // is reached first ends the run, and both may be unset.
        int MaxDurationMs,
        // Route cursor moves through the macro engine's interpolated path (SetCursorPos +
        // per-step move INPUTs, with the fast-approach teleport) instead of a single jump.
        // Opt-in: it costs real time inside the tick, so it must never be inherited silently
        // from the macro Game Mode toggle.
        bool GameMove)
    {
        // Fallback for the hotkey paths, used only when the bridge isn't up yet. Exists so the
        // shape lives in ONE place: the two hotkey call sites in MainWindow each carried their
        // own hand-written positional literal, and both had already drifted — they pinned
        // LoopCount to 1 (a single click), which stopped matching the engine's convention once
        // "no explicit limit" became unbounded.
        public static ClickerRunConfig Default { get; } =
            new(100, false, 0, 0, 0, "Left", 10, 0, null, false, null, 0, false);
    }

    // Snapshot of the macro loop settings for one replay start. Built by
    // WebViewBridge.BuildLoopConfig, which is the ONLY place allowed to decide whether a run
    // takes its numbers from the loaded profile or from the "No Profile" global fallback.
    // Count is already clamped to 1..999 — unlike ClickerRunConfig above, 0 is NOT infinite
    // here and cannot be produced. An infinite macro run comes exclusively from the separate
    // forceInfiniteLoop boolean (WhilePressed / Toggle trigger modes), which never round-trips
    // through a profile field. Strings, not ints, because the whole ToggleReplay chain
    // downstream is string-typed.
    public sealed record LoopRunConfig(
        bool Enabled,
        string Count,
        bool IntervalEnabled,
        string Interval);

    public sealed record ClickArea(int X, int Y, int W, int H);

    public sealed record ClickPoint(int X, int Y);
}
