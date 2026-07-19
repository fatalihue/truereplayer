using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Text.Json.Serialization;

namespace TrueReplayer.Models
{
    /// <summary>
    /// Determines how a profile's hotkey behaves when pressed.
    /// OnPress  - fire once on key down (current default behavior).
    /// OnRelease - fire once on key up; key down is swallowed but does nothing.
    /// WhilePressed - start replay with infinite loop on key down, cancel on key up (autofire).
    /// Toggle - key down starts replay (respecting loop settings); pressing again stops it.
    /// DoubleTap - fire once when the key is pressed twice within the tap window (single
    ///             presses do nothing — the key is a dedicated trigger, downs are swallowed).
    /// Hold - fire once after the key has been held for the long-press threshold; a quick
    ///        tap does nothing (distinct from WhilePressed, which runs only WHILE held).
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum TriggerMode
    {
        OnPress,
        OnRelease,
        WhilePressed,
        Toggle,
        DoubleTap,
        Hold
    }

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
        public string ForegroundHotkey { get; set; } = "Insert";

        // Flips UseCursorClick (Macro ↔ Clicker). Default ScrollLock — pairs with Pause as
        // the other single-key status-indicator hotkey already in use, and is almost
        // universally unused by other apps.
        [JsonIgnore]
        public string ModeToggleHotkey { get; set; } = "ScrollLock";

        // Capture-selection → clipboard slot ({clip:1}…{clip:9}, sequential). Empty = disabled;
        // the shipped default is Win+Ctrl+C — see AppSettings.CaptureSlotHotkey.
        [JsonIgnore]
        public string CaptureSlotHotkey { get; set; } = "Win+Ctrl+C";

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
        public int LoopInterval { get; set; } = 200;

        [JsonIgnore]
        public bool AlwaysOnTop { get; set; } = false;

        [JsonIgnore]
        public bool MinimizeToTray { get; set; } = true;

        [JsonIgnore]
        public bool StartMinimized { get; set; } = false;

        // Out-of-window run-end notifications — global (AppSettings.json), never
        // serialized per-profile. Both opt-in. See WebViewBridge.NotifyRunEnded.
        [JsonIgnore]
        public bool RunEndFlash { get; set; } = false;

        [JsonIgnore]
        public bool RunEndSound { get; set; } = false;

        public string BatchDelay { get; set; } = "Delay (ms)";
        public string? LastProfileDirectory { get; set; }

        public string? CustomHotkey { get; set; }
        public HotstringConfig? CustomHotstring { get; set; }
        public WindowTarget? TargetWindow { get; set; }
        public bool UseRelativeCoordinates { get; set; } = false;
        public int WindowWidth { get; set; } = 0;
        public int WindowHeight { get; set; } = 0;
        public int WindowX { get; set; } = 0;
        public int WindowY { get; set; } = 0;
        public bool RestorePosition { get; set; } = false;
        public bool RestoreSize { get; set; } = false;
        public bool BringToFocus { get; set; } = false;
        public TriggerMode TriggerMode { get; set; } = TriggerMode.OnPress;
        public bool IsDisabled { get; set; }

        // ── Profile metadata (sharing / library) ──
        // All optional with safe defaults so existing profile.json files load unchanged.
        // Description: short text shown in the Info tab and Import Preview. Plain text, ~200 chars.
        public string? Description { get; set; }
        // Tags: free-form labels (lowercased on save). Used for browsing/grouping community profiles.
        // Capped at 10 tags in the UI; backend doesn't enforce a hard limit to avoid breaking imports.
        public List<string>? Tags { get; set; }
        // CreatedAt / UpdatedAt: UTC. Set by ProfileController on create / save. Null on profiles
        // that predate this feature — UI renders "Unknown" rather than inventing a date.
        public DateTime? CreatedAt { get; set; }
        public DateTime? UpdatedAt { get; set; }
        // ProfileVersion: author-controlled semver-less integer. Bumped manually when sharing a new
        // revision. Defaults to 1 for both new and pre-existing profiles.
        public int ProfileVersion { get; set; } = 1;
        // AppMinVersion: minimum TrueReplayer version required to run this profile, computed from
        // the feature set used (see ProfileCompatibility). Null = no special requirement (1.0+).
        // Recalculated on every export, stored here so subsequent edits can see the last value.
        public string? AppMinVersion { get; set; }
        // IconEmoji: single emoji character displayed in profile list + Import Preview. Validated
        // on the frontend; backend accepts any string and trims to first grapheme on save.
        public string? IconEmoji { get; set; }

