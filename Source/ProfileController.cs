using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using System.Collections.ObjectModel;
using TrueReplayer.Managers;
using TrueReplayer.Models;
using TrueReplayer.Services;
using WinForms = System.Windows.Forms;

namespace TrueReplayer.Controllers
{
    public class ProfileController : IDisposable
    {
        private readonly MainWindow window;
        private FileSystemWatcher? profileWatcher;
        private CancellationTokenSource? debounceCts;
        private bool _disposed;
        private bool suppressWatcherRefresh = false;
        private string? selectedProfileName;

        public ObservableCollection<ProfileEntry> ProfileEntries { get; } = new();

        public ProfileController(MainWindow window)
        {
            this.window = window;
            SetupProfileWatcher();
        }

        #region Profile CRUD Operations

        public async Task SaveProfileAsync()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            Directory.CreateDirectory(profileDir);

            var dialog = new WinForms.SaveFileDialog
            {
                Filter = "JSON file (*.json)|*.json",
                FileName = "profile",
                InitialDirectory = profileDir
            };

            if (dialog.ShowDialog() == WinForms.DialogResult.OK)
            {
                var profile = UISettingsManager.CreateFromUI(window);
                profile.LastProfileDirectory = Path.GetDirectoryName(dialog.FileName)!;

                try
                {
                    if (File.Exists(dialog.FileName))
                    {
                        File.Delete(dialog.FileName);
                    }

                    await SettingsManager.SaveProfileAsync(dialog.FileName, profile);
                    RefreshProfileList(true);
                }
                catch (Exception ex)
                {
                    WinForms.MessageBox.Show($"Error saving profile:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                }
            }
        }

        public async Task LoadProfileAsync()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            var dialog = new WinForms.OpenFileDialog
            {
                Filter = "JSON file (*.json)|*.json",
                InitialDirectory = profileDir
            };

            if (dialog.ShowDialog() == WinForms.DialogResult.OK)
            {
                string path = dialog.FileName;
                var profile = await SettingsManager.LoadProfileAsync(path);

                if (profile != null)
                {
                    UserProfile.Current = profile;
                    UISettingsManager.ApplyToUI(window, profile);
                    UserProfile.Current.LastProfileDirectory = Path.GetDirectoryName(path)!;
                }
            }
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
            UISettingsManager.ApplyToUI(window, UserProfile.Default);

            UpdateProfileColors(null);
        }

        #endregion

        #region Profile List Management

        private async void LoadProfileList()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            Directory.CreateDirectory(profileDir);

            var files = Directory.GetFiles(profileDir, "*.json").ToList();

            ProfileEntries.Clear();

            foreach (var file in files)
            {
                try
                {
                    var name = Path.GetFileNameWithoutExtension(file);
                    var profile = await SettingsManager.LoadProfileAsync(file);
                    if (profile != null)
                    {
                        ProfileEntries.Add(new ProfileEntry
                        {
                            Name = name,
                            FilePath = file,
                            Hotkey = profile.CustomHotkey
                        });
                    }
                    else
                    {
                        System.Diagnostics.Debug.WriteLine($"Falha ao carregar perfil: {file}");
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Erro ao carregar perfil {file}: {ex}");
                }
            }

            var map = GetProfileHotkeys();
            InputHookManager.RegisterProfileHotkeys(map);
        }

