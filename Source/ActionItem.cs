using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;

namespace TrueReplayer.Models
{
    // One ranked selector candidate captured at pick time (tiers S/A/B/C, best-first).
    // Persisted on browser actions so replay can fall back to the next candidate when the
    // primary selector no longer matches (site DOM drifted). Description is display-only.
    public class SelectorAlternativeItem
    {
        public string Selector { get; set; } = "";
        public string Tier { get; set; } = "C";
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? Description { get; set; }
    }

    public class ActionItem : INotifyPropertyChanged
    {
        // Stable identifier for React reconciliation — without this, the ActionTable uses
        // the row index as key, which means a reorder/drag/undo changes which row maps to
        // which action ID for React. The visual symptom is selections and highlight states
        // landing on the wrong row after a reorder, and animations replaying on rows that
        // didn't actually change. Generated once when the action is created; persisted in
        // profile.json; migrated for old profiles via the load path (assigned if missing).
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        public string ActionType { get; set; } = "";
        public string Key { get; set; } = "";
        public int X { get; set; }
        public int Y { get; set; }
        public int Delay { get; set; }
        public string Comment { get; set; } = "";

        // WaitImage properties
        public string? ImagePath { get; set; }
        public int Timeout { get; set; } = 5000;
        public double Confidence { get; set; } = 0.8;

        // WaitImage extras (all default-safe; existing actions deserialize identical).
        // OnTimeout: "Halt" (default) — throws and stops replay (legacy behaviour);
        //            "Continue"     — swallows the timeout and moves to next action;
        //            "StopReplay"   — ends the replay cleanly (all loops).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? WaitImageOnTimeout { get; set; }

        // false = wait for the image to appear (default); true = wait for it to disappear.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool WaitImageInvert { get; set; }

        // When true, simulate a left click at the centre of the matched region after a successful match.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool WaitImageClickOnMatch { get; set; }

        // Optional search region (sub-rect of the screen). null = full virtual screen.
        // Stored as 4 nullable ints for trivial JSON round-trip; treated as a unit.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? WaitImageSearchX { get; set; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? WaitImageSearchY { get; set; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? WaitImageSearchW { get; set; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? WaitImageSearchH { get; set; }

        // ── WaitPixelColor properties ──
        // Lighter alternative to WaitImage: polls a single screen pixel and waits for it to
        // hit a target colour (within a per-channel tolerance). Reuses the existing Timeout
        // field above. All fields are null/default-safe so existing profiles deserialize
        // unchanged — only new WaitPixelColor rows write any of these out to disk.

        // Absolute virtual-screen coordinates of the pixel to watch. Both must be set for the
        // action to do anything; null on either falls through to immediate timeout.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? PixelX { get; set; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? PixelY { get; set; }

        // Target colour in "#RRGGBB" form (uppercase hex). null = no target → immediate
        // timeout. Editor + bridge always round-trip through PixelColorService.ToHex/ParseHex
        // so the wire format stays canonical.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? PixelColor { get; set; }

        // Per-channel R/G/B match tolerance, 0–255. 0 demands an exact match; ~10 covers
        // mild compression/anti-aliasing noise on game UI elements without being so loose
        // that an unrelated colour slips through. Default 0 keeps the JSON compact when the
        // user hasn't customised it.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int PixelTolerance { get; set; }

        // Same vocabulary as WaitImageOnTimeout — "Halt" (default), "Continue", "StopReplay".
        // Kept as a separate field so a profile can mix the two action types with different
        // timeout policies without one bleeding into the other.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? PixelOnTimeout { get; set; }

        // false = wait for the colour to APPEAR (default); true = wait for it to disappear.
        // Useful for "cooldown indicator turned grey, ability is ready again" patterns.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool PixelInvert { get; set; }

        // Click (PixelX, PixelY) after a successful match. Mirrors WaitImageClickOnMatch;
        // suppressed when PixelInvert=true (same gate the WaitImage code uses).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool PixelClickOnMatch { get; set; }

        // ── Conditional logic (IF / ELSE / ENDIF) ──
        // IF rows reuse the WaitImage / WaitPixelColor probe fields above (ImagePath +
        // Confidence + WaitImageSearch* for ImageFound; PixelX/Y + PixelColor +
        // PixelTolerance for PixelColorMatch) — no separate probe class. ConditionType
        // distinguishes which family of probe fields are meaningful on a given IF row.
        // Only valid when ActionType == "If"; null on Else/EndIf rows and every non-
        // conditional action.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? ConditionType { get; set; }

