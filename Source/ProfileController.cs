using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
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
    public enum ImportConflictResult { Overwrite, Rename, Skip }

    public class ProfileController : IDisposable
    {
        private readonly MainWindow window;
        private FileSystemWatcher? profileWatcher;
        private CancellationTokenSource? debounceCts;
        private bool _disposed;
        private bool suppressWatcherRefresh = false;

        public ObservableCollection<ProfileEntry> ProfileEntries { get; } = new();
        private Dictionary<string, WindowTarget> _cachedWindowTargets = new();

        public ProfileController(MainWindow window)
        {
            this.window = window;
            SetupProfileWatcher();
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

        public async Task SaveProfileAsync()
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
                var profile = UserProfile.Current;
                profile.Actions = window.Actions;
                profile.LastProfileDirectory = Path.GetDirectoryName(fileName)!;

                try
                {
                    if (File.Exists(fileName))
                    {
                        File.Delete(fileName);
                    }

                    await SettingsManager.SaveProfileAsync(fileName, profile);
                    await RefreshProfileListAsync(true);
                }
                catch (Exception ex)
                {
                    WinForms.MessageBox.Show($"Error saving profile:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                }
            }
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

            var files = Directory.GetFiles(profileDir, "*.json").ToList();

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
                            HasWindowTarget = hasTarget
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

            var map = GetProfileHotkeys();
            InputHookManager.RegisterProfileHotkeys(map);
            InputHookManager.RegisterProfileWindowTargets(_cachedWindowTargets);
        }

        public async Task RefreshProfileListAsync(bool suppressWatcher = false)
        {
            if (suppressWatcher)
                suppressWatcherRefresh = true;

            await LoadProfileListAsync();
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
                        if (suppressWatcherRefresh)
                        {
                            suppressWatcherRefresh = false;
                            return;
                        }
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
                Foreground = new SolidColorBrush(Colors.White),
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
                Background = new SolidColorBrush(ColorHelper.FromArgb(255, 43, 43, 43)),
                Foreground = new SolidColorBrush(Colors.White),
                CornerRadius = new CornerRadius(8),
                Content = messageBlock
            };

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
                Foreground = new SolidColorBrush(Colors.White),
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
                Background = new SolidColorBrush(ColorHelper.FromArgb(255, 43, 43, 43)),
                Foreground = new SolidColorBrush(Colors.White),
                CornerRadius = new CornerRadius(8),
                Content = messageBlock
            };

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
                if (!string.IsNullOrEmpty(entry.Hotkey))
                    hotkeys[entry.Name] = entry.Hotkey;
            }

            return hotkeys;
        }

        public Dictionary<string, WindowTarget> GetProfileWindowTargets()
        {
            return new Dictionary<string, WindowTarget>(_cachedWindowTargets);
        }

        #endregion

        #region Profile Export/Import

        public async Task<bool> ExportProfilesAsync(List<string> profileNames)
        {
            var envelope = new ProfileExportEnvelope();

            foreach (var name in profileNames)
            {
                var profile = await LoadProfileByNameAsync(name);
                if (profile == null) continue;

                envelope.Profiles.Add(new ProfileExportEntry
                {
                    Name = name,
                    CustomHotkey = profile.CustomHotkey,
                    TargetWindow = profile.TargetWindow,
                    BatchDelay = profile.BatchDelay,
                    Actions = profile.Actions
                });
            }

            if (envelope.Profiles.Count == 0) return false;

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

        public async Task<(int imported, int skipped, bool cancelled)> ImportProfilesAsync()
        {
            var fileName = await ShowFileDialogAsync(new WinForms.OpenFileDialog
            {
                Filter = "TrueReplayer Profile (*.trprofile)|*.trprofile",
                DefaultExt = "trprofile"
            });

            if (fileName == null) return (0, 0, true);

            var json = await File.ReadAllTextAsync(fileName);
            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var envelope = JsonSerializer.Deserialize<ProfileExportEnvelope>(json, options);
            if (envelope?.Profiles == null || envelope.Profiles.Count == 0)
                return (0, 0, false);

            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles");
            Directory.CreateDirectory(profileDir);

            int imported = 0;
            int skipped = 0;

            foreach (var entry in envelope.Profiles)
            {
                string targetPath = Path.Combine(profileDir, entry.Name + ".json");
                string finalName = entry.Name;

                if (File.Exists(targetPath))
                {
                    var resolution = await ShowImportConflictDialogAsync(entry.Name);

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
                    TargetWindow = entry.TargetWindow,
                    BatchDelay = entry.BatchDelay ?? "Delay (ms)"
                };

                await SettingsManager.SaveProfileAsync(targetPath, profile);
                imported++;
            }

            if (imported > 0)
                await RefreshProfileListAsync(true);

            return (imported, skipped, false);
        }

        public async Task<ImportConflictResult> ShowImportConflictDialogAsync(string profileName)
        {
            var messageBlock = new TextBlock
            {
                Text = $"A profile named \"{profileName}\" already exists. What would you like to do?",
                Foreground = new SolidColorBrush(Colors.White),
                TextWrapping = Microsoft.UI.Xaml.TextWrapping.Wrap
            };

            var dialog = new ContentDialog
            {
                Title = "Import Conflict",
                XamlRoot = window.Content.XamlRoot,
                RequestedTheme = ElementTheme.Dark,
                PrimaryButtonText = "Overwrite",
                SecondaryButtonText = "Rename",
                CloseButtonText = "Skip",
                DefaultButton = ContentDialogButton.Secondary,
                Background = new SolidColorBrush(ColorHelper.FromArgb(255, 43, 43, 43)),
                Foreground = new SolidColorBrush(Colors.White),
                CornerRadius = new CornerRadius(8),
                Content = messageBlock
            };

            InputHookManager.SuppressAllHotkeys = true;
            try
            {
                var result = await dialog.ShowAsync();
                return result switch
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
        }
    }
}