        public void RefreshProfileList(bool suppressWatcher = false)
        {
            if (suppressWatcher)
                suppressWatcherRefresh = true;

            window.ProfilesListBox.ItemsSource = null;

            LoadProfileList();

            UpdateProfileColors(selectedProfileName);

            window.ProfilesListBox.ItemsSource = ProfileEntries;
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

        public async Task HandleProfileItemClick(string selectedProfile)
        {
            var entry = ProfileEntries.FirstOrDefault(p => p.Name == selectedProfile);
            if (entry != null)
            {
                var profile = await SettingsManager.LoadProfileAsync(entry.FilePath);

                if (profile != null)
                {
                    UserProfile.Current = profile;
                    UISettingsManager.ApplyToUI(window, profile);
                    selectedProfileName = selectedProfile;
                    UpdateProfileColors(selectedProfileName);
                    TrayIconService.UpdateTrayIcon(); // Atualiza o ícone ao carregar perfil
                }
            }
        }

        public void HandleProfileRightTapped(string profile)
        {
            if (ProfileEntries.Any(p => p.Name == profile))
            {
                window.ProfilesListBox.SelectedItem = ProfileEntries.First(p => p.Name == profile);
            }
        }

        public async Task DeleteSelectedProfileAsync()
        {
            if (window.ProfilesListBox.SelectedItem is ProfileEntry selectedProfile)
            {
                var confirmResult = WinForms.MessageBox.Show($"Delete profile '{selectedProfile.Name}'?", "Confirm Delete", WinForms.MessageBoxButtons.YesNo, WinForms.MessageBoxIcon.Warning);
                if (confirmResult == WinForms.DialogResult.Yes)
                {
                    try
                    {
                        if (File.Exists(selectedProfile.FilePath))
                            File.Delete(selectedProfile.FilePath);

                        RefreshProfileList(true);
                    }
                    catch (Exception ex)
                    {
                        WinForms.MessageBox.Show($"Error deleting profile:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                    }
                }
            }
        }

        public void OpenSelectedProfileFolder()
        {
            if (window.ProfilesListBox.SelectedItem is ProfileEntry selectedProfile)
            {
                string? folderPath = Path.GetDirectoryName(selectedProfile.FilePath);

                if (folderPath != null && Directory.Exists(folderPath))
                {
                    try
                    {
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo()
                        {
                            FileName = folderPath,
                            UseShellExecute = true,
                            Verb = "open"
                        });
                    }
                    catch (Exception ex)
                    {
                        WinForms.MessageBox.Show($"Error opening folder:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                    }
                }
            }
        }

        public async Task RenameSelectedProfileAsync()
        {
            if (window.ProfilesListBox.SelectedItem is ProfileEntry selectedProfile)
            {
                string? folderPath = Path.GetDirectoryName(selectedProfile.FilePath);

                if (folderPath != null)
                {
                    string? newName = await ShowRenameDialogAsync(selectedProfile.Name);

                    if (!string.IsNullOrWhiteSpace(newName))
                    {
                        if (!newName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                            newName += ".json";

                        string newFilePath = Path.Combine(folderPath, newName);

                        try
                        {
                            if (File.Exists(newFilePath))
                            {
                                WinForms.MessageBox.Show($"A profile named '{newName}' already exists.", "Rename Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                            }
                            else
                            {
                                File.Move(selectedProfile.FilePath, newFilePath);
                                RefreshProfileList(true);
                            }
                        }
                        catch (Exception ex)
                        {
                            WinForms.MessageBox.Show($"Error renaming profile:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                        }
                    }
                }
            }
        }

        private async Task<string?> ShowRenameDialogAsync(string currentName)
        {
            var inputTextBox = new TextBox
            {
                PlaceholderText = "New profile name...",
                Text = currentName,
                Margin = new Thickness(0, 10, 0, 0),
                Background = new SolidColorBrush(Colors.DimGray),
                Foreground = new SolidColorBrush(Colors.White),
                BorderBrush = new SolidColorBrush(Colors.Gray)
            };

            var dialog = new ContentDialog
            {
                Title = "Rename Profile",
                XamlRoot = window.Content.XamlRoot,
                RequestedTheme = ElementTheme.Dark,
                PrimaryButtonText = "Rename",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
                Background = new SolidColorBrush(ColorHelper.FromArgb(255, 43, 43, 43)),
                Foreground = new SolidColorBrush(Colors.White),
                CornerRadius = new CornerRadius(8),
                Content = inputTextBox
            };

            dialog.Loaded += (_, _) =>
            {
                inputTextBox.Focus(FocusState.Programmatic);
                inputTextBox.SelectAll();
            };

            var result = await dialog.ShowAsync();

            if (result == ContentDialogResult.Primary)
            {
                string newName = inputTextBox.Text.Trim();
                return string.IsNullOrEmpty(newName) ? null : newName;
            }

            return null;
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