        // Inverts the probe outcome (IFNOT semantic). Default false keeps the JSON
        // clean for the common case — only persisted when explicitly true.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool ConditionNegate { get; set; }

        // On probe error policy. "TreatAsFalse" (null/default) silently treats a
        // probe exception as "not matched" and walks the FALSE branch; "Halt" rethrows
        // and stops replay. Same vocabulary as WaitImageOnTimeout for consistency; kept
        // as a separate field so a profile mixing IF rows + Wait* actions can have
        // independent error policies.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? IfOnProbeError { get; set; }

        // Optional poll timeout (ms) for an IF condition. 0 (default) = instant single check:
        // evaluate the probe once and branch immediately (legacy behaviour). > 0 = poll the probe
        // until the negate-applied condition becomes true or this many ms elapse, then branch —
        // "wait up to N ms for the condition, else take the Else/false branch". Kept SEPARATE from
        // Timeout (existing IF rows default that to 5000) so enabling this is an explicit opt-in and
        // never changes legacy IF timing.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int ConditionTimeout { get; set; }

        // ── If Window (ConditionType == "WindowOpen") probe fields ──
        // A state-based condition: TRUE when a visible top-level window matching
        // ProcessName AND/OR Title exists (or is the foreground window when
        // WindowMatchForegroundOnly). Reuses WindowMatcher — same semantics as the
        // profile Window Target (empty field = wildcard, but at least one must be set).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? WindowProcessName { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? WindowTitle { get; set; }

        // "contains" (null/default) | "regex" — mirrors WindowTarget.TitleMatchMode.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? WindowTitleMatchMode { get; set; }

        // false (default) = TRUE if the window exists anywhere; true = only if it is
        // the FOREGROUND window right now.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool WindowMatchForegroundOnly { get; set; }

        // ── If Clipboard (ConditionType == "ClipboardMatch") probe fields ──
        // TRUE when the current clipboard TEXT matches ClipboardPattern under
        // ClipboardPatternType: "contains" (null/default) | "equals" | "regex".
        // All matching is case-insensitive (same default as window-title matching).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? ClipboardPatternType { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? ClipboardPattern { get; set; }

        // ── If Random (ConditionType == "Random") ──
        // TRUE with probability RandomPercent/100 (0 = never, 100 = always). Stateless —
        // rolls fresh on every probe. For varied / anti-detection behaviour in games.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int RandomPercent { get; set; }

        // ── If Variable (ConditionType == "Variable") ──
        // Compares the runtime variable named in Key (SetVariable convention) against
        // ConditionOperand under ConditionOperator. Operand resolves the full token
        // pipeline ({var}/{counter}/{row}/{clipboard}/{date}/{random}). gt/lt coerce to
        // numeric when both sides parse; eq/neq/contains are case-insensitive string.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? ConditionOperator { get; set; } // "eq"|"neq"|"contains"|"gt"|"lt"

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? ConditionOperand { get; set; }

        // ── If File exists (ConditionType == "FileExists") ──
        // TRUE when the resolved path exists as a file OR directory. Accepts tokens
        // ({var}/{date}/{clipboard}). Empty path = false. Pairs with flag-file control.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? FilePath { get; set; }

        // ── If Time / day-of-week (ConditionType == "TimeWindow") ──
        // TRUE when local time (DateTime.Now) is inside [TimeStart, TimeEnd] AND the
        // current day is selected in DaysOfWeek. TimeStart/TimeEnd = "HH:mm"; empty
        // times = day-only mode (time check passes). start > end = overnight window
        // (e.g. 22:00–02:00). DaysOfWeek = bitmask Sun=1<<0 … Sat=1<<6; 0 = every day.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? TimeStart { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? TimeEnd { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int DaysOfWeek { get; set; }

