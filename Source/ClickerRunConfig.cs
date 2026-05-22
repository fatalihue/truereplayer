namespace TrueReplayer.Models
{
    // Snapshot of every Clicker setting needed to start a run. Collapses the 13-parameter
    // signature that ToggleCursorClickReplay had across 4 layers (bridge → controller →
    // engine + hotkey caller). LoopCount == 0 means infinite; null Area means "click at
    // cursor" (positionJitter still applies). The two are mutually exclusive — Area takes
    // precedence inside the engine, position jitter is ignored when Area is set.
    public sealed record ClickerRunConfig(
        int DelayMs,
        bool UseJitter,
        int JitterPercent,
        int LoopCount,
        int LoopIntervalMs,
        string Button,
        int HoldMs,
        int PositionJitter,
        ClickArea? Area);

    public sealed record ClickArea(int X, int Y, int W, int H);
}
