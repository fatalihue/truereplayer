using System;
using System.Collections.Generic;
using System.ComponentModel;

namespace TrueReplayer.Models
{
    public class ActionItem : INotifyPropertyChanged
    {
        public string ActionType { get; set; }
        public string Key { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Delay { get; set; }
        public string Comment { get; set; }

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

        public string DisplayKey
        {
            get
            {
                if (string.IsNullOrEmpty(Key)) return "";

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