        // Browser action properties
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? BrowserText { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool NewTab { get; set; }

        // BrowserWaitElement: "appears" (default), "disappears", "enabled", "text-match"
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? WaitMode { get; set; }

        // BrowserNavigate: optional URL pattern (glob or /regex/) to wait for after navigation
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? UrlWaitPattern { get; set; }

        // BrowserNavigate: optional CSS selector to wait for after page load
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? PostNavigateSelector { get; set; }

        // Ranked selector alternatives captured at pick time (browser actions). null/empty =
        // no fallback data (pre-feature profiles, hand-typed selectors) → replay behaves
        // exactly as before, single selector only. When present, the extension retries the
        // remaining candidates in tier order before failing an element lookup.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public List<SelectorAlternativeItem>? SelectorAlternatives { get; set; }

        // BrowserType: when true, append text to existing field value instead of replacing it
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool TypeAppend { get; set; }

        // BrowserType: when true, use clipboard paste (Ctrl+V) instead of char-by-char typing
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool TypePaste { get; set; }

        // BrowserType: optional ms delay between chars. null = use default (5ms for long text)
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? TypeDelay { get; set; }

        // BrowserSelectOption: how to match the option in the native <select>.
        // "text" (default) = match by option.text, "value" = match by option.value, "index" = 0-based index.
        // null = use the default "text" mode (saves space on disk for the common case).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? SelectMatchMode { get; set; }

        // SetVariable action: the value written into the replay run's variable store under
        // the name held in Key (Key-reuse convention — same as RunProfile's profile name and
        // the browser actions' selector). Tokens ({clipboard}, {date}, {var:other}, …) resolve
        // at execution time; an empty resolved value DELETES the variable. Names are matched
        // case-insensitively and must be letters/digits/underscore.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? VariableValue { get; set; }

        // SetVariable mode. null (default) = "set": store the resolved value as-is.
        // "cycle": treat the resolved value as a LIST (one item per line) and store the
        // NEXT line on each execution, wrapping around. The cursor lives OUTSIDE the
        // run state (ActionReplayer._cycleCursors, keyed by this action's Id), so
        // pressing the profile hotkey repeatedly walks the list one item per press —
        // it survives across runs and resets only on app restart. Because tokens
        // resolve BEFORE the split, a value of just {clipboard} cycles through the
        // clipboard's lines.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? VariableMode { get; set; }

        // ── SendText rich text (ActionType == "SendText") ──
        // Optional HTML flavor of the payload, authored in the Insert Text rich editor.
        // Key remains the CANONICAL plain-text-with-tokens payload (grid display, plain
        // clipboard flavor, and the full payload an older build sends); when KeyHtml is
        // present the paste puts BOTH formats on the clipboard and the target picks the
        // richest one it understands (Gmail/Word take HTML, Notepad takes text). null =
        // plain action, byte-identical to pre-rich behavior.
        // INVALIDATION CONTRACT: any path that writes Key without fresh HTML (SheetPanel
        // textarea, generic actions:edit) MUST null KeyHtml, or replay would paste stale
        // formatted content over the new plain text.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? KeyHtml { get; set; }

        // WhatsApp/chat-style markdown flavor of the payload (*bold* _italic_ ~strike~), derived
        // from the same rich document. Used only when SendMode == "markdown": the paste puts
        // this as PLAIN text (no CF_HTML) so a target that renders inline markdown but rejects
        // HTML (WhatsApp Web, Discord-ish) formats it itself. null = no formatting to render.
        // Invalidated together with KeyHtml on any plain Key write.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? KeyMarkdown { get; set; }

        // Delivery mode for a formatted SendText: null/"rich" = HTML-where-accepted + plain
        // fallback (default); "markdown" = paste KeyMarkdown as plain text; "plain" = paste the
        // clean Key. Replaces the old SendPlainOnly bool (a "plain" value now); LegacySendPlainOnly
        // below migrates profiles saved by the pre-mode build.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? SendMode { get; set; }

        // Write-only migration shim: an older (unreleased) build persisted `sendPlainOnly: true`.
        // Map it to SendMode == "plain" on load; never serialized (no getter) so it disappears on
        // the next save. Guarded so an explicit sendMode already read from JSON wins.
        [System.Text.Json.Serialization.JsonPropertyName("sendPlainOnly")]
        public bool LegacySendPlainOnly
        {
            set { if (value && string.IsNullOrEmpty(SendMode)) SendMode = "plain"; }
        }

        // ── ActivateWindow (ActionType == "ActivateWindow") ──
        // Combined find → launch-if-missing → wait → focus action. The window MATCHER
        // reuses the If-Window fields above (WindowProcessName / WindowTitle /
        // WindowTitleMatchMode; WindowMatchForegroundOnly is ignored for this type) and
        // Timeout is the wait-for-window budget. Window existence is the ONLY success
        // criterion — the launched process is never tracked, so single-instance apps
        // that forward to an existing process behave identically to a plain focus.

        // What to launch when no matching window exists yet: an exe path, a bare
        // program name, a .lnk, a document, or a URL — passed to ShellExecute.
        // null/empty = never launch (focus-only). With BOTH matcher fields empty this
        // becomes a fire-and-forget "pure run" (open a URL/document and move on).
        // Tokens ({var:...}, {clipboard}, ...) resolve at execution time.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? LaunchPath { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? LaunchArgs { get; set; }

        // Failure policy shared by all three failure modes (launch threw / window never
        // appeared / activation could not be verified). null = "Halt" (default): report
        // and stop the replay — keyboard actions follow the OS foreground, so continuing
        // after a silent focus failure would type into the wrong app. Only "Continue" is
        // ever persisted (same convention as WaitImageOnTimeout).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? ActivateOnTimeout { get; set; }

        // Optional window PLACEMENT, applied to the matched window right after a successful
        // activation: move to WindowX/WindowY (RestorePosition) and/or resize to
        // WindowWidth/WindowHeight (RestoreSize; ignored when either is <= 0).
        //
        // Purely positional — this does NOT change the replay's coordinate context. Clicks keep
        // resolving against the profile/folder target; for "clicks relative to THIS window" use a
        // sub-profile + RunProfile, which already scopes the whole window context per call.
        //
        // Defaults are off/0, so JsonIgnore-WhenWritingDefault keeps all six out of every row
        // that doesn't place a window. WindowX/Y == 0 is a legitimate position and round-trips
        // correctly (not written → reads back 0).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool RestorePosition { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool RestoreSize { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int WindowX { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int WindowY { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int WindowWidth { get; set; }

        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public int WindowHeight { get; set; }

        // ActivateWindow verb (Phase 3): null/"activate" = bring to foreground (default); "maximize"
        // (focus then maximize), "minimize" / "close" (act on the existing window — no launch, no
        // focus). Only the non-default verb is persisted (WhenWritingNull), like ActivateOnTimeout.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? WindowVerb { get; set; }

        // ActivateWindow nth-match (Phase 3): which of several matching windows to act on, 1-based in
        // Z-order (front→back). null = the first match (default) — kept out of the JSON via
        // WhenWritingNull so ordinary single-window rows stay clean.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? WindowMatchIndex { get; set; }

        // ── BrowserAssert (ActionType == "BrowserAssert") ──
        // Verify a page element is in the expected state (reuses the BrowserWaitElement
        // probe: Key=selector, WaitMode appears|disappears|enabled|text-match, BrowserText
        // =text pattern, Timeout=wait budget, SelectorAlternatives=fallback) and FAIL the
        // replay LOUDLY if it isn't — unlike an If, which branches. "Assert NOT present" =
        // WaitMode "disappears" (no Negate needed). null = "Halt" (default): report + stop;
        // "Continue" logs and moves on. Only "Continue" is persisted (WaitImageOnTimeout
        // convention).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? AssertOnFail { get; set; }

        // When true, the action is retained in the list but skipped during replay.
        // Persisted so users can load a profile with actions pre-disabled.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool IsSkipped { get; set; }

        // When true, a combined click (LeftClick / RightClick / MiddleClick) is replayed TWICE a
        // few pixels apart so a small target actually receives focus — see ActionReplayer.FocusTap.
        // Opt-in per action (never auto-applied; would double-fire buttons). Persisted so a saved
        // profile keeps the flag; default false omits it from the JSON (JsonIgnore-when-default).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool IsFocusClick { get; set; }

        // RunProfile action: how many times to invoke the called profile back-to-back.
        // Keystroke action: how many press-cycles (down→up) to emit consecutively, so a
        // user can express "press Enter 5×" as ONE row instead of 5 Down/Up pairs.
        // 1 means a single call/press. Default 1. Range enforced at edit time (1..999).
        // Always serialized so backward-load of old profiles uses the property's default of 1.
        public int RepeatCount { get; set; } = 1;

        // RunProfile action, data-loop Phase C: run the SUB-profile once per row of its own
        // Data table ({row:col} resolves per row inside the sub). RepeatCount is ignored
        // while this is on (UI disables it). null/false omitted from the JSON so pre-feature
        // profiles stay byte-identical; pinned in ProfileCompatibility (an older build drops
        // the property and runs the sub ONCE — silent divergence).
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public bool? RunOverData { get; set; }

        // Keystroke action with RepeatCount > 1: ms gap between consecutive press cycles.
        // null = use the global default (DefaultRepeatDelayMs = 30 ms). Explicit 0 = back-
        // to-back (apps may merge into a single perceived press). 30 ms is tuned as the
        // natural rhythm so games/apps register each press separately. Clamped 0..5000
        // on edit. Ignored when RepeatCount == 1 (no gap to apply).
        // Nullable + WhenWritingNull keeps profiles written before this feature schema-clean
        // AND lets us distinguish "user wants the default" from "user explicitly chose 30".
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public int? RepeatDelayMs { get; set; }

        // Default gap between Keystroke repeat cycles when RepeatDelayMs is null/unset.
        // Kept as a static so the replay engine, the WebViewBridge edit handler, and the
        // frontend dialog can all reference the same value via the messages they exchange.
        public const int DefaultRepeatDelayMs = 30;

        // HoldKey action: how long the key stays pressed before the replay engine fires
        // the matching KEYUP. Replaces the two-row "KeyDown + KeyUp (delay = hold)" pattern
        // with a single atomic row whose Value column reads "W · 1.5s hold". 0 = use the
        // global default. Clamped 10..60000 on edit. Stuck-key cleanup (ResetKeyState)
        // safely releases the key if the replay is cancelled mid-hold.
        //
        // Always serialized (no JsonIgnore) — earlier draft used WhenWritingDefault, but
        // that hid the field whenever the value happened to be 0 (e.g. a freshly typed-and-
        // -clamped state during edit), which led to the frontend reading `undefined` and
        // falling back to a hardcoded 1000 ms display. Keeping it always-on costs ~20 bytes
        // per non-HoldKey row in the saved profile JSON — well within budget.
        public int HoldDurationMs { get; set; }

        // Default hold duration used by HoldKey when HoldDurationMs == 0. Same sharing
        // rationale as DefaultRepeatDelayMs above.
        public const int DefaultHoldDurationMs = 1000;

        [System.Text.Json.Serialization.JsonIgnore]
        public DateTime RecordedAt { get; set; } = DateTime.UtcNow;

        private int _rowNumber;
        [System.Text.Json.Serialization.JsonIgnore]
        public int RowNumber
        {
            get => _rowNumber;
            set { _rowNumber = value; OnPropertyChanged(nameof(RowNumber)); }
        }

        private bool _isInsertionPoint;
        [System.Text.Json.Serialization.JsonIgnore]
        public bool IsInsertionPoint
        {
            get => _isInsertionPoint;
            set
            {
                _isInsertionPoint = value;
                OnPropertyChanged(nameof(IsInsertionPoint));
                OnPropertyChanged(nameof(ShouldHighlight));
            }
        }

        private bool _isVisuallyDeselected;
        [System.Text.Json.Serialization.JsonIgnore]
        public bool IsVisuallyDeselected
        {
            get => _isVisuallyDeselected;
            set
            {
                _isVisuallyDeselected = value;
                OnPropertyChanged(nameof(IsVisuallyDeselected));
                OnPropertyChanged(nameof(ShouldHighlight));
            }
        }

        [System.Text.Json.Serialization.JsonIgnore]
        public bool ShouldHighlight => IsInsertionPoint && !IsVisuallyDeselected;

        private static readonly Dictionary<string, string> DisplayKeyMap = new(StringComparer.OrdinalIgnoreCase)
        {
            {"162", "Ctrl"}, {"163", "Ctrl"},
            {"160", "Shift"}, {"161", "Shift"},
            {"20", "Caps Lock"}, {"144", "Num Lock"}, {"145", "Scroll Lock"},
            {"91", "Win"}, {"92", "Win"},
            {"164", "Alt"}, {"165", "Alt"}, {"Menu", "Alt"},
            {"Oem1", ";"}, {"Oem2", "/"}, {"Oem3", "`"},
            {"Oem4", "["}, {"Oem5", "\\"}, {"Oem6", "]"}, {"Oem7", "'"},
            {"OemComma", ","}, {"OemPeriod", "."},
            {"OemMinus", "-"},
            {"OemPlus", "="},
            {"NumMultiply", "Num*"}, {"NumDivide", "Num/"},
            {"NumAdd", "Num+"}, {"NumSubtract", "Num-"}
        };

        private static readonly HashSet<string> NoCoordinateActionTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "KeyDown", "KeyUp", "Keystroke", "HoldKey", "ScrollUp", "ScrollDown", "SendText", "WaitImage",
            "BrowserClick", "BrowserRightClick", "BrowserType", "BrowserWaitElement", "BrowserNavigate",
            "BrowserSelectOption", "BrowserAssert",
            "RunProfile", "Pause", "SetVariable", "CopyToSlot", "ActivateWindow",
            // Conditional structural rows never carry their OWN coordinates — the IF row
            // borrows X/Y from its underlying probe data (handled below in DisplayX/Y);
            // Else/EndIf are pure markers with no coordinate semantics at all.
            "If", "Else", "EndIf"
        };