        // Data-loop table (Model A): a small CSV-like table embedded in the profile JSON.
        // When LoopOverData is on, the whole profile re-runs once per row and {row:column}
        // tokens resolve to the current row's cells. null = feature not used (byte-identical
        // for old profiles). Embedded (not a sidecar) since it reuses the profile save/export
        // pipelines for free; large sets would want a sidecar but that's a later increment.
        public ProfileDataTable? Data { get; set; }

        // Automation trigger: fires this profile WITHOUT a hotkey press (interval / clock
        // schedule / watched condition). null = feature unused (byte-identical old profiles,
        // same convention as Data). Armed is persisted so the daemon re-arms at startup,
        // but it is MACHINE-LOCAL intent: import / duplicate / copy paths force it false so
        // a shared or cloned profile can never start self-firing without explicit consent.
        public ProfileTriggerConfig? Triggers { get; set; }

        [JsonIgnore]
        public bool ProfileKeyEnabled { get; set; } = true;

        // Automation master switch mirror (AppSettings-backed, global — same convention as
        // ProfileKeyEnabled above).
        [JsonIgnore]
        public bool AutomationEnabled { get; set; } = true;

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
            LoopInterval = 200,
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

    // Data-loop table. Headers name the columns ({row:header}); Rows are the data (each an
    // ordered list of cell strings, aligned to Headers by index; short rows tolerated =
    // missing cells resolve empty). LoopOverData drives the "run the profile once per row"
    // behaviour. Stored inside the profile JSON.
    public class ProfileDataTable
    {
        public List<string> Headers { get; set; } = new();
        public List<List<string>> Rows { get; set; } = new();
        public bool LoopOverData { get; set; }
        // Per-row error policy while looping over data: null/"halt" = stop the run on the
        // first failed row (classic behaviour); "skip" = log the row and continue with the
        // next one. Only meaningful when LoopOverData is on. Ignored-when-null so plain
        // tables stay byte-identical on disk (and in exports) to pre-feature builds.
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? OnRowError { get; set; }
        // Cursor mode (LoopOverData OFF) only: announce when a run consumes the LAST row —
        // the list just finished a full pass and the next run wraps back to row 1. Without
        // it the wrap is silent and you only notice by seeing item #1 typed again.
        // null = default ON, so plain tables stay byte-identical on disk and only an
        // explicit opt-out is ever written. Deliberately NOT pinned in ProfileCompatibility:
        // an older build simply ignores the field and skips the notice — the macro itself
        // behaves identically, so there is nothing to warn an importer about.
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? NotifyOnLapComplete { get; set; }
    }

    public class HotstringConfig
    {
        public string Sequence { get; set; } = string.Empty;
        public bool Instant { get; set; } = false;  // false = needs Enter/Space/Tab terminator
    }

    // Automation trigger config (one per profile). Kind selects which field group applies;
    // unused groups keep defaults and are harmless in the JSON. Executed by TriggerService —
    // N armed triggers watch concurrently, but fires funnel into the single replay engine
    // (skip-if-busy; there is only one mouse/keyboard).
    public class ProfileTriggerConfig
    {
        public string Kind { get; set; } = "interval";      // "interval" | "schedule" | "condition"
        // Armed = the daemon actively runs this trigger (and re-arms it at startup).
        public bool Armed { get; set; }

        // interval — every N seconds (runtime clamps to >= 5).
        public int IntervalSeconds { get; set; } = 300;

        // schedule — fire at TimeOfDay ("HH:mm", local) on the days in DaysOfWeek
        // (bitmask, Sun = 1<<0 — same convention as the If-Time condition; 0 = every day).
        public string? TimeOfDay { get; set; }
        public int DaysOfWeek { get; set; }

