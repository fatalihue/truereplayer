using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Text.Json.Serialization;

namespace TrueReplayer.Models
{
    public class UserProfile
    {
        public static UserProfile Current { get; set; } = Default;

        public ObservableCollection<ActionItem> Actions { get; set; } = new();

        [JsonIgnore]
        public string RecordingHotkey { get; set; } = "F9";

        [JsonIgnore]
        public string ReplayHotkey { get; set; } = "F10";

        [JsonIgnore]
        public string ProfileKeyToggleHotkey { get; set; } = "Ctrl+Shift+K";

        [JsonIgnore]
        public string ForegroundHotkey { get; set; } = "Ctrl+Shift+L";

        [JsonIgnore]
        public bool RecordMouse { get; set; } = true;
        [JsonIgnore]
        public bool RecordScroll { get; set; } = true;
        [JsonIgnore]
        public bool RecordKeyboard { get; set; } = true;

        [JsonIgnore]
        public bool UseCustomDelay { get; set; } = true;
        [JsonIgnore]
        public int CustomDelay { get; set; } = 100;

        [JsonIgnore]
        public bool EnableLoop { get; set; } = false;
        [JsonIgnore]
        public int LoopCount { get; set; } = 0;
        [JsonIgnore]
        public bool LoopIntervalEnabled { get; set; } = false;
        [JsonIgnore]
        public int LoopInterval { get; set; } = 1000;

        [JsonIgnore]
        public bool AlwaysOnTop { get; set; } = false;

        [JsonIgnore]
        public bool MinimizeToTray { get; set; } = false;

        public string BatchDelay { get; set; } = "Delay (ms)";
        public string? LastProfileDirectory { get; set; }

        public string? CustomHotkey { get; set; }
        public WindowTarget? TargetWindow { get; set; }

        [JsonIgnore]
        public bool ProfileKeyEnabled { get; set; } = true;

        public static UserProfile Default => new UserProfile
        {
            RecordingHotkey = "F9",
            ReplayHotkey = "F10",
            ProfileKeyToggleHotkey = "Ctrl+Shift+K",
            ForegroundHotkey = "Ctrl+Shift+L",
            RecordMouse = true,
            RecordScroll = true,
            RecordKeyboard = true,
            UseCustomDelay = true,
            CustomDelay = 100,
            EnableLoop = false,
            LoopCount = 0,
            LoopIntervalEnabled = false,
            LoopInterval = 1000,
            ProfileKeyEnabled = true,
            Actions = new ObservableCollection<ActionItem>(),
            BatchDelay = "Delay (ms)",
            CustomHotkey = null
        };
    }

    public class WindowTarget
    {
        public string? ProcessName { get; set; }
        public string? WindowTitle { get; set; }
        public string TitleMatchMode { get; set; } = "contains";  // "contains" | "regex"
    }

    public class ProfileEntry : INotifyPropertyChanged
    {
        public string Name { get; set; } = string.Empty;
        public string FilePath { get; set; } = string.Empty;
        public string? Hotkey { get; set; }
        public bool HasWindowTarget { get; set; }
        public string Display => string.IsNullOrEmpty(Hotkey) ? Name : $"{Name} ({Hotkey})";

        private bool _isActive;
        public bool IsActive
        {
            get => _isActive;
            set
            {
                if (_isActive != value)
                {
                    _isActive = value;
                    PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsActive)));
                }
            }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
    }
}