using System;
using System.Collections.Generic;
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
        public string RecordingHotkey { get; set; } = "Ctrl+PageUp";

        [JsonIgnore]
        public string ReplayHotkey { get; set; } = "Ctrl+PageDown";

        [JsonIgnore]
        public string ProfileKeyToggleHotkey { get; set; } = "Pause";

        [JsonIgnore]
        public string ForegroundHotkey { get; set; } = "Ctrl+Insert";

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
        public HotstringConfig? CustomHotstring { get; set; }
        public WindowTarget? TargetWindow { get; set; }

        [JsonIgnore]
        public bool ProfileKeyEnabled { get; set; } = true;

        public static UserProfile Default => new UserProfile
        {
            RecordingHotkey = "Ctrl+PageUp",
            ReplayHotkey = "Ctrl+PageDown",
            ProfileKeyToggleHotkey = "Pause",
            ForegroundHotkey = "Ctrl+Insert",
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
            CustomHotkey = null,
            CustomHotstring = null
        };
    }

    public class WindowTarget
    {
        public string? ProcessName { get; set; }
        public string? WindowTitle { get; set; }
        public string TitleMatchMode { get; set; } = "contains";  // "contains" | "regex"
    }

    public class HotstringConfig
    {
        public string Sequence { get; set; } = string.Empty;
        public bool Instant { get; set; } = false;  // false = needs Enter/Space/Tab terminator
    }

    public class ProfileEntry : INotifyPropertyChanged
    {
        public string Name { get; set; } = string.Empty;
        public string FilePath { get; set; } = string.Empty;
        public string? Hotkey { get; set; }
        public string? Hotstring { get; set; }
        public bool HotstringInstant { get; set; }
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

    public class ProfileExportEntry
    {
        public string Name { get; set; } = string.Empty;
        public string? CustomHotkey { get; set; }
        public HotstringConfig? CustomHotstring { get; set; }
        public WindowTarget? TargetWindow { get; set; }
        public string BatchDelay { get; set; } = "Delay (ms)";
        public ObservableCollection<ActionItem> Actions { get; set; } = new();
    }

    public class ProfileExportEnvelope
    {
        public int Version { get; set; } = 1;
        public string ExportedAt { get; set; } = DateTime.UtcNow.ToString("o");
        public List<ProfileExportEntry> Profiles { get; set; } = new();
    }
}