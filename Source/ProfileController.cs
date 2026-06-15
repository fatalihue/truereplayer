using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using System.Collections.ObjectModel;
using TrueReplayer.Models;
using TrueReplayer.Services;
using WinForms = System.Windows.Forms;

namespace TrueReplayer.Controllers
{
    public enum SaveDialogResult { Overwrite, SaveAsNew, Cancel }
    // Conflict resolution decided up-front in the React Import Preview dialog. The legacy
    // "OverwriteAll" / "SkipAll" values were removed when the per-profile inline picker
    // replaced the old C# bulk dialog — bulk behaviour is now a frontend convenience that
    // just stamps the chosen value into every conflicting row's resolution.
    public enum ImportConflictResult { Overwrite, Rename, Skip }

    public class ProfileController : IDisposable
    {
        private readonly MainWindow window;
        private FileSystemWatcher? profileWatcher;
        private CancellationTokenSource? debounceCts;
        // Watcher events fire on threadpool threads and can overlap; this guards the
        // cancel/dispose/reassign of debounceCts so two callbacks can't race into
        // cancelling or disposing the same (already-disposed) CTS.
        private readonly object _debounceLock = new();
        private bool _disposed;
        private DateTime suppressWatcherUntil = DateTime.MinValue;

        public ObservableCollection<ProfileEntry> ProfileEntries { get; } = new();

        /// <summary>
        /// Optional callback fired when a load-time operation surfaces a user-facing
        /// notice (currently: ConditionalBlockValidator auto-repair on profile load).
        /// The bridge wires this to SendMessage("alert:show", { message }) so the
        /// frontend renders a toast. Wrapped in null-check so headless test contexts
        /// don't have to provide one.
        /// </summary>
        public Action<string>? OnAlert { get; set; }
        private Dictionary<string, WindowTarget> _cachedWindowTargets = new();
        // Built during LoadProfileListAsync — maps sanitized profile folder name → set of
        // ImagePath filenames referenced by WaitImage actions. Used by ImageStorageService
        // .CleanupOrphanImages at startup to delete unreferenced PNGs.
        private Dictionary<string, HashSet<string>> _referencedImagesByProfile = new();
        private string? _activeProfileName;
        private ProfileOrderData _profileOrder = new();
        private readonly SemaphoreSlim _profileOrderLock = new(1, 1);

        private static readonly JsonSerializerOptions OrderJsonOptions = new()
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            TypeInfoResolver = new DefaultJsonTypeInfoResolver()
        };

