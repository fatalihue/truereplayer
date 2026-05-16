using System;
using System.Collections.Generic;
using System.ComponentModel;

namespace TrueReplayer.Models
{
    public class ActionItem : INotifyPropertyChanged
    {
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
        // WhenWritingDefault keeps non-HoldKey rows schema-clean on disk.
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
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
            "RunProfile", "Pause"
        };

        private bool HideCoordinates => NoCoordinateActionTypes.Contains(ActionType ?? "");

        public string DisplayX => HideCoordinates ? "" : X.ToString();
        public string DisplayY => HideCoordinates ? "" : Y.ToString();

        public string DisplayKey
        {
            get
            {
                if (ActionType == "Pause")
                {
                    bool hasHotkey = !string.IsNullOrWhiteSpace(Key);
                    bool hasTimeout = Timeout > 0;
                    if (hasHotkey && hasTimeout) return $"{Key} / {Timeout / 1000}s";
                    if (hasHotkey) return Key;
                    if (hasTimeout) return $"{Timeout / 1000}s";
                    return "—";
                }

                if (string.IsNullOrEmpty(Key)) return "";

                if (ActionType == "SendText") return Key;
                if (ActionType == "WaitImage") return $"{Timeout / 1000}s";
                if (ActionType == "BrowserNavigate") return Key;
                if (ActionType == "RunProfile") return RepeatCount > 1 ? $"{Key} ×{RepeatCount}" : Key;
                if (ActionType == "BrowserClick" || ActionType == "BrowserRightClick" || ActionType == "BrowserType" || ActionType == "BrowserWaitElement")
                {
                    var selector = Key.Length > 40 ? Key[..37] + "..." : Key;
                    return selector;
                }


                if (Key.StartsWith("D") && Key.Length == 2 && char.IsDigit(Key[1]))
                    return Key[1].ToString();

                return DisplayKeyMap.TryGetValue(Key, out var readable) ? readable : Key;
            }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged(string propertyName) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}