        // condition — poll a probe and fire on a false→true edge (or continuously, see
        // Retrigger). ConditionType: WindowOpen | ProcessRunning | FileExists |
        // PixelColorMatch | ImageFound | ClipboardChanged. Field names mirror the
        // If-condition fields on ActionItem so the concepts stay recognizably the same.
        public string? ConditionType { get; set; }
        public string? WindowProcessName { get; set; }
        public string? WindowTitle { get; set; }
        public string? WindowTitleMatchMode { get; set; }   // "contains" | "regex"
        public bool WindowMatchForegroundOnly { get; set; }
        public string? FilePath { get; set; }
        public int PixelX { get; set; }
        public int PixelY { get; set; }                     // absolute virtual-screen coords (no rel-coords for watchers)
        public string? PixelColor { get; set; }             // "#RRGGBB"
        public int PixelTolerance { get; set; } = 10;
        public string? ImagePath { get; set; }              // per-profile PNG, same store as WaitImage
        public double ImageConfidence { get; set; } = 0.8;  // runtime clamps to <= 0.99
        public string? ClipboardPattern { get; set; }       // contains-filter; empty = any clipboard change

        // Firing policy (condition kind): CooldownSeconds <= 0 = default 30 s between fires;
        // Retrigger null/"edge" = must observe the condition false again before the next
        // fire, "level" = keep firing every cooldown while the condition stays true.
        public int CooldownSeconds { get; set; }
        public string? Retrigger { get; set; }

        public ProfileTriggerConfig Clone() => (ProfileTriggerConfig)MemberwiseClone();
    }

    public class ProfileEntry : INotifyPropertyChanged
    {
        public string Name { get; set; } = string.Empty;
        public string FilePath { get; set; } = string.Empty;
        public string? Hotkey { get; set; }
        public string? Hotstring { get; set; }
        public bool HotstringInstant { get; set; }
        // ── Profile metadata mirror (read from UserProfile on list load) ──
        // Surfaced here so the sidebar can render icon badges + tag chips without re-reading
        // the whole profile JSON. Not edited directly — Info tab calls profile:set-metadata
        // which reloads the profile, then RefreshProfileListAsync repopulates this entry.
        public string? Description { get; set; }
        public List<string>? Tags { get; set; }
        public string? IconEmoji { get; set; }
        public int ProfileVersion { get; set; } = 1;
        public DateTime? CreatedAt { get; set; }
        public DateTime? UpdatedAt { get; set; }
        public string? AppMinVersion { get; set; }
        // Number of actions in the profile, read at list-load (the profile is already deserialized
        // + its actions iterated there, so this is free). Lets the Export dialog show per-profile
        // weight, matching the Import Preview which already renders "N actions".
        public int ActionCount { get; set; }
        public bool HasWindowTarget { get; set; }
        public string? WindowTargetProcessName { get; set; }
        public string? WindowTargetWindowTitle { get; set; }
        public string WindowTargetTitleMatchMode { get; set; } = "contains";
        public bool UseRelativeCoordinates { get; set; }
        public bool BringToFocus { get; set; }
        public bool RestorePosition { get; set; }
        public bool RestoreSize { get; set; }
        // Effective target — what the hotkey gate actually uses for this profile. Differs from
        // HasWindowTarget when the profile has no target of its own but inherits one from its
        // folder. Lets the UI render an "inherited" badge so users can see the gating without
        // having to open the dialog. Populated by ProfileController.LoadProfileListAsync.
        public bool HasEffectiveTarget { get; set; }
        public string? EffectiveTargetSource { get; set; }  // "own" | "folder" | null
        public string? EffectiveTargetFolderName { get; set; }
        public string? EffectiveTargetProcessName { get; set; }
        public string? EffectiveTargetWindowTitle { get; set; }
        public string EffectiveTargetTitleMatchMode { get; set; } = "contains";
        public TriggerMode TriggerMode { get; set; } = TriggerMode.OnPress;
        public bool IsDisabled { get; set; }
        // Automation trigger mirror (full config, in-memory only — ProfileEntry is never
        // persisted). Lets TriggerService re-arm and the Automation panel project configs
        // without re-reading every profile JSON. Populated by LoadProfileListAsync.
        public ProfileTriggerConfig? Triggers { get; set; }
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

