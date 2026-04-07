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
    public enum ImportConflictResult { Overwrite, Rename, Skip, OverwriteAll, SkipAll }

    public class ProfileController : IDisposable
    {
        private readonly MainWindow window;
        private FileSystemWatcher? profileWatcher;
        private CancellationTokenSource? debounceCts;
        private bool _disposed;
        private DateTime suppressWatcherUntil = DateTime.MinValue;

        public ObservableCollection<ProfileEntry> ProfileEntries { get; } = new();
        private Dictionary<string, WindowTarget> _cachedWindowTargets = new();
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
            }

            return profile;
        }

        public async Task SaveProfileByNameAsync(string profileName, UserProfile profile)
        {
            var entry = ProfileEntries.FirstOrDefault(p => p.Name == profileName);
            if (entry != null)
            {
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

        private async Task LoadProfileListAsync()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            Directory.CreateDirectory(profileDir);

            var files = Directory.GetFiles(profileDir, "*.json")
                .Where(f => !string.Equals(Path.GetFileName(f), "profile-order.json", StringComparison.OrdinalIgnoreCase))
                .ToList();

            ProfileEntries.Clear();
            _cachedWindowTargets.Clear();

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
                            IsDisabled = profile.IsDisabled
                        });

                        if (hasTarget)
                            _cachedWindowTargets[name] = profile.TargetWindow!;
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Erro ao carregar perfil {file}: {ex}");
                }
            }

            await LoadProfileOrderAsync();

            var map = GetProfileHotkeys();
            InputHookManager.RegisterProfileHotkeys(map);
            InputHookManager.RegisterProfileWindowTargets(GetProfileWindowTargets(), GetBringToFocusProfiles());
            var hotstringMap = GetProfileHotstrings();
            InputHookManager.RegisterProfileHotstrings(hotstringMap);
        }

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
            _ = RefreshProfileListAsync(suppressWatcher);
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

            debounceCts?.Cancel();
            debounceCts?.Dispose();

            debounceCts = new CancellationTokenSource();
            var token = debounceCts.Token;

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
            catch (TaskCanceledException) { }
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

        public Dictionary<string, string> GetProfileHotkeys()
        {
            var hotkeys = new Dictionary<string, string>();

            foreach (var entry in ProfileEntries)
            {
                if (!string.IsNullOrEmpty(entry.Hotkey) && !entry.IsDisabled)
                    hotkeys[entry.Name] = entry.Hotkey;
            }

            return hotkeys;
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

        public async Task SetFolderWindowTargetAsync(string folderName, WindowTarget target, bool relativeCoordinates = false, bool bringToFocus = false)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                folder.TargetWindow = target;
                folder.UseRelativeCoordinates = relativeCoordinates;
                folder.BringToFocus = bringToFocus;
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
                folder.TargetWindow = null;
                folder.UseRelativeCoordinates = false;
                folder.BringToFocus = false;
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

                // Collect WaitImage reference images
                Dictionary<string, string>? images = null;
                foreach (var action in profile.Actions)
                {
                    if (action.ActionType == "WaitImage" && !string.IsNullOrEmpty(action.ImagePath))
                    {
                        var base64 = ImageStorageService.ReadAsBase64(name, action.ImagePath);
                        if (base64 != null)
                        {
                            images ??= new Dictionary<string, string>();
                            images[action.ImagePath] = base64;
                        }
                    }
                }

                envelope.Profiles.Add(new ProfileExportEntry
                {
                    Name = name,
                    CustomHotkey = profile.CustomHotkey,
                    CustomHotstring = profile.CustomHotstring,
                    TargetWindow = profile.TargetWindow,
                    UseRelativeCoordinates = profile.UseRelativeCoordinates,
                    BringToFocus = profile.BringToFocus,
                    BatchDelay = profile.BatchDelay,
                    Actions = profile.Actions,
                    Images = images
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
                            TargetWindow = f.TargetWindow
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

        public async Task<(int imported, int skipped, bool cancelled, bool hasOrganization)> ImportProfilesAsync()
        {
            var fileName = await ShowFileDialogAsync(new WinForms.OpenFileDialog
            {
                Filter = "TrueReplayer Profile (*.trprofile)|*.trprofile",
                DefaultExt = "trprofile"
            });

            if (fileName == null) return (0, 0, true, false);

            var json = await File.ReadAllTextAsync(fileName);
            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var envelope = JsonSerializer.Deserialize<ProfileExportEnvelope>(json, options);
            if (envelope?.Profiles == null || envelope.Profiles.Count == 0)
                return (0, 0, false, false);

            bool hasOrganization = envelope.Organization != null;

            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles");
            Directory.CreateDirectory(profileDir);

            int imported = 0;
            int skipped = 0;
            ImportConflictResult? applyAllDecision = null;

            foreach (var entry in envelope.Profiles)
            {
                string targetPath = Path.Combine(profileDir, entry.Name + ".json");
                string finalName = entry.Name;

                if (File.Exists(targetPath))
                {
                    ImportConflictResult resolution;

                    if (applyAllDecision == ImportConflictResult.OverwriteAll)
                        resolution = ImportConflictResult.Overwrite;
                    else if (applyAllDecision == ImportConflictResult.SkipAll)
                        resolution = ImportConflictResult.Skip;
                    else
                    {
                        resolution = await ShowImportConflictDialogAsync(entry.Name);

                        if (resolution == ImportConflictResult.OverwriteAll)
                        {
                            applyAllDecision = ImportConflictResult.OverwriteAll;
                            resolution = ImportConflictResult.Overwrite;
                        }
                        else if (resolution == ImportConflictResult.SkipAll)
                        {
                            applyAllDecision = ImportConflictResult.SkipAll;
                            resolution = ImportConflictResult.Skip;
                        }
                    }

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
                        } while (File.Exists(targetPath));
                    }
                }

                var profile = new UserProfile
                {
                    Actions = entry.Actions ?? new ObservableCollection<ActionItem>(),
                    CustomHotkey = entry.CustomHotkey,
                    CustomHotstring = entry.CustomHotstring,
                    TargetWindow = entry.TargetWindow,
                    UseRelativeCoordinates = entry.UseRelativeCoordinates,
                    BringToFocus = entry.BringToFocus,
                    BatchDelay = entry.BatchDelay ?? "Delay (ms)"
                };

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

            return (imported, skipped, false, hasOrganization);
        }

        private async Task MergeImportedOrganizationAsync(ProfileExportOrganization org)
        {
            // Merge pinned: add new pinned items that aren't already pinned
            foreach (var name in org.Pinned)
            {
                if (!_profileOrder.Pinned.Contains(name))
                    _profileOrder.Pinned.Add(name);
            }

            // Merge folders: add new folders, merge items into existing folders
            foreach (var importedFolder in org.Folders)
            {
                var existingFolder = _profileOrder.Folders.FirstOrDefault(f => f.Name == importedFolder.Name);
                if (existingFolder != null)
                {
                    // Merge items into existing folder
                    foreach (var item in importedFolder.Items)
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
                        Items = importedFolder.Items,
                        TargetWindow = importedFolder.TargetWindow
                    });
                }

                // Remove imported folder items from ungrouped
                foreach (var item in importedFolder.Items)
                    _profileOrder.UngroupedOrder.Remove(item);
            }

            await SaveProfileOrderAsync();
        }

        public async Task<ImportConflictResult> ShowImportConflictDialogAsync(string profileName)
        {
            var resultTcs = new TaskCompletionSource<ImportConflictResult>();

            var messageBlock = new TextBlock
            {
                Text = $"A profile named \"{profileName}\" already exists.\nWhat would you like to do?",
                TextWrapping = Microsoft.UI.Xaml.TextWrapping.Wrap
            };

            var overwriteAllBtn = new Button
            {
                Content = "Overwrite All",
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Margin = new Thickness(0, 0, 4, 0)
            };
            var skipAllBtn = new Button
            {
                Content = "Skip All",
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Margin = new Thickness(4, 0, 0, 0)
            };

            var bulkPanel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Margin = new Thickness(0, 12, 0, 0)
            };
            overwriteAllBtn.Width = 130;
            skipAllBtn.Width = 130;
            bulkPanel.Children.Add(overwriteAllBtn);
            bulkPanel.Children.Add(skipAllBtn);

            var contentPanel = new StackPanel();
            contentPanel.Children.Add(messageBlock);
            contentPanel.Children.Add(bulkPanel);

            ContentDialog? dialogRef = null;

            overwriteAllBtn.Click += (s, e) => { resultTcs.TrySetResult(ImportConflictResult.OverwriteAll); dialogRef?.Hide(); };
            skipAllBtn.Click += (s, e) => { resultTcs.TrySetResult(ImportConflictResult.SkipAll); dialogRef?.Hide(); };

            var dialog = new ContentDialog
            {
                Title = "Import Conflict",
                XamlRoot = window.Content.XamlRoot,
                RequestedTheme = ElementTheme.Dark,
                PrimaryButtonText = "Overwrite",
                SecondaryButtonText = "Rename",
                CloseButtonText = "Skip",
                DefaultButton = ContentDialogButton.Secondary,
                CornerRadius = new CornerRadius(8),
                Content = contentPanel
            };
            dialogRef = dialog;
            ApplyDialogTheme(dialog, messageBlock);

            InputHookManager.SuppressAllHotkeys = true;
            try
            {
                var dialogResult = await dialog.ShowAsync();
                if (resultTcs.Task.IsCompleted)
                    return resultTcs.Task.Result;

                return dialogResult switch
                {
                    ContentDialogResult.Primary => ImportConflictResult.Overwrite,
                    ContentDialogResult.Secondary => ImportConflictResult.Rename,
                    _ => ImportConflictResult.Skip
                };
            }
            finally
            {
                InputHookManager.SuppressAllHotkeys = false;
            }
        }

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
            catch
            {
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
                System.Diagnostics.Debug.WriteLine($"[ProfileController] SaveProfileOrder error: {ex.Message}");
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

        public async Task CreateFolderAsync(string folderName, string color)
        {
            if (_profileOrder.Folders.Any(f => f.Name == folderName))
                return;
            _profileOrder.Folders.Add(new ProfileFolder { Name = folderName, Color = color });
            await SaveProfileOrderAsync();
        }

        public async Task RenameFolderAsync(string oldName, string newName)
        {
            var folder = _profileOrder.Folders.FirstOrDefault(f => f.Name == oldName);
            if (folder != null)
            {
                folder.Name = newName;
                await SaveProfileOrderAsync();
            }
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
                        _profileOrder.Pinned.Remove(item);
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
            if (pinned != null) _profileOrder.Pinned = pinned;
            if (folders != null) _profileOrder.Folders = folders;
            if (ungrouped != null) _profileOrder.UngroupedOrder = ungrouped;
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

            debounceCts?.Cancel();
            debounceCts?.Dispose();
            debounceCts = null;

            _profileOrderLock?.Dispose();
        }
    }
}
