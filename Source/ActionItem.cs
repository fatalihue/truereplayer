using System;
using System.Collections.Generic;
using System.ComponentModel;

namespace TrueReplayer.Models
{
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
            "BrowserSelectOption",
            "RunProfile", "Pause",
            // Conditional structural rows never carry their OWN coordinates — the IF row
            // borrows X/Y from its underlying probe data (handled below in DisplayX/Y);
            // Else/EndIf are pure markers with no coordinate semantics at all.
            "If", "Else", "EndIf"
        };

        private bool HideCoordinates => NoCoordinateActionTypes.Contains(ActionType ?? "");

        // IF rows with a PixelColorMatch condition should display the pixel's X/Y in
        // the coordinate columns even though "If" is in NoCoordinateActionTypes — the
        // user needs to see WHERE the pixel is being sampled at a glance, same as a
        // regular WaitPixelColor row would after the column is enabled. ImageFound
        // conditions still render blank (the IF row doesn't have a single XY — the
        // matched-rect is dynamic per probe).
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
                    return "";
                }

                // Else / EndIf rows carry no Key data.
                if (string.Equals(ActionType, "Else", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(ActionType, "EndIf", StringComparison.OrdinalIgnoreCase))
                    return "";

                if (string.IsNullOrEmpty(Key)) return "";

                if (ActionType == "SendText") return Key;
                if (ActionType == "WaitImage") return $"{Timeout / 1000.0:0.##}s";
                if (ActionType == "BrowserNavigate") return Key;
                if (ActionType == "RunProfile") return RepeatCount > 1 ? $"{Key} ×{RepeatCount}" : Key;
                if (ActionType == "BrowserClick" || ActionType == "BrowserRightClick" || ActionType == "BrowserType" || ActionType == "BrowserWaitElement")
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
            BrowserText = BrowserText,
            NewTab = NewTab,
            WaitMode = WaitMode,
            UrlWaitPattern = UrlWaitPattern,
            PostNavigateSelector = PostNavigateSelector,
            TypeAppend = TypeAppend,
            TypePaste = TypePaste,
            TypeDelay = TypeDelay,
            SelectMatchMode = SelectMatchMode,
            IsSkipped = IsSkipped,
            IsFocusClick = IsFocusClick,
            RepeatCount = RepeatCount,
            RepeatDelayMs = RepeatDelayMs,
            HoldDurationMs = HoldDurationMs,
            RecordedAt = RecordedAt,
        };

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged(string propertyName) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}