        private bool HideCoordinates => NoCoordinateActionTypes.Contains(ActionType ?? "");

        // Compact day-of-week label for the If-Time grid display. Bitmask Sun=1<<0 … Sat=1<<6.
        // 0 or all-7 → "" (every day, no need to show). Collapses Mon–Fri to a range where it
        // reads cleaner; otherwise lists the 2-letter abbreviations.
        private static readonly string[] DayAbbr = { "Su", "Mo", "Tu", "We", "Th", "Fr", "Sa" };
        internal static string FormatDaysOfWeek(int mask)
        {
            mask &= 0x7F;
            if (mask == 0 || mask == 0x7F) return "";
            if (mask == 0b0111110) return "Mon–Fri";      // Mon..Fri
            if (mask == 0b1000001) return "Sat–Sun";      // Sat + Sun
            var parts = new List<string>();
            for (int d = 0; d < 7; d++)
                if ((mask & (1 << d)) != 0) parts.Add(DayAbbr[d]);
            return string.Join(",", parts);
        }

        // IF rows with a PixelColorMatch condition should display the pixel's X/Y in
        // the coordinate columns even though "If" is in NoCoordinateActionTypes — the
        // user needs to see WHERE the pixel is being sampled at a glance, same as a
        // regular WaitPixelColor row would after the column is enabled. ImageFound
        // conditions still render blank (the IF row doesn't have a single XY — the
        // matched-rect is dynamic per probe).
        [System.Text.Json.Serialization.JsonIgnore]
        public string DisplayX
        {
            get
            {
                if (string.Equals(ActionType, "If", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase))
                    return PixelX?.ToString() ?? "";
                return HideCoordinates ? "" : X.ToString();
            }
        }

