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
        private List<string> profileFilePaths = new();
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
                FileName = "profile.json",
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

            int index = ProfileEntries.ToList().FindIndex(p => p.Name == profileName);
            if (index < 0 || index >= profileFilePaths.Count)
            {
                System.Diagnostics.Debug.WriteLine($"Perfil '{profileName}' não encontrado ou índice inválido ({index}) em LoadProfileByNameAsync.");
                return null;
            }

            string filePath = profileFilePaths[index];
            if (!File.Exists(filePath))
            {
                System.Diagnostics.Debug.WriteLine($"Arquivo do perfil '{filePath}' não existe.");
                return null;
            }

            var profile = await SettingsManager.LoadProfileAsync(filePath);
            if (profile == null)
            {
                System.Diagnostics.Debug.WriteLine($"Falha ao carregar o perfil '{profileName}' do arquivo '{filePath}'.");
            }

            return profile;
        }

        public async Task SaveProfileByNameAsync(string profileName, UserProfile profile)
        {
            int index = ProfileEntries.ToList().FindIndex(p => p.Name == profileName);
            if (index >= 0 && index < profileFilePaths.Count)
            {
                await SettingsManager.SaveProfileAsync(profileFilePaths[index], profile);
            }
        }

        public void ResetProfile()
        {
            UserProfile.Current = UserProfile.Default;
            UISettingsManager.ApplyToUI(window, UserProfile.Default);
            WindowAppearanceService.Configure(window);
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
            profileFilePaths.Clear();

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
                            Hotkey = profile.CustomHotkey
                        });
                        profileFilePaths.Add(file);
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

            var map = await GetProfileHotkeys();
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
            int index = ProfileEntries.ToList().FindIndex(p => p.Name == selectedProfile);
            if (index >= 0 && index < profileFilePaths.Count)
            {
                string path = profileFilePaths[index];
                var profile = await SettingsManager.LoadProfileAsync(path);

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
                int index = ProfileEntries.ToList().FindIndex(p => p.Name == selectedProfile.Name);
                if (index >= 0 && index < profileFilePaths.Count)
                {
                    string filePath = profileFilePaths[index];

                    var confirmResult = WinForms.MessageBox.Show($"Delete profile '{selectedProfile.Name}'?", "Confirm Delete", WinForms.MessageBoxButtons.YesNo, WinForms.MessageBoxIcon.Warning);
                    if (confirmResult == WinForms.DialogResult.Yes)
                    {
                        try
                        {
                            if (File.Exists(filePath))
                                File.Delete(filePath);

                            RefreshProfileList(true);
                        }
                        catch (Exception ex)
                        {
                            WinForms.MessageBox.Show($"Error deleting profile:\n{ex.Message}", "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                        }
                    }
                }
            }
        }

        public void OpenSelectedProfileFolder()
        {
            if (window.ProfilesListBox.SelectedItem is ProfileEntry selectedProfile)
            {
                int index = ProfileEntries.ToList().FindIndex(p => p.Name == selectedProfile.Name);
                if (index >= 0 && index < profileFilePaths.Count)
                {
                    string filePath = profileFilePaths[index];
                    string? folderPath = Path.GetDirectoryName(filePath);

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
        }

        public async Task RenameSelectedProfileAsync()
        {
            if (window.ProfilesListBox.SelectedItem is ProfileEntry selectedProfile)
            {
                int index = ProfileEntries.ToList().FindIndex(p => p.Name == selectedProfile.Name);
                if (index >= 0 && index < profileFilePaths.Count)
                {
                    string oldFilePath = profileFilePaths[index];
                    string? folderPath = Path.GetDirectoryName(oldFilePath);

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
                                    File.Move(oldFilePath, newFilePath);
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
            if (window.ProfilesListBox?.Items == null)
                return;

            foreach (var item in window.ProfilesListBox.Items)
            {
                var container = window.ProfilesListBox.ContainerFromItem(item) as ListViewItem;
                if (container == null)
                    continue;

                var contentPresenter = FindVisualChild<ContentPresenter>(container);
                if (contentPresenter == null)
                    continue;

                var stackPanel = FindVisualChild<StackPanel>(contentPresenter);
                if (stackPanel == null)
                    continue;

                var textBlocks = stackPanel.Children.OfType<TextBlock>().ToArray();
                if (textBlocks.Length < 2)
                    continue;

                var nameTextBlock = textBlocks[0];
                var hotkeyTextBlock = textBlocks[1];

                bool isActive = activeProfileName != null && item is ProfileEntry entry && entry.Name == activeProfileName;

                nameTextBlock.Foreground = new SolidColorBrush(isActive ? Colors.LimeGreen : Colors.Gray);
                hotkeyTextBlock.Foreground = new SolidColorBrush(Colors.Yellow);

                container.Background = new SolidColorBrush(Colors.Transparent);
            }
        }

        private T? FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
        {
            if (parent == null) return null;

            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                var child = VisualTreeHelper.GetChild(parent, i);
                if (child is T foundChild)
                    return foundChild;

                var foundDescendant = FindVisualChild<T>(child);
                if (foundDescendant != null)
                    return foundDescendant;
            }
            return null;
        }

        #endregion

        #region Profile Hotkey Management

        public async Task<Dictionary<string, string>> GetProfileHotkeys()
        {
            var hotkeys = new Dictionary<string, string>();

            for (int i = 0; i < profileFilePaths.Count; i++)
            {
                var profile = await SettingsManager.LoadProfileAsync(profileFilePaths[i]);

                if (profile?.CustomHotkey != null)
                {
                    var name = Path.GetFileNameWithoutExtension(profileFilePaths[i]);
                    hotkeys[name] = profile.CustomHotkey;
                }
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