    // ── Profile Organization (Folders + Pin) ──

    public class ProfileFolder
    {
        public string Name { get; set; } = string.Empty;
        public string Color { get; set; } = "#60CDFF";
        public bool Collapsed { get; set; } = false;
        public List<string> Items { get; set; } = new();
        public WindowTarget? TargetWindow { get; set; }
        public bool UseRelativeCoordinates { get; set; } = false;
        public bool BringToFocus { get; set; } = false;
        // Restore Position/Size + window geometry are inheritable just like the target itself.
        // A profile inside the folder uses these unless it overrides them at the profile level.
        // Defaults keep pre-existing folders (saved before this field set) working unchanged.
        public bool RestorePosition { get; set; } = false;
        public bool RestoreSize { get; set; } = false;
        public int WindowX { get; set; } = 0;
        public int WindowY { get; set; } = 0;
        public int WindowWidth { get; set; } = 0;
        public int WindowHeight { get; set; } = 0;
    }

    public class ProfileOrderData
    {
        public List<string> Pinned { get; set; } = new();
        public List<ProfileFolder> Folders { get; set; } = new();
        public List<string> UngroupedOrder { get; set; } = new();
    }

    public class ProfileExportEntry
    {
        public string Name { get; set; } = string.Empty;
        public string? CustomHotkey { get; set; }
        public HotstringConfig? CustomHotstring { get; set; }
        public WindowTarget? TargetWindow { get; set; }
        public bool UseRelativeCoordinates { get; set; } = false;
        public int WindowWidth { get; set; } = 0;
        public int WindowHeight { get; set; } = 0;
        public int WindowX { get; set; } = 0;
        public int WindowY { get; set; } = 0;
        public bool RestorePosition { get; set; } = false;
        public bool RestoreSize { get; set; } = false;
        public bool BringToFocus { get; set; } = false;
        public TriggerMode TriggerMode { get; set; } = TriggerMode.OnPress;
        public string BatchDelay { get; set; } = "Delay (ms)";
        public bool IsDisabled { get; set; }
        public ObservableCollection<ActionItem> Actions { get; set; } = new();
        /// <summary>
        /// Embedded WaitImage reference images: filename → base64 PNG data.
        /// </summary>
        public Dictionary<string, string>? Images { get; set; }
        // ── Sharing metadata (round-tripped to the .trprofile envelope) ──
        // Same fields as UserProfile, copied at export time. All optional — pre-metadata
        // exports omit these and old apps reading new exports ignore unknown keys.
        public string? Description { get; set; }
        public List<string>? Tags { get; set; }
        public DateTime? CreatedAt { get; set; }
        public DateTime? UpdatedAt { get; set; }
        public int ProfileVersion { get; set; } = 1;
        // AppMinVersion: semver-ish "MAJOR.MINOR.PATCH" string (e.g. "2.0.0", "2.1.0").
        // Computed by ProfileCompatibility.ComputeMinVersion on every export so it always
        // matches the feature set actually present in the actions.
        public string? AppMinVersion { get; set; }
        public string? IconEmoji { get; set; }
        // Data-loop table — round-tripped to the .trprofile envelope like the other
        // per-profile fields; null omitted, old apps ignore the unknown key.
        public ProfileDataTable? Data { get; set; }
        // Automation trigger — round-tripped so the receiver gets the configuration, but
        // the import builder FORCES Armed=false (a shared profile must never self-fire
        // without the receiver explicitly arming it).
        public ProfileTriggerConfig? Triggers { get; set; }
    }

    public class ProfileExportOrganization
    {
        public List<string> Pinned { get; set; } = new();
        public List<ProfileFolder> Folders { get; set; } = new();
        public List<string> UngroupedOrder { get; set; } = new();
    }

    public class ProfileExportEnvelope
    {
        public int Version { get; set; } = 1;
        public string ExportedAt { get; set; } = DateTime.UtcNow.ToString("o");
        public List<ProfileExportEntry> Profiles { get; set; } = new();
        public ProfileExportOrganization? Organization { get; set; }
    }
}