        [System.Text.Json.Serialization.JsonIgnore]
        public string DisplayY
        {
            get
            {
                if (string.Equals(ActionType, "If", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase))
                    return PixelY?.ToString() ?? "";
                return HideCoordinates ? "" : Y.ToString();
            }
        }

        [System.Text.Json.Serialization.JsonIgnore]
        public string DisplayKey
        {
            get
            {
                if (ActionType == "Pause")
                {
                    bool hasHotkey = !string.IsNullOrWhiteSpace(Key);
                    bool hasTimeout = Timeout > 0;
                    if (hasHotkey && hasTimeout) return $"{Key} / {Timeout / 1000.0:0.##}s";
                    if (hasHotkey) return Key;
                    if (hasTimeout) return $"{Timeout / 1000.0:0.##}s";
                    return "—";
                }

                // Copy to Slot — show the token the capture is read back with, so the grid
                // tells the user exactly what to type elsewhere ({clip:name}).
                if (string.Equals(ActionType, "CopyToSlot", StringComparison.OrdinalIgnoreCase))
                    return string.IsNullOrWhiteSpace(Key) ? "" : $"{{clip:{Key.Trim().ToLowerInvariant()}}}";

                // IF row — show the condition's primary identifier so the user can read
                // the block intent without opening the Sheet. The frontend renders the
                // NOT badge separately when ConditionNegate is true, so this stays clean
                // (no "NOT " prefix string concat — keeps presentation in the renderer).
                if (string.Equals(ActionType, "If", StringComparison.OrdinalIgnoreCase))
                {
                    if (string.Equals(ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase))
                    {
                        if (string.IsNullOrEmpty(ImagePath)) return "";
                        // Filename only — full path is in the tooltip / Sheet editor.
                        var slash = ImagePath.LastIndexOfAny(new[] { '/', '\\' });
                        return slash >= 0 ? ImagePath[(slash + 1)..] : ImagePath;
                    }
                    if (string.Equals(ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase))
                    {
                        return PixelColor ?? "";
                    }
                    if (string.Equals(ConditionType, "WindowOpen", StringComparison.OrdinalIgnoreCase))
                    {
                        // "process · title" (or whichever half is set) so the block intent
                        // reads from the grid without opening the Sheet.
                        bool hasProc = !string.IsNullOrWhiteSpace(WindowProcessName);
                        bool hasTitle = !string.IsNullOrWhiteSpace(WindowTitle);
                        if (hasProc && hasTitle) return $"{WindowProcessName} · {WindowTitle}";
                        if (hasProc) return WindowProcessName!;
                        if (hasTitle) return WindowTitle!;
                        return "";
                    }
                    if (string.Equals(ConditionType, "ClipboardMatch", StringComparison.OrdinalIgnoreCase))
                    {
                        return ClipboardPattern ?? "";
                    }
                    if (string.Equals(ConditionType, "BrowserElementState", StringComparison.OrdinalIgnoreCase))
                    {
                        // Same truncation as the browser actions' selector display below.
                        if (string.IsNullOrEmpty(Key)) return "";
                        return Key.Length > 40 ? Key[..37] + "..." : Key;
                    }
                    if (string.Equals(ConditionType, "Random", StringComparison.OrdinalIgnoreCase))
                    {
                        return $"{RandomPercent}%";
                    }
                    if (string.Equals(ConditionType, "Variable", StringComparison.OrdinalIgnoreCase))
                    {
                        if (string.IsNullOrWhiteSpace(Key)) return "";
                        var opSym = (ConditionOperator ?? "eq") switch
                        {
                            "neq" => "≠", "contains" => "⊃", "gt" => ">", "lt" => "<", _ => "=",
                        };
                        return $"{Key} {opSym} {ConditionOperand ?? ""}";
                    }
                    if (string.Equals(ConditionType, "ProcessRunning", StringComparison.OrdinalIgnoreCase))
                    {
                        return WindowProcessName ?? "";
                    }
                    if (string.Equals(ConditionType, "FileExists", StringComparison.OrdinalIgnoreCase))
                    {
                        if (string.IsNullOrEmpty(FilePath)) return "";
                        return FilePath.Length > 40 ? "…" + FilePath[^37..] : FilePath;
                    }
                    if (string.Equals(ConditionType, "TimeWindow", StringComparison.OrdinalIgnoreCase))
                    {
                        var hasTime = !string.IsNullOrWhiteSpace(TimeStart) && !string.IsNullOrWhiteSpace(TimeEnd);
                        var days = FormatDaysOfWeek(DaysOfWeek);
                        var time = hasTime ? $"{TimeStart}–{TimeEnd}" : "";
                        return string.Join(" ", new[] { days, time }.Where(s => s.Length > 0));
                    }
                    return "";
                }

                // Else / EndIf rows carry no Key data.
                if (string.Equals(ActionType, "Else", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(ActionType, "EndIf", StringComparison.OrdinalIgnoreCase))
                    return "";

                // ActivateWindow — matcher summary ("proc · title", marking launch-capable
                // rows), or "run: <path>" for pure-run rows (no matcher). Must run before
                // the Key-empty early-out below: these rows never carry a Key.
                if (string.Equals(ActionType, "ActivateWindow", StringComparison.OrdinalIgnoreCase))
                {
                    bool hasProc = !string.IsNullOrWhiteSpace(WindowProcessName);
                    bool hasTitle = !string.IsNullOrWhiteSpace(WindowTitle);
                    bool hasLaunch = !string.IsNullOrWhiteSpace(LaunchPath);
                    string matcher =
                        hasProc && hasTitle ? $"{WindowProcessName} · {WindowTitle}" :
                        hasProc ? WindowProcessName! :
                        hasTitle ? WindowTitle! : "";
                    // Phase-3: verb prefix (non-activate) + nth-match suffix.
                    string verbPrefix = (WindowVerb?.ToLowerInvariant()) switch
                    {
                        "maximize" => "Maximize · ",
                        "minimize" => "Minimize · ",
                        "close" => "Close · ",
                        _ => "",
                    };
                    string nth = (WindowMatchIndex is int mi && mi > 1) ? $" #{mi}" : "";
                    if (matcher.Length > 0)
                        return verbPrefix.Length > 0 ? $"{verbPrefix}{matcher}{nth}"
                             : hasLaunch ? $"{matcher}{nth} — launch" : $"{matcher}{nth}";
                    if (hasLaunch)
                    {
                        var path = LaunchPath!.Trim();
                        return path.Length > 40 ? $"run: {path[..37]}..." : $"run: {path}";
                    }
                    return "";
                }

                if (string.IsNullOrEmpty(Key)) return "";

                if (ActionType == "SendText") return Key;
                if (ActionType == "WaitImage") return $"{Timeout / 1000.0:0.##}s";
                if (ActionType == "BrowserNavigate") return Key;
                if (ActionType == "RunProfile") return RepeatCount > 1 ? $"{Key} ×{RepeatCount}" : Key;
                if (ActionType == "BrowserClick" || ActionType == "BrowserRightClick" || ActionType == "BrowserType" || ActionType == "BrowserWaitElement" || ActionType == "BrowserAssert")
                {
                    var selector = Key.Length > 40 ? Key[..37] + "..." : Key;
                    return selector;
                }


                // Legacy capture stored top-row digit keys as their WinForms Keys-enum name
                // ("D0".."D9"). Display them as the bare digit ("0".."9") for readability.
                if (Key.StartsWith("D") && Key.Length == 2 && char.IsDigit(Key[1]))
                    return Key[1].ToString();

                return DisplayKeyMap.TryGetValue(Key, out var readable) ? readable : Key;
            }
        }

        // Deep copy of every persisted data field. Used by Copy/Paste/Duplicate flows so
        // any new field added to this class is automatically carried — no more silent data
        // loss like the Pixel* fields had before this helper existed. UI-only state
        // (RowNumber, IsInsertionPoint, IsVisuallyDeselected) is intentionally NOT cloned
        // — the caller sets RowNumber after insertion, and the selection flags belong to
        // whichever row instance is currently in the grid.
        public ActionItem Clone() => new()
        {
            ActionType = ActionType,
            Key = Key,
            KeyHtml = KeyHtml,
            KeyMarkdown = KeyMarkdown,
            SendMode = SendMode,
            X = X,
            Y = Y,
            Delay = Delay,
            Comment = Comment,
            ImagePath = ImagePath,
            Timeout = Timeout,
            Confidence = Confidence,
            WaitImageOnTimeout = WaitImageOnTimeout,
            WaitImageInvert = WaitImageInvert,
            WaitImageClickOnMatch = WaitImageClickOnMatch,
            WaitImageSearchX = WaitImageSearchX,
            WaitImageSearchY = WaitImageSearchY,
            WaitImageSearchW = WaitImageSearchW,
            WaitImageSearchH = WaitImageSearchH,
            PixelX = PixelX,
            PixelY = PixelY,
            PixelColor = PixelColor,
            PixelTolerance = PixelTolerance,
            PixelOnTimeout = PixelOnTimeout,
            PixelInvert = PixelInvert,
            PixelClickOnMatch = PixelClickOnMatch,
            ConditionType = ConditionType,
            ConditionNegate = ConditionNegate,
            IfOnProbeError = IfOnProbeError,
            ConditionTimeout = ConditionTimeout,
            WindowProcessName = WindowProcessName,
            WindowTitle = WindowTitle,
            WindowTitleMatchMode = WindowTitleMatchMode,
            WindowMatchForegroundOnly = WindowMatchForegroundOnly,
            ClipboardPatternType = ClipboardPatternType,
            ClipboardPattern = ClipboardPattern,
            RandomPercent = RandomPercent,
            ConditionOperator = ConditionOperator,
            ConditionOperand = ConditionOperand,
            FilePath = FilePath,
            TimeStart = TimeStart,
            TimeEnd = TimeEnd,
            DaysOfWeek = DaysOfWeek,
            BrowserText = BrowserText,
            NewTab = NewTab,
            WaitMode = WaitMode,
            UrlWaitPattern = UrlWaitPattern,
            PostNavigateSelector = PostNavigateSelector,
            SelectorAlternatives = SelectorAlternatives?.Select(x => new SelectorAlternativeItem
            {
                Selector = x.Selector,
                Tier = x.Tier,
                Description = x.Description,
            }).ToList(),
            TypeAppend = TypeAppend,
            TypePaste = TypePaste,
            TypeDelay = TypeDelay,
            SelectMatchMode = SelectMatchMode,
            VariableValue = VariableValue,
            VariableMode = VariableMode,
            LaunchPath = LaunchPath,
            LaunchArgs = LaunchArgs,
            ActivateOnTimeout = ActivateOnTimeout,
            RestorePosition = RestorePosition,
            RestoreSize = RestoreSize,
            WindowX = WindowX,
            WindowY = WindowY,
            WindowWidth = WindowWidth,
            WindowHeight = WindowHeight,
            WindowVerb = WindowVerb,
            WindowMatchIndex = WindowMatchIndex,
            AssertOnFail = AssertOnFail,
            IsSkipped = IsSkipped,
            IsFocusClick = IsFocusClick,
            RepeatCount = RepeatCount,
            RunOverData = RunOverData,
            RepeatDelayMs = RepeatDelayMs,
            HoldDurationMs = HoldDurationMs,
            RecordedAt = RecordedAt,
        };

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged(string propertyName) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}