        private string ProfileOrderPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "TrueReplayer", "Profiles", "profile-order.json");

        // Theme colors for native dialogs (sent from React frontend)
        private SolidColorBrush? _dialogBackground;
        private SolidColorBrush? _dialogForeground;
        private SolidColorBrush? _dialogTextSecondary;

        public ProfileController(MainWindow window)
        {
            this.window = window;
            SetupProfileWatcher();
        }

        public void SetDialogThemeColors(string bgSurface, string bgCard, string textPrimary, string textSecondary, string? accentSolid, string? borderSubtle)
        {
            _dialogBackground = ParseHexBrush(bgCard) ?? ParseHexBrush(bgSurface);
            _dialogForeground = ParseHexBrush(textPrimary);
            _dialogTextSecondary = ParseHexBrush(textSecondary);
        }

        private static SolidColorBrush? ParseHexBrush(string? hex)
        {
            if (string.IsNullOrEmpty(hex) || hex[0] != '#') return null;
            try
            {
                hex = hex.TrimStart('#');
                byte a = 255;
                byte r, g, b;
                if (hex.Length == 8) { a = Convert.ToByte(hex[..2], 16); r = Convert.ToByte(hex[2..4], 16); g = Convert.ToByte(hex[4..6], 16); b = Convert.ToByte(hex[6..8], 16); }
                else if (hex.Length == 6) { r = Convert.ToByte(hex[..2], 16); g = Convert.ToByte(hex[2..4], 16); b = Convert.ToByte(hex[4..6], 16); }
                else return null;
                return new SolidColorBrush(ColorHelper.FromArgb(a, r, g, b));
            }
            catch { return null; }
        }

        public void ApplyDialogTheme(ContentDialog dialog, TextBlock? messageBlock = null)
        {
            if (_dialogBackground != null) dialog.Background = _dialogBackground;
            if (_dialogForeground != null) dialog.Foreground = _dialogForeground;
            if (messageBlock != null && _dialogForeground != null) messageBlock.Foreground = _dialogForeground;
        }

        /// Run a WinForms file dialog on a dedicated STA thread so the UI thread stays responsive.
        private static Task<string?> ShowFileDialogAsync(WinForms.FileDialog dialog)
        {
            var tcs = new TaskCompletionSource<string?>();
            var thread = new Thread(() =>
            {
                try
                {
                    tcs.SetResult(dialog.ShowDialog() == WinForms.DialogResult.OK ? dialog.FileName : null);
                }
                catch
                {
                    tcs.SetResult(null);
                }
                finally
                {
                    dialog.Dispose();
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            return tcs.Task;
        }

        #region Profile CRUD Operations

        public async Task<bool> SaveProfileAsync()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            Directory.CreateDirectory(profileDir);

            var fileName = await ShowFileDialogAsync(new WinForms.SaveFileDialog
            {
                Filter = "JSON file (*.json)|*.json",
                FileName = "profile",
                InitialDirectory = profileDir
            });

            if (fileName != null)
            {
                var profile = new UserProfile
                {
                    Actions = window.Actions,
                    BatchDelay = UserProfile.Current.BatchDelay,
                    LastProfileDirectory = Path.GetDirectoryName(fileName)!,
                    CustomHotkey = UserProfile.Current.CustomHotkey,
                    CustomHotstring = UserProfile.Current.CustomHotstring,
                    TargetWindow = UserProfile.Current.TargetWindow,
                    UseRelativeCoordinates = UserProfile.Current.UseRelativeCoordinates,
                    WindowWidth = UserProfile.Current.WindowWidth,
                    WindowHeight = UserProfile.Current.WindowHeight,
                    WindowX = UserProfile.Current.WindowX,
                    WindowY = UserProfile.Current.WindowY,
                    RestorePosition = UserProfile.Current.RestorePosition,
                    RestoreSize = UserProfile.Current.RestoreSize,
                    BringToFocus = UserProfile.Current.BringToFocus,
                    TriggerMode = UserProfile.Current.TriggerMode,
                    IsDisabled = UserProfile.Current.IsDisabled,
                };

                try
                {
                    await SettingsManager.SaveProfileAsync(fileName, profile);
                    await RefreshProfileListAsync(true);
                    return true;
                }
                catch (Exception ex)
                {
                    WinForms.MessageBox.Show($"Error saving profile:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                }
            }
            return false;
        }

        public async Task<string?> LoadProfileAsync()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            var path = await ShowFileDialogAsync(new WinForms.OpenFileDialog
            {
                Filter = "JSON file (*.json)|*.json",
                InitialDirectory = profileDir
            });

            if (path != null)
            {
                var profile = await SettingsManager.LoadProfileAsync(path);

                if (profile != null)
                {
                    // Repair any unbalanced IF/ELSE/ENDIF blocks before handing the profile
                    // to the rest of the app — the replay engine assumes the validator has
                    // already run and won't second-guess hand-edited JSON. Idempotent + a
                    // no-op for profiles without any conditionals.
                    var blockFix = ConditionalBlockValidator.ValidateAndRepairBlocks(profile.Actions);
                    if (blockFix.HadFixups)
                    {
                        var name = Path.GetFileNameWithoutExtension(path);
                        DiagnosticLog.Info($"[ConditionalBlocks] Auto-repaired '{name}': removed {blockFix.OrphansRemoved} orphan(s), appended {blockFix.EndIfsAppended} synthetic ENDIF(s)");
                        OnAlert?.Invoke(FormatBlockFixupToast(name, blockFix));
                    }

                    UserProfile.Current = profile;
                    AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                    UserProfile.Current.LastProfileDirectory = Path.GetDirectoryName(path)!;
                    return path;
                }
            }

            return null;
        }

        public async Task<UserProfile?> LoadProfileByNameAsync(string profileName)
        {
            if (string.IsNullOrEmpty(profileName))
            {
                System.Diagnostics.Debug.WriteLine("profileName está vazio ou nulo em LoadProfileByNameAsync.");
                return null;
            }

            var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
            if (entry == null)
            {
                System.Diagnostics.Debug.WriteLine($"Perfil '{profileName}' não encontrado em LoadProfileByNameAsync.");
                return null;
            }

            if (!File.Exists(entry.FilePath))
            {
                System.Diagnostics.Debug.WriteLine($"Arquivo do perfil '{entry.FilePath}' não existe.");
                return null;
            }

            var profile = await SettingsManager.LoadProfileAsync(entry.FilePath);
            if (profile == null)
            {
                System.Diagnostics.Debug.WriteLine($"Falha ao carregar o perfil '{profileName}' do arquivo '{entry.FilePath}'.");
                return profile;
            }

            // Same validator hook as LoadProfileAsync — also covers sub-profile calls via
            // RunProfile (MainWindow wires SetProfileLookup → this method) so a nested
            // RunProfile target that's hand-edited with an unbalanced block gets repaired
            // before the engine's BuildBlockMap runs over it.
            var blockFix = ConditionalBlockValidator.ValidateAndRepairBlocks(profile.Actions);
            if (blockFix.HadFixups)
            {
                DiagnosticLog.Info($"[ConditionalBlocks] Auto-repaired '{profileName}': removed {blockFix.OrphansRemoved} orphan(s), appended {blockFix.EndIfsAppended} synthetic ENDIF(s)");
                OnAlert?.Invoke(FormatBlockFixupToast(profileName, blockFix));
            }

            return profile;
        }

        /// <summary>
        /// Builds a one-line human-readable summary of what the conditional-block validator
        /// just fixed up. Reads naturally on a toast ("Auto-repaired 'X': appended 2 EndIf,
        /// removed 1 orphan"). Pluralisation handled by branching strings rather than a
        /// helper because the two counters are independent and rarely both non-zero.
        /// </summary>
        private static string FormatBlockFixupToast(string profileName, ConditionalBlockValidator.BlockValidationResult fix)
        {
            var parts = new List<string>(2);
            if (fix.EndIfsAppended > 0)
                parts.Add($"appended {fix.EndIfsAppended} EndIf{(fix.EndIfsAppended == 1 ? "" : "s")}");
            if (fix.OrphansRemoved > 0)
                parts.Add($"removed {fix.OrphansRemoved} orphan{(fix.OrphansRemoved == 1 ? "" : "s")}");
            return $"Auto-repaired conditional blocks in '{profileName}': {string.Join(", ", parts)}";
        }

        public async Task SaveProfileByNameAsync(string profileName, UserProfile profile)
        {
            var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
            if (entry != null)
            {
                // Stamp UpdatedAt on every save so the Info tab + Import Preview show a
                // meaningful "last modified" date. CreatedAt is only set if missing, so
                // pre-existing profiles get a CreatedAt the first time they're saved after
                // this feature lands (best we can do without inventing past dates).
                var nowUtc = DateTime.UtcNow;
                profile.UpdatedAt = nowUtc;
                if (profile.CreatedAt == null) profile.CreatedAt = nowUtc;
                await SettingsManager.SaveProfileAsync(entry.FilePath, profile);
            }
        }

        public void ResetProfile()
        {
            UserProfile.Current = UserProfile.Default;
            AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
            UpdateProfileColors(null);
        }

        #endregion

        #region Profile List Management

        /// <summary>
        /// Names of profile.json files that failed to load on the last LoadProfileListAsync
        /// pass. Surfaced via <see cref="GetAndClearLoadFailures"/> so the bridge can show
        /// the user a toast on startup instead of silently dropping the broken profiles.
        /// </summary>
        private readonly List<string> _loadFailures = new();

        /// <summary>
        /// Returns the list of profile names that failed to load on the most recent refresh,
        /// then clears the list. Called once by the bridge after profiles:updated is pushed
        /// so the alert fires exactly once per failed load.
        /// </summary>
        public IReadOnlyList<string> GetAndClearLoadFailures()
        {
            var copy = _loadFailures.ToList();
            _loadFailures.Clear();
            return copy;
        }

        private async Task LoadProfileListAsync()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            Directory.CreateDirectory(profileDir);

            // Sweep any orphan temp files left behind by a previous atomic-save that hit
            // the rare "AV held the temp past both the move retry AND the cleanup Delete"
            // path. Without this, leaked temps accumulate over time and clutter the
            // user's Profiles directory. Matches Path.GetRandomFileName() format strictly
            // so real .json / .png / user files stay untouched. Idempotent + cheap.
            FileHelper.CleanupOrphanTemps(profileDir);

            var files = Directory.GetFiles(profileDir, "*.json")
                .Where(f => !string.Equals(Path.GetFileName(f), "profile-order.json", StringComparison.OrdinalIgnoreCase))
                .ToList();

            ProfileEntries.Clear();
            _cachedWindowTargets.Clear();
            _referencedImagesByProfile.Clear();
            _loadFailures.Clear();

            foreach (var file in files)
            {
                try
                {
                    var name = Path.GetFileNameWithoutExtension(file);
                    var profile = await SettingsManager.LoadProfileAsync(file);
                    if (profile != null)
                    {
                        bool hasTarget = profile.TargetWindow != null
                            && (!string.IsNullOrEmpty(profile.TargetWindow.ProcessName)
                                || !string.IsNullOrEmpty(profile.TargetWindow.WindowTitle));

                        ProfileEntries.Add(new ProfileEntry
                        {
                            Name = name,
                            FilePath = file,
                            Hotkey = profile.CustomHotkey,
                            Hotstring = profile.CustomHotstring?.Sequence,
                            HotstringInstant = profile.CustomHotstring?.Instant ?? false,
                            HasWindowTarget = hasTarget,
                            WindowTargetProcessName = profile.TargetWindow?.ProcessName,
                            WindowTargetWindowTitle = profile.TargetWindow?.WindowTitle,
                            WindowTargetTitleMatchMode = profile.TargetWindow?.TitleMatchMode ?? "contains",
                            UseRelativeCoordinates = profile.UseRelativeCoordinates,
                            BringToFocus = profile.BringToFocus,
                            RestorePosition = profile.RestorePosition,
                            RestoreSize = profile.RestoreSize,
                            TriggerMode = profile.TriggerMode,
                            IsDisabled = profile.IsDisabled,
                            // Mirror sharing metadata into the sidebar entry so the UI can render
                            // icon/tags/version badges without re-reading the JSON. Null tags stays
                            // null (don't coerce to empty list — the UI distinguishes "no tags set"
                            // from "tags were set then all removed").
                            Description = profile.Description,
                            Tags = profile.Tags,
                            IconEmoji = profile.IconEmoji,
                            ProfileVersion = profile.ProfileVersion,
                            CreatedAt = profile.CreatedAt,
                            UpdatedAt = profile.UpdatedAt,
                            AppMinVersion = profile.AppMinVersion
                        });

                        if (hasTarget)
                            _cachedWindowTargets[name] = profile.TargetWindow!;

                        // Collect referenced PNG filenames for orphan-cleanup at startup.
                        // IF rows with ConditionType="ImageFound" share the same per-profile
                        // ImagePath storage as WaitImage — leaving them out of the reference
                        // set causes the cleanup to delete the captured PNG and the Sheet
                        // reopens with an empty thumbnail after the next restart.
                        var refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        foreach (var a in profile.Actions)
                        {
                            if (string.IsNullOrEmpty(a.ImagePath)) continue;
                            if (a.ActionType == "WaitImage"
                                || (a.ActionType == "If" && string.Equals(a.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)))
                            {
                                refs.Add(a.ImagePath);
                            }
                        }
                        _referencedImagesByProfile[ImageStorageService.GetSanitizedProfileFolder(name)] = refs;
                    }
                }
                catch (Exception ex)
                {
                    // Profile JSON is corrupt, has incompatible types, or otherwise can't be
                    // deserialized. Record the name so the bridge can surface a single
                    // user-visible alert listing all failed profiles ("3 profiles couldn't
                    // load: foo, bar, baz") instead of letting the user discover the loss
                    // by noticing missing entries.
                    var failedName = Path.GetFileNameWithoutExtension(file);
                    if (!string.IsNullOrEmpty(failedName)) _loadFailures.Add(failedName);
                    DiagnosticLog.Error($"Profile load failed: '{failedName}' ({Path.GetFileName(file)})", ex);
                }
            }

            await LoadProfileOrderAsync();
            PopulateEffectiveTargets();

            var map = GetProfileHotkeys();
            InputHookManager.RegisterProfileHotkeys(map);
            InputHookManager.RegisterProfileTriggerModes(GetProfileTriggerModes());
            InputHookManager.RegisterProfileWindowTargets(GetProfileWindowTargets(), GetBringToFocusProfiles());
            var hotstringMap = GetProfileHotstrings();
            InputHookManager.RegisterProfileHotstrings(hotstringMap);

            // Diagnostic snapshot of what's actually ARMED after a (re)load — answers "is my
            // hotkey even registered, and to which target?" without a repro. Fires on profile
            // load/change (low frequency), so it's safe for the disk-per-write logger.
            try
            {
                var targets = GetProfileWindowTargets();
                string armed = map.Count == 0
                    ? "none"
                    : string.Join(", ", map.Select(kv =>
                    {
                        targets.TryGetValue(kv.Key, out var t);
                        string tgt = t == null
                            ? "any-window"
                            : $"{t.ProcessName}{(string.IsNullOrEmpty(t.WindowTitle) ? "" : "/" + t.WindowTitle)}";
                        return $"'{kv.Key}'={kv.Value}->[{tgt}]";
                    }));
                var skipped = ProfileEntries
                    .Where(e => e.IsDisabled && !string.IsNullOrEmpty(e.Hotkey))
                    .Select(e => $"'{e.Name}'({e.Hotkey})")
                    .ToList();
                DiagnosticLog.Info(
                    $"Hotkeys armed ({map.Count}): {armed}. Hotstrings: {hotstringMap.Count}." +
                    (skipped.Count > 0 ? $" Skipped (disabled w/ hotkey): {string.Join(", ", skipped)}." : ""));
            }
            catch (Exception ex) { DiagnosticLog.Info($"Hotkeys armed-summary log failed: {ex.Message}"); }
        }

        /// <summary>
        /// Derives the effective target (own > folder-inherited > none) for every entry and
        /// fills the EffectiveTarget* fields. Called after the profile order is loaded so
        /// folder membership is known. Idempotent — safe to call repeatedly after order
        /// changes (e.g. user moved profile into/out of a folder). Cheap (linear in
        /// ProfileEntries.Count), so PushProfilesUpdate refreshes before serializing.
        /// </summary>
        public void PopulateEffectiveTargets()
        {
            foreach (var entry in ProfileEntries)
            {
                if (entry.HasWindowTarget)
                {
                    entry.HasEffectiveTarget = true;
                    entry.EffectiveTargetSource = "own";
                    entry.EffectiveTargetFolderName = null;
                    entry.EffectiveTargetProcessName = entry.WindowTargetProcessName;
                    entry.EffectiveTargetWindowTitle = entry.WindowTargetWindowTitle;
                    entry.EffectiveTargetTitleMatchMode = entry.WindowTargetTitleMatchMode;
                    continue;
                }

                var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(entry.Name));
                var folderTarget = folder?.TargetWindow;
                bool folderHasTarget = folderTarget != null
                    && (!string.IsNullOrEmpty(folderTarget.ProcessName) || !string.IsNullOrEmpty(folderTarget.WindowTitle));

                if (folderHasTarget)
                {
                    entry.HasEffectiveTarget = true;
                    entry.EffectiveTargetSource = "folder";
                    entry.EffectiveTargetFolderName = folder!.Name;
                    entry.EffectiveTargetProcessName = folderTarget!.ProcessName;
                    entry.EffectiveTargetWindowTitle = folderTarget.WindowTitle;
                    entry.EffectiveTargetTitleMatchMode = folderTarget.TitleMatchMode;
                }
                else
                {
                    entry.HasEffectiveTarget = false;
                    entry.EffectiveTargetSource = null;
                    entry.EffectiveTargetFolderName = null;
                    entry.EffectiveTargetProcessName = null;
                    entry.EffectiveTargetWindowTitle = null;
                    entry.EffectiveTargetTitleMatchMode = "contains";
                }
            }
        }

        // Snapshot of WaitImage ImagePath references built during the last LoadProfileListAsync.
        // Consumed by the startup orphan-cleanup pass in MainWindow.
        public IReadOnlyDictionary<string, HashSet<string>> ReferencedImagesByProfile => _referencedImagesByProfile;
        // Profiles that exist on disk but FAILED to load this pass, mapped to their sanitized image
        // folder names. CleanupOrphanImages keeps these folders intact so a transient load failure
        // (corrupt/half-written JSON) doesn't permanently delete the profile's reference PNGs.
        public IReadOnlySet<string> FailedLoadFolders =>
            _loadFailures.Select(ImageStorageService.GetSanitizedProfileFolder).ToHashSet(StringComparer.OrdinalIgnoreCase);

        public async Task RefreshProfileListAsync(bool suppressWatcher = false)
        {
            if (suppressWatcher)
                suppressWatcherUntil = DateTime.UtcNow.AddSeconds(2);

            await LoadProfileListAsync();

            // Restore active profile state after list rebuild
            if (_activeProfileName != null)
                UpdateProfileColors(_activeProfileName);
        }

        public void RefreshProfileList(bool suppressWatcher = false)
        {
            // Fire-and-forget, but observe the task so a load/UI failure is logged instead of
            // vanishing into an unobserved-task exception (which would otherwise be silent).
            _ = RefreshProfileListAsync(suppressWatcher).ContinueWith(
                t => DiagnosticLog.Error("RefreshProfileList background refresh failed", t.Exception!.GetBaseException()),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
        }

        private void SetupProfileWatcher()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            if (!Directory.Exists(profileDir))
                Directory.CreateDirectory(profileDir);

            profileWatcher = new FileSystemWatcher(profileDir, "*.json")
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite
            };

            profileWatcher.Created += OnProfileFolderChanged;
            profileWatcher.Deleted += OnProfileFolderChanged;
            profileWatcher.Renamed += OnProfileFolderChanged;
            profileWatcher.EnableRaisingEvents = true;
        }

        private async void OnProfileFolderChanged(object sender, FileSystemEventArgs e)
        {
            // Ignore profile-order.json changes — it's not a profile file
            if (string.Equals(Path.GetFileName(e.FullPath), "profile-order.json", StringComparison.OrdinalIgnoreCase))
                return;

            // Atomically retire the in-flight debounce and start a fresh one. Without the lock,
            // two overlapping watcher callbacks could Cancel/Dispose the same CTS twice (or await
            // a disposed token) and both reach RefreshProfileList.
            CancellationToken token;
            lock (_debounceLock)
            {
                debounceCts?.Cancel();
                debounceCts?.Dispose();
                debounceCts = new CancellationTokenSource();
                token = debounceCts.Token;
            }

            try
            {
                await Task.Delay(300, token);
                if (!token.IsCancellationRequested)
                {
                    window.DispatcherQueue.TryEnqueue(() =>
                    {
                        if (DateTime.UtcNow < suppressWatcherUntil)
                            return;
                        RefreshProfileList();
                    });
                }
            }
            // TaskCanceledException: this debounce was superseded by a newer event.
            // ObjectDisposedException: the CTS this token belongs to was disposed by a
            // concurrent supersede/Dispose() between the snapshot and the await. Both are benign.
            catch (TaskCanceledException) { }
            catch (ObjectDisposedException) { }
        }

        #endregion // Profile List Management

        #region Profile UI Interactions

        public async Task<SaveDialogResult> ShowSaveOverwriteDialogAsync(string profileName)
        {
            var messageBlock = new TextBlock
            {
                Text = $"Profile \"{profileName}\" is already loaded.",
                TextWrapping = TextWrapping.Wrap
            };

            var dialog = new ContentDialog
            {
                Title = "Save Profile",
                XamlRoot = window.Content.XamlRoot,
                RequestedTheme = ElementTheme.Dark,
                PrimaryButtonText = "Overwrite",
                SecondaryButtonText = "Save as New",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                CornerRadius = new CornerRadius(8),
                Content = messageBlock
            };
            ApplyDialogTheme(dialog, messageBlock);

            InputHookManager.SuppressAllHotkeys = true;
            try
            {
                var result = await dialog.ShowAsync();
                return result switch
                {
                    ContentDialogResult.Primary => SaveDialogResult.Overwrite,
                    ContentDialogResult.Secondary => SaveDialogResult.SaveAsNew,
                    _ => SaveDialogResult.Cancel
                };
            }
            finally
            {
                InputHookManager.SuppressAllHotkeys = false;
            }
        }

        public async Task<ContentDialogResult> ShowUnsavedChangesDialogAsync()
        {
            var messageBlock = new TextBlock
            {
                Text = "You have unsaved actions. Save before closing?",
                TextWrapping = TextWrapping.Wrap
            };

            var dialog = new ContentDialog
            {
                Title = "Unsaved Changes",
                XamlRoot = window.Content.XamlRoot,
                RequestedTheme = ElementTheme.Dark,
                PrimaryButtonText = "Save",
                SecondaryButtonText = "Discard",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                CornerRadius = new CornerRadius(8),
                Content = messageBlock
            };
            ApplyDialogTheme(dialog, messageBlock);

            InputHookManager.SuppressAllHotkeys = true;
            try
            {
                return await dialog.ShowAsync();
            }
            finally
            {
                InputHookManager.SuppressAllHotkeys = false;
            }
        }

        public void UpdateProfileColors(string? activeProfileName)
        {
            _activeProfileName = activeProfileName;
            foreach (var entry in ProfileEntries)
                entry.IsActive = (activeProfileName != null && entry.Name == activeProfileName);
        }

        #endregion

        #region Profile Hotkey Management

        /// <summary>
        /// Hotkey collisions detected on the most recent <see cref="GetProfileHotkeys"/> call.
        /// Each entry is "Hotkey assigned to: A, B, C" — the bridge surfaces these as toasts
        /// so the user knows two profiles fight for the same combo. Cleared at the start of
        /// each GetProfileHotkeys call so we don't accumulate stale warnings.
        /// </summary>
        private readonly List<string> _hotkeyCollisions = new();

        public IReadOnlyList<string> GetAndClearHotkeyCollisions()
        {
            var copy = _hotkeyCollisions.ToList();
            _hotkeyCollisions.Clear();
            return copy;
        }

        public Dictionary<string, string> GetProfileHotkeys()
        {
            var hotkeys = new Dictionary<string, string>();
            _hotkeyCollisions.Clear();
            // Detect TRUE collisions only — two profiles with the same hotkey but DIFFERENT
            // target windows are intentionally supported: IsForegroundWindowMatch disambiguates
            // at fire time based on which window is foreground. That's a feature (e.g. Ctrl+F1
            // does action A in Roblox and action B in Notepad). The collision is only a real
            // problem when the targets overlap, which we approximate as identical (or both
            // null) — anything else is a designed-for, silent-by-design hotkey routing.
            var byHotkey = new Dictionary<string, List<ProfileEntry>>(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in ProfileEntries)
            {
                if (string.IsNullOrEmpty(entry.Hotkey) || entry.IsDisabled) continue;
                if (!byHotkey.TryGetValue(entry.Hotkey, out var list))
                {
                    list = new List<ProfileEntry>();
                    byHotkey[entry.Hotkey] = list;
                }
                list.Add(entry);
                hotkeys[entry.Name] = entry.Hotkey;
            }

            foreach (var (hotkey, candidates) in byHotkey)
            {
                if (candidates.Count <= 1) continue;
                // Group by effective target signature. Profiles in the SAME bucket overlap →
                // real collision. Profiles in DIFFERENT buckets are routed by foreground gate.
                var byTargetSignature = candidates
                    .GroupBy(e => GetEffectiveTargetSignature(e))
                    .Where(g => g.Count() > 1);

                foreach (var collidingGroup in byTargetSignature)
                {
                    var names = collidingGroup.Select(e => e.Name).ToList();
                    var targetDesc = string.IsNullOrEmpty(collidingGroup.Key)
                        ? "no target window"
                        : $"target '{collidingGroup.Key}'";
                    _hotkeyCollisions.Add(
                        $"Hotkey '{hotkey}' is bound to {names.Count} profiles with the same {targetDesc}: " +
                        $"{string.Join(", ", names)} — only one will fire");
                }
            }

            return hotkeys;
        }

        /// <summary>
        /// Produces a stable string describing an entry's EFFECTIVE target window (own or
        /// folder-inherited). Used to detect "real" hotkey collisions — profiles with the
        /// same hotkey but different target signatures coexist fine because the foreground
        /// gate routes between them. Empty string when the entry has no effective target.
        /// </summary>
        private static string GetEffectiveTargetSignature(ProfileEntry e)
        {
            if (!e.HasEffectiveTarget) return "";
            var proc = e.EffectiveTargetProcessName ?? "";
            var title = e.EffectiveTargetWindowTitle ?? "";
            var mode = e.EffectiveTargetTitleMatchMode ?? "contains";
            return $"{proc.ToLowerInvariant()}|{title}|{mode}";
        }

        public Dictionary<string, TriggerMode> GetProfileTriggerModes()
        {
            var modes = new Dictionary<string, TriggerMode>();

            foreach (var entry in ProfileEntries)
            {
                if (!string.IsNullOrEmpty(entry.Hotkey) && !entry.IsDisabled)
                    modes[entry.Name] = entry.TriggerMode;
            }

            return modes;
        }

        public Dictionary<string, HotstringConfig> GetProfileHotstrings()
        {
            var hotstrings = new Dictionary<string, HotstringConfig>();

            foreach (var entry in ProfileEntries)
            {
                if (!string.IsNullOrEmpty(entry.Hotstring) && !entry.IsDisabled)
                {
                    hotstrings[entry.Name] = new HotstringConfig
                    {
                        Sequence = entry.Hotstring.ToLowerInvariant(),
                        Instant = entry.HotstringInstant
                    };
                }
            }

            return hotstrings;
        }

        public Dictionary<string, WindowTarget> GetProfileWindowTargets()
        {
            var effective = new Dictionary<string, WindowTarget>(_cachedWindowTargets);

            // Add folder-inherited targets for profiles without their own target
            foreach (var entry in ProfileEntries)
            {
                if (effective.ContainsKey(entry.Name)) continue;
                var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(entry.Name));
                if (folder?.TargetWindow != null &&
                    (!string.IsNullOrEmpty(folder.TargetWindow.ProcessName) || !string.IsNullOrEmpty(folder.TargetWindow.WindowTitle)))
                {
                    effective[entry.Name] = folder.TargetWindow;
                }
            }

            return effective;
        }

        public WindowTarget? GetEffectiveWindowTarget(string profileName)
        {
            if (_cachedWindowTargets.TryGetValue(profileName, out var profileTarget))
                return profileTarget;

            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            if (folder?.TargetWindow != null &&
                (!string.IsNullOrEmpty(folder.TargetWindow.ProcessName) || !string.IsNullOrEmpty(folder.TargetWindow.WindowTitle)))
                return folder.TargetWindow;

            return null;
        }

        public bool GetEffectiveRelativeCoordinates(string profileName)
        {
            // Profile's own target takes priority
            if (_cachedWindowTargets.ContainsKey(profileName))
            {
                var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
                return entry?.UseRelativeCoordinates ?? false;
            }
            // Folder target inheritance
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            return folder?.UseRelativeCoordinates ?? false;
        }

        public bool GetEffectiveBringToFocus(string profileName)
        {
            if (_cachedWindowTargets.ContainsKey(profileName))
            {
                var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
                return entry?.BringToFocus ?? false;
            }
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            return folder?.BringToFocus ?? false;
        }

        // Effective Restore Position/Size + geometry. Profile's own values take priority when the
        // profile has its own target; otherwise fall back to the folder. A profile that has no
        // target and is not in a folder with a target gets defaults (false/0). The fall-through
        // mirrors the BringToFocus/UseRelativeCoordinates pattern above.
        public bool GetEffectiveRestorePosition(string profileName)
        {
            if (_cachedWindowTargets.ContainsKey(profileName))
            {
                var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
                return entry?.RestorePosition ?? false;
            }
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            return folder?.RestorePosition ?? false;
        }

        public bool GetEffectiveRestoreSize(string profileName)
        {
            if (_cachedWindowTargets.ContainsKey(profileName))
            {
                var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
                return entry?.RestoreSize ?? false;
            }
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            return folder?.RestoreSize ?? false;
        }

        /// <summary>
        /// Effective geometry (WindowX/Y/Width/Height) for the given profile. The profile's own
        /// geometry (kept on the UserProfile loaded from disk) is consulted by the caller —
        /// this helper only returns folder-inherited values to use as a fallback when the
        /// profile has no own target. Returns null when no folder geometry applies.
        /// </summary>
        public (int X, int Y, int Width, int Height)? GetFolderInheritedGeometry(string profileName)
        {
            // Only fall back to the folder when the profile has no target of its own. Profiles
            // with own target are expected to carry their own geometry too.
            if (_cachedWindowTargets.ContainsKey(profileName)) return null;
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            if (folder == null) return null;
            // Geometry is meaningful only when both dimensions are positive — a real window
            // always has width > 0 and height > 0. Width/height of zero means "not captured
            // yet" (or corrupted) and would yield an invalid SetWindowPos call downstream.
            // X/Y can legitimately be zero (top-left of primary monitor), so don't check them.
            if (folder.WindowWidth <= 0 || folder.WindowHeight <= 0) return null;
            return (folder.WindowX, folder.WindowY, folder.WindowWidth, folder.WindowHeight);
        }

        /// <summary>
        /// Folder-inherited execution context for a profile that has no target of its own.
        /// Returns null when the profile already has its own target (caller should use the
        /// profile's own values), or when no folder applies / the folder has no target.
        /// Used by the RunProfile chaining path so a sub-profile inheriting from its folder
        /// actually switches into the folder's context, instead of running against the
        /// caller's window.
        /// </summary>
        public readonly record struct FolderInheritedContext(
            WindowTarget Target,
            bool UseRelativeCoordinates,
            bool BringToFocus,
            bool RestorePosition,
            bool RestoreSize,
            int X, int Y, int Width, int Height);

        public FolderInheritedContext? GetFolderInheritedContext(string profileName)
        {
            // Profile has own target → no folder inheritance applies. Caller uses the profile's
            // disk-loaded values directly.
            if (_cachedWindowTargets.ContainsKey(profileName)) return null;
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(profileName));
            if (folder?.TargetWindow == null) return null;
            if (string.IsNullOrEmpty(folder.TargetWindow.ProcessName)
                && string.IsNullOrEmpty(folder.TargetWindow.WindowTitle)) return null;
            // Geometry only forwarded when both dimensions are populated — same rule as
            // GetFolderInheritedGeometry; SetWindowPos with zero size would be invalid.
            bool hasGeom = folder.WindowWidth > 0 && folder.WindowHeight > 0;
            return new FolderInheritedContext(
                folder.TargetWindow,
                folder.UseRelativeCoordinates,
                folder.BringToFocus,
                folder.RestorePosition,
                folder.RestoreSize,
                hasGeom ? folder.WindowX : 0,
                hasGeom ? folder.WindowY : 0,
                hasGeom ? folder.WindowWidth : 0,
                hasGeom ? folder.WindowHeight : 0);
        }

        public async Task SetFolderWindowTargetAsync(
            string folderName,
            WindowTarget target,
            bool relativeCoordinates = false,
            bool bringToFocus = false,
            bool restorePosition = false,
            bool restoreSize = false)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                folder.TargetWindow = target;
                folder.UseRelativeCoordinates = relativeCoordinates;
                folder.BringToFocus = bringToFocus;
                folder.RestorePosition = restorePosition;
                folder.RestoreSize = restoreSize;
                await SaveProfileOrderAsync();
            }
        }

        public async Task SetFolderGeometryAsync(string folderName, int x, int y, int width, int height)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                folder.WindowX = x;
                folder.WindowY = y;
                folder.WindowWidth = width;
                folder.WindowHeight = height;
                await SaveProfileOrderAsync();
            }
        }

        public HashSet<string> GetBringToFocusProfiles()
        {
            var set = new HashSet<string>();
            foreach (var entry in ProfileEntries)
            {
                if (entry.IsDisabled) continue;
                // Profile's own bring-to-focus
                if (entry.BringToFocus && entry.HasWindowTarget)
                {
                    set.Add(entry.Name);
                    continue;
                }
                // Folder-inherited bring-to-focus
                if (!entry.HasWindowTarget)
                {
                    var folder = _profileOrder.Folders.FirstOrDefault(f => f.Items.Contains(entry.Name));
                    if (folder?.BringToFocus == true && folder.TargetWindow != null)
                        set.Add(entry.Name);
                }
            }
            return set;
        }

        public async Task RemoveFolderWindowTargetAsync(string folderName)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                // Mirror HandleProfileRemoveWindowTarget on profiles: wipe everything dependent
                // on the target so we don't leave dangling Restore Position/Size toggles or
                // orphaned geometry. The user can re-set it later from scratch.
                folder.TargetWindow = null;
                folder.UseRelativeCoordinates = false;
                folder.BringToFocus = false;
                folder.RestorePosition = false;
                folder.RestoreSize = false;
                folder.WindowX = 0;
                folder.WindowY = 0;
                folder.WindowWidth = 0;
                folder.WindowHeight = 0;
                await SaveProfileOrderAsync();
            }
        }

        #endregion

        #region Profile Export/Import

        public async Task<bool> ExportProfilesAsync(List<string> profileNames, bool includeOrganization = false)
        {
            var envelope = new ProfileExportEnvelope();

            foreach (var name in profileNames)
            {
                var profile = await LoadProfileByNameAsync(name);
                if (profile == null) continue;

                // Collect reference images for WaitImage AND IF Image rows — both share the
                // same per-profile PNG storage, so an exported envelope that bundles only the
                // WaitImage PNGs would arrive at the receiver with broken IF Image rows.
                Dictionary<string, string>? images = null;
                foreach (var action in profile.Actions)
                {
                    if (string.IsNullOrEmpty(action.ImagePath)) continue;
                    bool refsImage = action.ActionType == "WaitImage"
                        || (action.ActionType == "If" && string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase));
                    if (refsImage)
                    {
                        var base64 = ImageStorageService.ReadAsBase64(name, action.ImagePath);
                        if (base64 != null)
                        {
                            images ??= new Dictionary<string, string>();
                            images[action.ImagePath] = base64;
                        }
                    }
                }

                // Recompute AppMinVersion on every export so the value always reflects the current
                // action set — never trust the last persisted value, since the user may have
                // edited the profile since the last export and added/removed gating features.
                var computedMinVersion = ProfileCompatibility.ComputeMinVersion(profile);

                envelope.Profiles.Add(new ProfileExportEntry
                {
                    Name = name,
                    CustomHotkey = profile.CustomHotkey,
                    CustomHotstring = profile.CustomHotstring,
                    TargetWindow = profile.TargetWindow,
                    UseRelativeCoordinates = profile.UseRelativeCoordinates,
                    WindowWidth = profile.WindowWidth,
                    WindowHeight = profile.WindowHeight,
                    WindowX = profile.WindowX,
                    WindowY = profile.WindowY,
                    RestorePosition = profile.RestorePosition,
                    RestoreSize = profile.RestoreSize,
                    BringToFocus = profile.BringToFocus,
                    TriggerMode = profile.TriggerMode,
                    BatchDelay = profile.BatchDelay,
                    Actions = profile.Actions,
                    Images = images,
                    // Sharing metadata — copy verbatim from the source profile so the .trprofile
                    // carries description/tags/etc for the receiver's Import Preview.
                    Description = profile.Description,
                    Tags = profile.Tags,
                    CreatedAt = profile.CreatedAt,
                    UpdatedAt = profile.UpdatedAt,
                    ProfileVersion = profile.ProfileVersion,
                    AppMinVersion = computedMinVersion,
                    IconEmoji = profile.IconEmoji
                });
            }

            if (envelope.Profiles.Count == 0) return false;

            if (includeOrganization)
            {
                var exportedNames = new HashSet<string>(envelope.Profiles.Select(p => p.Name));
                envelope.Organization = new ProfileExportOrganization
                {
                    Pinned = _profileOrder.Pinned.Where(n => exportedNames.Contains(n)).ToList(),
                    Folders = _profileOrder.Folders
                        .Where(f => f.Items.Any(i => exportedNames.Contains(i)))
                        .Select(f => new ProfileFolder
                        {
                            Name = f.Name,
                            Color = f.Color,
                            Collapsed = false,
                            Items = f.Items.Where(i => exportedNames.Contains(i)).ToList(),
                            TargetWindow = f.TargetWindow,
                            UseRelativeCoordinates = f.UseRelativeCoordinates,
                            BringToFocus = f.BringToFocus,
                            RestorePosition = f.RestorePosition,
                            RestoreSize = f.RestoreSize,
                            WindowX = f.WindowX,
                            WindowY = f.WindowY,
                            WindowWidth = f.WindowWidth,
                            WindowHeight = f.WindowHeight
                        }).ToList(),
                    UngroupedOrder = _profileOrder.UngroupedOrder.Where(n => exportedNames.Contains(n)).ToList()
                };
            }

            var defaultName = envelope.Profiles.Count == 1
                ? envelope.Profiles[0].Name
                : "profiles";

            var fileName = await ShowFileDialogAsync(new WinForms.SaveFileDialog
            {
                Filter = "TrueReplayer Profile (*.trprofile)|*.trprofile",
                FileName = defaultName,
                DefaultExt = "trprofile"
            });

            if (fileName == null) return false;

            var options = new JsonSerializerOptions
            {
                WriteIndented = true,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var json = JsonSerializer.Serialize(envelope, options);
            await File.WriteAllTextAsync(fileName, json);
            return true;
        }

        /// <summary>
        /// Phase 1 of the two-step import flow. Opens the file picker and parses the .trprofile
        /// envelope without writing anything to disk. Caller (WebViewBridge.HandleProfileImport)
        /// holds the parsed envelope server-side and ships preview metadata to the frontend so
        /// the user can review + select before any disk write happens.
        ///
        /// Returns (null, null) when the user cancels the picker or the file is invalid — the
        /// bridge layer maps both to a no-op (no preview dialog opens).
        /// </summary>
        public async Task<(ProfileExportEnvelope? envelope, string? filePath)> PrepareImportPreviewAsync()
        {
            var fileName = await ShowFileDialogAsync(new WinForms.OpenFileDialog
            {
                Filter = "TrueReplayer Profile (*.trprofile)|*.trprofile",
                DefaultExt = "trprofile"
            });

            if (fileName == null) return (null, null);

            try
            {
                var json = await File.ReadAllTextAsync(fileName);
                json = SettingsManager.MigrateProfileJson(json);
                var options = new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
                };
                var envelope = JsonSerializer.Deserialize<ProfileExportEnvelope>(json, options);
                if (envelope?.Profiles == null || envelope.Profiles.Count == 0) return (null, null);
                return (envelope, fileName);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[ProfileController] PrepareImportPreview error: {ex.Message}");
                return (null, null);
            }
        }

        /// <summary>
        /// Phase 2 of the two-step import flow. Writes the user-selected subset of profiles
        /// from a previously parsed envelope, using the per-profile conflict resolution
        /// decided ahead-of-time in the React Import Preview dialog. Filters out profiles
        /// whose AppMinVersion exceeds the running app version as a safety net (the
        /// frontend already disables them, but trust-and-verify).
        ///
        /// `conflictResolutions` maps the source profile name → Overwrite | Rename | Skip.
        /// Missing entries default to Rename (safest — never silently destroys local work).
        /// The old `ShowImportConflictDialogAsync` is no longer called; the React dialog
        /// surfaces all decisions up-front so the import runs without further prompts.
        /// </summary>
        public async Task<(int imported, int skipped, bool hasOrganization)> ConfirmImportAsync(
            ProfileExportEnvelope envelope,
            HashSet<string> selectedNames,
            Dictionary<string, ImportConflictResult> conflictResolutions)
        {
            bool hasOrganization = envelope.Organization != null;
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles");
            Directory.CreateDirectory(profileDir);

            string runningVersion = typeof(ProfileController).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

            int imported = 0;
            int skipped = 0;

            // Canonical Profiles dir (with trailing separator) for the containment check below.
            string canonicalProfileDir = Path.GetFullPath(profileDir);
            if (!canonicalProfileDir.EndsWith(Path.DirectorySeparatorChar))
                canonicalProfileDir += Path.DirectorySeparatorChar;

            // Only iterate the entries the user actually selected. Maintains source order so
            // multi-profile imports feel deterministic.
            var toImport = envelope.Profiles.Where(p => selectedNames.Contains(p.Name)).ToList();

            // Names already claimed by earlier entries in THIS batch. The rename loop below only
            // consulted File.Exists, which misses collisions against an earlier selected entry that
            // either (a) shares the same source name with no pre-existing file on disk, or (b) was
            // assigned a "name (N)" that a later entry then independently computes to the same value.
            // Tracking allocations here keeps the numbering consistent and prevents two imports
            // silently resolving to the same path. Seeded as collisions are resolved below.
            var allocatedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in toImport)
            {
                // Hard compatibility gate — refuse to write a profile the running app can't run.
                // Frontend already filters but a stale preview or hand-crafted message could slip
                // through. Counted as skipped so the user sees the number.
                if (!ProfileCompatibility.IsCompatible(entry.AppMinVersion, runningVersion))
                {
                    skipped++;
                    continue;
                }
                // Authoritative path-traversal guard. entry.Name comes verbatim from the untrusted
                // .trprofile envelope and feeds Path.Combine below; a name like "..\\..\\evil" would
                // escape the Profiles dir. Reject anything that isn't a bare file name. Skipped+counted
                // so a poisoned entry never silently writes outside the sandbox.
                if (!IsSafeProfileName(entry.Name))
                {
                    skipped++;
                    continue;
                }
                string targetPath = Path.Combine(profileDir, entry.Name + ".json");
                string finalName = entry.Name;

                // Treat a name claimed by an earlier batch entry the same as a name already on disk —
                // both must trigger conflict resolution so we never assign two imports the same path.
                if (File.Exists(targetPath) || allocatedNames.Contains(finalName))
                {
                    // Look up the user's decision from the preview dialog. Default Rename when
                    // the entry is missing — matches the safest default the dialog already uses.
                    var resolution = conflictResolutions.TryGetValue(entry.Name, out var r)
                        ? r
                        : ImportConflictResult.Rename;

                    if (resolution == ImportConflictResult.Skip)
                    {
                        skipped++;
                        continue;
                    }

                    if (resolution == ImportConflictResult.Rename)
                    {
                        int counter = 2;
                        do
                        {
                            finalName = $"{entry.Name} ({counter})";
                            targetPath = Path.Combine(profileDir, finalName + ".json");
                            counter++;
                        } while (File.Exists(targetPath) || allocatedNames.Contains(finalName));
                    }
                    // Overwrite: leave targetPath / finalName as-is — File.WriteAllTextAsync below
                    // replaces the existing file atomically. Guard against a second selected entry
                    // also overwriting the SAME target: if an earlier batch entry already claimed
                    // this name, fall back to a fresh "name (N)" so the later import isn't lost.
                    else if (resolution == ImportConflictResult.Overwrite && allocatedNames.Contains(finalName))
                    {
                        int counter = 2;
                        do
                        {
                            finalName = $"{entry.Name} ({counter})";
                            targetPath = Path.Combine(profileDir, finalName + ".json");
                            counter++;
                        } while (File.Exists(targetPath) || allocatedNames.Contains(finalName));
                    }
                }

                var profile = new UserProfile
                {
                    Actions = entry.Actions ?? new ObservableCollection<ActionItem>(),
                    CustomHotkey = entry.CustomHotkey,
                    CustomHotstring = entry.CustomHotstring,
                    TargetWindow = entry.TargetWindow,
                    UseRelativeCoordinates = entry.UseRelativeCoordinates,
                    WindowWidth = entry.WindowWidth,
                    WindowHeight = entry.WindowHeight,
                    WindowX = entry.WindowX,
                    WindowY = entry.WindowY,
                    RestorePosition = entry.RestorePosition,
                    RestoreSize = entry.RestoreSize,
                    BringToFocus = entry.BringToFocus,
                    TriggerMode = entry.TriggerMode,
                    BatchDelay = entry.BatchDelay ?? "Delay (ms)",
                    // Round-trip sharing metadata. Pre-metadata .trprofile files leave these null
                    // (System.Text.Json default-inits when the property is missing in the JSON),
                    // which is exactly what we want — the Info tab will render "Unknown" / empty.
                    Description = entry.Description,
                    Tags = entry.Tags,
                    CreatedAt = entry.CreatedAt,
                    UpdatedAt = entry.UpdatedAt,
                    // ProfileVersion has a non-null default of 1 on ProfileExportEntry, so a missing
                    // field in the JSON deserializes to 1 anyway. Keep that behaviour explicit here.
                    ProfileVersion = entry.ProfileVersion > 0 ? entry.ProfileVersion : 1,
                    AppMinVersion = entry.AppMinVersion,
                    IconEmoji = entry.IconEmoji
                };
                SettingsManager.MigrateRestoreSize(profile);

                // Defense in depth: confirm the resolved write path stays directly inside the
                // Profiles dir before writing. Also re-validates the rename-derived finalName
                // ("name (N)"). Mirrors ImageStorageService.TryResolveImageFile's containment check.
                if (!Path.GetFullPath(targetPath).StartsWith(canonicalProfileDir, StringComparison.OrdinalIgnoreCase))
                {
                    skipped++;
                    continue;
                }

                // Claim this name for the batch BEFORE writing so subsequent entries see it even
                // though the write below is what makes it visible to File.Exists.
                allocatedNames.Add(finalName);

                await SettingsManager.SaveProfileAsync(targetPath, profile);

                // Restore embedded WaitImage reference images
                if (entry.Images != null && entry.Images.Count > 0)
                {
                    foreach (var kvp in entry.Images)
                    {
                        ImageStorageService.SaveFromBase64(kvp.Value, finalName, kvp.Key);
                    }
                }

                imported++;
            }

            if (imported > 0)
                await RefreshProfileListAsync(true);

            // Merge organization if present
            if (hasOrganization && imported > 0)
                await MergeImportedOrganizationAsync(envelope.Organization!);

            return (imported, skipped, hasOrganization);
        }

        // Guards against a malicious/buggy .trprofile envelope smuggling path separators or
        // traversal into a profile name that later feeds Path.Combine. The persisted name must be
        // a bare file name (no directory components, no invalid chars). Mirrors
        // WebViewBridge.IsSafeProfileName (kept local — different class, no shared owner for it).
        private static bool IsSafeProfileName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
            if (name == "." || name == "..") return false;
            string baseName = name.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? name[..^5] : name;
            if (string.IsNullOrWhiteSpace(baseName)) return false;
            if (baseName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
            return true;
        }

        private async Task MergeImportedOrganizationAsync(ProfileExportOrganization org)
        {
            // Only honour pins/folder-membership for profiles that actually landed on disk.
            // ConfirmImportAsync may have skipped (conflict=Skip / incompatible / unsafe name)
            // or renamed entries ("name (2)"), and it doesn't expose the original->finalName map,
            // so we gate on the post-import profile list. RefreshProfileListAsync(true) ran in the
            // caller before this, so ProfileEntries reflects what's on disk now.
            // LIMITATION: renamed imports won't be re-pinned/re-foldered under their new name —
            // acceptable trade-off vs. threading the rename map through ConfirmImportAsync, and it
            // never produces dangling references to names that don't exist.
            var onDisk = ProfileEntries.Select(p => p.Name).ToHashSet();

            // Merge pinned: add new pinned items that aren't already pinned
            foreach (var name in org.Pinned)
            {
                if (onDisk.Contains(name) && !_profileOrder.Pinned.Contains(name))
                    _profileOrder.Pinned.Add(name);
            }

            // Merge folders: add new folders, merge items into existing folders
            foreach (var importedFolder in org.Folders)
            {
                // Copy into a fresh list (don't alias the deserialized, untrusted collection into
                // the long-lived _profileOrder) and keep only items that actually exist on disk.
                var folderItems = importedFolder.Items.Where(onDisk.Contains).ToList();

                var existingFolder = _profileOrder.Folders.FirstOrDefault(f => f.Name == importedFolder.Name);
                if (existingFolder != null)
                {
                    // Merge items into existing folder
                    foreach (var item in folderItems)
                    {
                        if (!existingFolder.Items.Contains(item))
                            existingFolder.Items.Add(item);
                    }
                }
                else
                {
                    // Add as new folder
                    _profileOrder.Folders.Add(new ProfileFolder
                    {
                        Name = importedFolder.Name,
                        Color = importedFolder.Color,
                        Collapsed = false,
                        Items = folderItems,
                        TargetWindow = importedFolder.TargetWindow,
                        UseRelativeCoordinates = importedFolder.UseRelativeCoordinates,
                        BringToFocus = importedFolder.BringToFocus,
                        RestorePosition = importedFolder.RestorePosition,
                        RestoreSize = importedFolder.RestoreSize,
                        WindowX = importedFolder.WindowX,
                        WindowY = importedFolder.WindowY,
                        WindowWidth = importedFolder.WindowWidth,
                        WindowHeight = importedFolder.WindowHeight
                    });
                }

                // Remove imported folder items from ungrouped
                foreach (var item in folderItems)
                    _profileOrder.UngroupedOrder.Remove(item);
            }

            await SaveProfileOrderAsync();
        }

        // ShowImportConflictDialogAsync was removed in 2.2.0 — conflict resolution moved
        // into the React Import Preview dialog (per-profile inline picker + bulk toolbar),
        // which eliminates the awkward C# dialog that crammed Overwrite/Rename/Skip plus
        // Overwrite-All/Skip-All into one screen. See ImportPreviewDialog.tsx.

        #endregion

        #region Profile Organization (Folders + Pin)

        public ProfileOrderData GetProfileOrder() => _profileOrder;

        private async Task LoadProfileOrderAsync()
        {
            try
            {
                if (File.Exists(ProfileOrderPath))
                {
                    var json = await File.ReadAllTextAsync(ProfileOrderPath);
                    _profileOrder = JsonSerializer.Deserialize<ProfileOrderData>(json, OrderJsonOptions) ?? new ProfileOrderData();
                }
                else
                {
                    _profileOrder = new ProfileOrderData();
                }
            }
            catch (Exception ex)
            {
                // The order file exists but won't parse. Resetting to an empty order and letting a
                // later save run would PERMANENTLY wipe the user's folders/pins/colours — UNLESS the
                // original bytes are preserved first. So: copy the unreadable file to .bak (the
                // recovery point) and alert the user, THEN reset to an empty order. A subsequent save
                // may overwrite the corrupt original, but the .bak keeps a faithful copy to restore
                // from, and not blocking saves means the user's first layout edit still persists.
                System.Diagnostics.Debug.WriteLine($"[ProfileController] LoadProfileOrder parse failed: {ex.Message}");
                try
                {
                    string backupPath = ProfileOrderPath + ".bak";
                    File.Copy(ProfileOrderPath, backupPath, overwrite: true);
                    OnAlert?.Invoke($"Couldn't read your profile organisation (folders/pins). The unreadable file was backed up to {Path.GetFileName(backupPath)}; your layout was reset.");
                }
                catch (Exception backupEx)
                {
                    System.Diagnostics.Debug.WriteLine($"[ProfileController] LoadProfileOrder backup failed: {backupEx.Message}");
                    OnAlert?.Invoke("Couldn't read your profile organisation (folders/pins); your layout was reset.");
                }
                _profileOrder = new ProfileOrderData();
            }

            // Clean stale references (profiles that no longer exist on disk)
            var existingNames = ProfileEntries.Select(p => p.Name).ToHashSet();
            _profileOrder.Pinned.RemoveAll(n => !existingNames.Contains(n));
            foreach (var folder in _profileOrder.Folders)
                folder.Items.RemoveAll(n => !existingNames.Contains(n));
            _profileOrder.Folders.RemoveAll(f => f.Items.Count == 0 && string.IsNullOrEmpty(f.Name));
            _profileOrder.UngroupedOrder.RemoveAll(n => !existingNames.Contains(n));

            // Add any profiles not mentioned in order data to ungrouped
            var allReferenced = new HashSet<string>(_profileOrder.Pinned);
            foreach (var folder in _profileOrder.Folders)
                foreach (var item in folder.Items)
                    allReferenced.Add(item);
            foreach (var item in _profileOrder.UngroupedOrder)
                allReferenced.Add(item);

            foreach (var entry in ProfileEntries)
            {
                if (!allReferenced.Contains(entry.Name))
                    _profileOrder.UngroupedOrder.Add(entry.Name);
            }

            // Heal duplicate folder names (case-insensitive) that may have slipped in before the
            // create/rename guards existed. Duplicates break every by-Name folder lookup (delete /
            // colour / folder-inherited target all hit the FIRST match, orphaning the rest), so we
            // trim names and suffix the later collisions "Name (2)", "Name (3)", … Persisted only
            // when something actually changed; deterministic, so it re-heals on every load anyway.
            var seenFolderNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool folderNamesChanged = false;
            foreach (var folder in _profileOrder.Folders)
            {
                var baseName = (folder.Name ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(baseName)) baseName = "Folder";
                var unique = baseName;
                int suffix = 2;
                while (seenFolderNames.Contains(unique)) unique = $"{baseName} ({suffix++})";
                if (!string.Equals(unique, folder.Name, StringComparison.Ordinal))
                {
                    folder.Name = unique;
                    folderNamesChanged = true;
                }
                seenFolderNames.Add(unique);
            }
            if (folderNamesChanged) await SaveProfileOrderAsync();
        }

        public async Task SaveProfileOrderAsync()
        {
            await _profileOrderLock.WaitAsync();
            try
            {
                var json = JsonSerializer.Serialize(_profileOrder, OrderJsonOptions);
                await Services.FileHelper.WriteAllTextAtomicAsync(ProfileOrderPath, json);
            }
            catch (Exception ex)
            {
                // Non-fatal: a failed order write loses only pin/folder layout, not profile data.
                // Log to DiagnosticLog (not Debug-only) so the silent failure is diagnosable.
                DiagnosticLog.Error("SaveProfileOrder write failed", ex);
            }
            finally
            {
                _profileOrderLock.Release();
            }
        }

        public async Task RemoveProfileFromOrderAsync(string name)
        {
            _profileOrder.Pinned.Remove(name);
            _profileOrder.UngroupedOrder.Remove(name);
            foreach (var folder in _profileOrder.Folders)
                folder.Items.Remove(name);
            // Remove empty folders? No — user may want to keep them
            await SaveProfileOrderAsync();
        }

        public async Task RenameProfileInOrderAsync(string oldName, string newName)
        {
            // Update pinned
            var pinnedIndex = _profileOrder.Pinned.IndexOf(oldName);
            if (pinnedIndex >= 0) _profileOrder.Pinned[pinnedIndex] = newName;

            // Update folders
            foreach (var folder in _profileOrder.Folders)
            {
                var itemIndex = folder.Items.IndexOf(oldName);
                if (itemIndex >= 0) folder.Items[itemIndex] = newName;
            }

            // Update ungrouped order
            var ungroupedIndex = _profileOrder.UngroupedOrder.IndexOf(oldName);
            if (ungroupedIndex >= 0) _profileOrder.UngroupedOrder[ungroupedIndex] = newName;

            await SaveProfileOrderAsync();
        }

        public async Task PinProfileAsync(string name)
        {
            if (!_profileOrder.Pinned.Contains(name))
                _profileOrder.Pinned.Add(name);
            await SaveProfileOrderAsync();
        }

        public async Task UnpinProfileAsync(string name)
        {
            _profileOrder.Pinned.Remove(name);
            await SaveProfileOrderAsync();
        }

        // Returns false (changing nothing) when a folder with the same name already exists —
        // compared trimmed + case-insensitively so "Work", "work" and "Work " can't coexist.
        // Duplicate folder names break folder identity (every folder lookup is by Name), so the
        // bridge surfaces a toast on false instead of the old silent no-op.
        public async Task<bool> CreateFolderAsync(string folderName, string color)
        {
            folderName = (folderName ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(folderName)) return false;
            if (_profileOrder.Folders.Any(f => string.Equals(f.Name, folderName, StringComparison.OrdinalIgnoreCase)))
                return false;
            _profileOrder.Folders.Insert(0, new ProfileFolder { Name = folderName, Color = color });
            await SaveProfileOrderAsync();
            return true;
        }

        // Returns false (without renaming) when the target name is empty or already used by a
        // DIFFERENT folder (trimmed + case-insensitive). Renaming a folder onto an existing name
        // used to silently create two folders sharing a name, which corrupts every by-Name lookup
        // (delete / colour / folder-inherited target all hit the wrong one).
        public async Task<bool> RenameFolderAsync(string oldName, string newName)
        {
            newName = (newName ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(newName)) return false;
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == oldName);
            if (folder == null) return false;
            // Exact-same-name (ordinal) rename is a no-op → success. A pure re-casing of self
            // ("Work" → "work") is intentionally NOT short-circuited here — it falls through to the
            // collision check below, which excludes THIS folder via ReferenceEquals and then applies
            // a real rename. Do NOT switch this to OrdinalIgnoreCase: that would silently drop
            // legitimate case-only renames.
            if (string.Equals(folder.Name, newName, StringComparison.Ordinal)) return true;
            if (_profileOrder.Folders.Any(f => !ReferenceEquals(f, folder)
                    && string.Equals(f.Name, newName, StringComparison.OrdinalIgnoreCase)))
                return false;
            folder.Name = newName;
            await SaveProfileOrderAsync();
            return true;
        }

        public async Task DeleteFolderAsync(string folderName, bool deleteProfiles = false)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                if (deleteProfiles)
                {
                    // Delete all profile files inside the folder
                    foreach (var item in folder.Items)
                    {
                        var entry = ProfileEntries.FirstOrDefault(p => p.Name == item);
                        if (entry != null && File.Exists(entry.FilePath))
                        {
                            try { File.Delete(entry.FilePath); } catch { }
                        }
                        // Remove the deleted profile from every order bucket — not just Pinned —
                        // so its name can't linger as a ghost in UngroupedOrder.
                        _profileOrder.Pinned.Remove(item);
                        _profileOrder.UngroupedOrder.Remove(item);
                    }
                }
                else
                {
                    // Move items back to ungrouped
                    foreach (var item in folder.Items)
                    {
                        if (!_profileOrder.UngroupedOrder.Contains(item))
                            _profileOrder.UngroupedOrder.Add(item);
                    }
                }
                _profileOrder.Folders.Remove(folder);
                await SaveProfileOrderAsync();

                if (deleteProfiles)
                    await RefreshProfileListAsync(true);
            }
        }

        public async Task SetFolderColorAsync(string folderName, string color)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                folder.Color = color;
                await SaveProfileOrderAsync();
            }
        }

        public async Task ToggleFolderCollapseAsync(string folderName)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                folder.Collapsed = !folder.Collapsed;
                await SaveProfileOrderAsync();
            }
        }

        /// <summary>
        /// Bulk set the collapsed flag on every folder. Used by the "Collapse all
        /// folders" / "Expand all folders" context-menu item — avoids the N disk
        /// writes that iterating per-folder ToggleFolderCollapseAsync would cause.
        /// No-op (no save) if nothing actually changes.
        /// </summary>
        public async Task SetAllFoldersCollapsedAsync(bool collapsed)
        {
            bool changed = false;
            foreach (var folder in _profileOrder.Folders)
            {
                if (folder.Collapsed != collapsed)
                {
                    folder.Collapsed = collapsed;
                    changed = true;
                }
            }
            if (changed) await SaveProfileOrderAsync();
        }

        public async Task MoveToFolderAsync(string profileName, string? folderName)
        {
            // Remove from current folder or ungrouped
            foreach (var folder in _profileOrder.Folders)
                folder.Items.Remove(profileName);
            _profileOrder.UngroupedOrder.Remove(profileName);

            if (folderName != null)
            {
                var targetFolder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
                if (targetFolder != null && !targetFolder.Items.Contains(profileName))
                    targetFolder.Items.Add(profileName);
            }
            else
            {
                // Move to ungrouped
                if (!_profileOrder.UngroupedOrder.Contains(profileName))
                    _profileOrder.UngroupedOrder.Add(profileName);
            }

            await SaveProfileOrderAsync();
        }

        public async Task ReorderProfilesAsync(List<string>? pinned, List<ProfileFolder>? folders, List<string>? ungrouped)
        {
            // The incoming lists come from the (untrusted) frontend drag/drop payload. Validate every
            // name against the profiles that actually exist on disk before persisting, mirroring the
            // onDisk gate in MergeImportedOrganizationAsync — otherwise a stale or malformed payload
            // could inject names for profiles that don't exist or silently drop real ones into a
            // garbage order file. Unknown names are filtered; duplicates are collapsed (first wins).
            var onDisk = ProfileEntries.Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
            List<string> Sanitize(List<string> names)
            {
                var result = new List<string>(names.Count);
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var n in names)
                {
                    if (onDisk.Contains(n) && seen.Add(n))
                        result.Add(n);
                }
                return result;
            }

            if (pinned != null) _profileOrder.Pinned = Sanitize(pinned);
            if (folders != null)
            {
                // Preserve existing folder data (TargetWindow, UseRelativeCoordinates, BringToFocus)
                // Only reorder based on incoming folder names and items
                var reordered = new List<ProfileFolder>();
                foreach (var incoming in folders)
                {
                    var validItems = Sanitize(incoming.Items);
                    var existing = _profileOrder.Folders.FirstOrDefault(f => f.Name == incoming.Name);
                    if (existing != null)
                    {
                        existing.Items = validItems;
                        reordered.Add(existing);
                    }
                    else
                    {
                        incoming.Items = validItems;
                        reordered.Add(incoming);
                    }
                }
                _profileOrder.Folders = reordered;
            }
            if (ungrouped != null) _profileOrder.UngroupedOrder = Sanitize(ungrouped);
            await SaveProfileOrderAsync();
        }

        #endregion

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            if (profileWatcher != null)
            {
                profileWatcher.EnableRaisingEvents = false;
                profileWatcher.Dispose();
                profileWatcher = null;
            }

            lock (_debounceLock)
            {
                debounceCts?.Cancel();
                debounceCts?.Dispose();
                debounceCts = null;
            }

            // Intentionally NOT disposing _profileOrderLock: an in-flight SaveProfileOrderAsync may
            // still be awaiting WaitAsync or sitting between WaitAsync and Release(), and disposing
            // the semaphore underneath it throws ObjectDisposedException (and could leak the slot).
            // SemaphoreSlim holds no unmanaged handle here (AvailableWaitHandle is never queried), so
            // letting the GC reclaim it after the last save completes is safe. The _disposed guard
            // above plus _debounceLock already make any in-flight watcher callback benign.
        }
    }
}
