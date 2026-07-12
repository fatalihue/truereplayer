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
        ClickPoint? FixedPoint);

    public sealed record ClickArea(int X, int Y, int W, int H);

    public sealed record ClickPoint(int X, int Y);
}
