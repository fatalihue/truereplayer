using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using TrueReplayer.Controllers;
using TrueReplayer.Interop;
using TrueReplayer.Models;
using TrueReplayer.Services;
using WinRT.Interop;

namespace TrueReplayer
{
    public sealed partial class MainWindow : Window
    {
        public ObservableCollection<ActionItem> Actions { get; } = new();

        private ActionRecorder actionRecorder;
        private ReplayService replayService;
        private RecordingService recordingService;
        private MainController mainController;
        private ProfileController profileController;
        private WindowEventManager windowEventManager;
        private WebViewBridge? bridge;
        private readonly BrowserBridgeService browserBridge = new();
        private System.Threading.Timer? _uiReadyWatchdog;
        private int _uiReloadAttempts = 0;
        private const int MaxReloadAttempts = 3;

        private IntPtr hwnd;

        public MainWindow()
        {
            this.InitializeComponent();
            this.Title = "TrueReplayer";

            AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);

            hwnd = WindowNative.GetWindowHandle(this);

            windowEventManager = new WindowEventManager(this);
            HwndHookManager.SetupHook(hwnd, windowEventManager.WndProc);

            TrayIconService.Initialize(this, hwnd);

            string iconPath = Path.Combine(AppContext.BaseDirectory, "TrueReplayer.ico");
            IntPtr hIcon = LoadImage(IntPtr.Zero, iconPath, 1, 0, 0, 0x00000010);
            const int WM_SETICON = 0x80;
            SendMessage(hwnd, WM_SETICON, (IntPtr)1, hIcon);
            SendMessage(hwnd, WM_SETICON, (IntPtr)0, hIcon);

            mainController = null!;

            actionRecorder = new ActionRecorder(
                Actions,
                () => mainController.GetDelay(),
                () => bridge?.UseCustomDelay ?? true,
                () => mainController.ScrollToLastAction()
            );

            recordingService = new RecordingService(
                actionRecorder,
                () => bridge?.RecordMouse ?? true,
                () => bridge?.RecordScroll ?? true,
                () => bridge?.RecordKeyboard ?? true,
                time => mainController.SetLastActionTime(time),
                status => bridge?.PushStatusChange(status),
                (text, isActive) => bridge?.PushButtonStates()
            );

            browserBridge.Start();

            replayService = new ReplayService(
                Actions,
                DispatcherQueue,
                () => mainController.UpdateButtonStates(),
                status => bridge?.PushStatusChange(status),
                (text, isActive) => bridge?.PushButtonStates(),
                index => bridge?.PushActionHighlight(index),
                browserBridge
            );

            mainController = new MainController(
                Actions,
                actionRecorder,
                recordingService,
                replayService,
                () =>
                {
                    if (bridge == null) return 100;
                    return bridge.UseCustomDelay && int.TryParse(bridge.CustomDelay, out int d) ? d : 100;
                },
                () => bridge?.PushButtonStates()
            );

            WindowAppearanceService.Configure(this);

            SetupInputHooks();

            mainController.UpdateButtonStates();

            profileController = new ProfileController(this);
            this.Closed += (_, _) => { bridge?.Dispose(); profileController.Dispose(); };

            InitializeWebView();
        }

        private async void InitializeWebView()
        {
            await WebView.EnsureCoreWebView2Async();

            // Create bridge and register message handler BEFORE navigation
            // to ensure no messages from React are missed
            bridge = new WebViewBridge(
                WebView.CoreWebView2,
                Actions,
                mainController,
                profileController,
                recordingService,
                replayService,
                DispatcherQueue,
                this,
                browserBridge);

            replayService.SetProfileNameProvider(() => bridge.CurrentProfileName != "No Profile" ? bridge.CurrentProfileName : "default");

            WebView.CoreWebView2.Settings.IsZoomControlEnabled = false;

            // Block browser-like keys (F3=Find, F5=Refresh, F7=Caret, F12=DevTools)
            WebView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;

            WebView.CoreWebView2.WebMessageReceived += (s, e) =>
            {
                bridge.HandleMessage(e.WebMessageAsJson);
            };

            // Wire up unsaved changes guard for window close and tray exit
            windowEventManager.OnCloseRequested = HandleCloseGuardAsync;
            TrayIconService.OnTrayExitRequested = HandleCloseGuardAsync;
            TrayIconService.OnTraySettingChanged = () =>
            {
                DispatcherQueue.TryEnqueue(() => bridge.PushSettingsLoaded());
            };
            TrayIconService.OnAlwaysOnTopChanged = (enabled) =>
            {
                DispatcherQueue.TryEnqueue(() => windowEventManager.UpdateAlwaysOnTop(enabled));
            };
            TrayIconService.OnReloadUI = () =>
            {
                DispatcherQueue.TryEnqueue(() =>
                {
                    try
                    {
                        // Navigate instead of Reload — forces renderer recreation on complete crash
                        var currentUrl = WebView.CoreWebView2.Source;
                        WebView.CoreWebView2.Navigate(currentUrl);
                    }
                    catch { }
                });
            };

            // Recover from any WebView2 process failure by reloading the page
            WebView.CoreWebView2.ProcessFailed += (s, e) =>
            {
                System.Diagnostics.Debug.WriteLine($"[WebView2] ProcessFailed: {e.ProcessFailedKind}");
                // Handle all recoverable failure types (renderer exit, unresponsive, GPU crash, etc.)
                if (e.ProcessFailedKind != Microsoft.Web.WebView2.Core.CoreWebView2ProcessFailedKind.BrowserProcessExited)
                {
                    DispatcherQueue.TryEnqueue(() =>
                    {
                        try
                        {
                            var url = WebView.CoreWebView2.Source;
                            WebView.CoreWebView2.Navigate(url);
                        }
                        catch { }
                    });
                }
            };

            // Reveal WebView and push state after page load (covers initial load + crash recovery)
            WebView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                WebView.Opacity = 1;
                if (e.IsSuccess && bridge != null)
                {
                    DispatcherQueue.TryEnqueue(() =>
                    {
                        bridge.PushFullState();
                    });

                    // Start watchdog: if UI doesn't send ui:ready within 5s, auto-reload
                    _uiReadyWatchdog?.Dispose();
                    _uiReadyWatchdog = new System.Threading.Timer(_ =>
                    {
                        if (_uiReloadAttempts >= MaxReloadAttempts) return;
                        _uiReloadAttempts++;
                        System.Diagnostics.Debug.WriteLine($"[WebView2] UI watchdog: no ui:ready after 5s, navigating (attempt {_uiReloadAttempts})");
                        DispatcherQueue.TryEnqueue(() =>
                        {
                            try
                            {
                                var url = WebView.CoreWebView2.Source;
                                WebView.CoreWebView2.Navigate(url);
                            }
                            catch { }
                        });
                    }, null, 5000, System.Threading.Timeout.Infinite);
                }
            };

#if DEBUG
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            WebView.CoreWebView2.Navigate("http://localhost:5173");
#else
            WebView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;

            // Use virtual host mapping instead of file:// to avoid CORS issues with CSS/JS
            string wwwrootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "app.local", wwwrootPath,
                Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
            WebView.CoreWebView2.Navigate("https://app.local/index.html");
#endif

            // Load initial data
            DispatcherQueue.TryEnqueue(async () =>
            {
                await profileController.RefreshProfileListAsync(true);

                var defaultProfile = await SettingsManager.LoadProfileAsync();
                if (defaultProfile != null)
                {
                    UserProfile.Current = defaultProfile;
                    AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                    bridge.ApplyProfile(defaultProfile);
                    TrayIconService.UpdateTrayIcon();
                }

                bridge.PushProfilesUpdate();
                bridge.PushStatusBarUpdate();

                var hotkeys = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(hotkeys);
            });
        }

        private async Task<bool> HandleCloseGuardAsync()
        {
            if (bridge == null || !bridge.HasUnsavedChanges || Actions.Count == 0)
                return true;

            var result = await profileController.ShowUnsavedChangesDialogAsync();

            if (result == ContentDialogResult.Primary) // Save
            {
                if (bridge.CurrentProfilePath != null)
                {
                    var profile = bridge.CreateProfileFromState();
                    profile.CustomHotkey = UserProfile.Current.CustomHotkey;
                    await SettingsManager.SaveProfileAsync(bridge.CurrentProfilePath, profile);
                    return true;
                }
                else
                {
                    bool saved = await profileController.SaveProfileAsync();
                    return saved; // If user cancelled save dialog, don't close
                }
            }

            if (result == ContentDialogResult.Secondary) // Discard
                return true;

            return false; // Cancel
        }

        private void SetupInputHooks()
        {
            InputHookManager.Start();

            InputHookManager.OnHotkeyPressed += (key) =>
            {
                DispatcherQueue.TryEnqueue(async () =>
                {
                    if (key == UserProfile.Current.ProfileKeyToggleHotkey)
                    {
                        UserProfile.Current.ProfileKeyEnabled = !UserProfile.Current.ProfileKeyEnabled;
                        if (bridge != null)
                        {
                            bridge.ProfileKeyEnabled = UserProfile.Current.ProfileKeyEnabled;
                            bridge.PushSettingsLoaded();
                        }
                        mainController.SetLastHotkeyPressed(key);
                        TrayIconService.UpdateTrayIcon();
                        return;
                    }

                    if (key == UserProfile.Current.ForegroundHotkey)
                    {
                        windowEventManager?.BringToForeground();
                        return;
                    }

                    if (key.StartsWith("PROFILE::") &&
                        (!UserProfile.Current.ProfileKeyEnabled || mainController.IsRecording() || mainController.IsReplayInProgress()))
                    {
                        return;
                    }

                    if (key == UserProfile.Current.RecordingHotkey)
                    {
                        if (mainController.ShouldSuppressDuplicateRecordingHotkey())
                            return;

                        foreach (var action in Actions)
                        {
                            action.IsInsertionPoint = false;
                            action.IsVisuallyDeselected = false;
                        }

                        mainController.EnableInsertMode(bridge?.SelectedInsertIndex);
                        mainController.SetLastHotkeyPressed(key);
                        mainController.ToggleRecording();
                    }
                    else if (key == UserProfile.Current.ReplayHotkey)
                    {
                        if (mainController.ShouldSuppressDuplicateReplayHotkey())
                            return;

                        mainController.SetLastHotkeyPressed(key);

                        if (bridge?.UseCursorClick == true)
                        {
                            int delay = int.TryParse(bridge?.CustomDelay ?? "100", out var cd) ? cd : 100;
                            bool useJitter = bridge?.UseDelayVariation ?? false;
                            int jitterPercent = int.TryParse(bridge?.DelayVariation ?? "20", out var jp) ? jp : 20;
                            int loops = (bridge?.EnableLoop ?? false) && int.TryParse(bridge?.LoopCount ?? "0", out var lc) ? lc : 0;
                            int interval = (bridge?.LoopIntervalEnabled ?? false) && int.TryParse(bridge?.LoopInterval ?? "0", out var li) ? li : 0;
                            mainController.ToggleCursorClickReplay(delay, useJitter, jitterPercent, loops, interval, bridge?.CursorClickButton ?? "Left");
                        }
                        else
                        {
                            var curName = bridge?.CurrentProfileName ?? "";
                            var effTarget = curName != "No Profile" ? profileController.GetEffectiveWindowTarget(curName) : UserProfile.Current.TargetWindow;
                            var effRelCoords = curName != "No Profile" ? profileController.GetEffectiveRelativeCoordinates(curName) : UserProfile.Current.UseRelativeCoordinates;
                            var effBringFocus = curName != "No Profile" ? profileController.GetEffectiveBringToFocus(curName) : UserProfile.Current.BringToFocus;
                            mainController.ToggleReplay(
                                bridge?.EnableLoop ?? false,
                                bridge?.LoopCount ?? "1",
                                bridge?.LoopIntervalEnabled ?? false,
                                bridge?.LoopInterval ?? "0",
                                bridge?.UseDelayVariation ?? false,
                                int.TryParse(bridge?.DelayVariation ?? "20", out var hvp) ? hvp : 20,
                                effRelCoords,
                                effTarget,
                                effBringFocus,
                                UserProfile.Current.WindowWidth,
                                UserProfile.Current.WindowHeight);
                        }
                    }
                    else if (key.StartsWith("PROFILE::"))
                    {
                        string profileName = key.Substring("PROFILE::".Length);
                        var profile = await profileController.LoadProfileByNameAsync(profileName);

                        if (profile != null)
                        {
                            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == profileName);
                            mainController.SetLastHotkeyPressed(key);
                            UserProfile.Current = profile;
                            AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                            // Apply effective folder-inherited values
                            UserProfile.Current.UseRelativeCoordinates = profileController.GetEffectiveRelativeCoordinates(profileName);
                            UserProfile.Current.BringToFocus = profileController.GetEffectiveBringToFocus(profileName);
                            if (bridge == null) return;
                            bridge.ApplyProfile(profile);
                            bridge.CurrentProfileName = profileName;
                            bridge.CurrentProfilePath = entry?.FilePath;
                            bridge.HasUnsavedChanges = false;

                            var effectiveTarget = profileController.GetEffectiveWindowTarget(profileName);
                            var effectiveRelCoords = profileController.GetEffectiveRelativeCoordinates(profileName);
                            var effectiveBringToFocus = profileController.GetEffectiveBringToFocus(profileName);
                            mainController.ToggleReplay(
                                bridge.EnableLoop,
                                bridge.LoopCount,
                                bridge.LoopIntervalEnabled,
                                bridge.LoopInterval,
                                bridge.UseDelayVariation,
                                int.TryParse(bridge.DelayVariation, out var pvp) ? pvp : 20,
                                effectiveRelCoords,
                                effectiveTarget,
                                effectiveBringToFocus,
                                UserProfile.Current.WindowWidth,
                                UserProfile.Current.WindowHeight);

                            profileController.UpdateProfileColors(profileName);
                            bridge.PushProfilesUpdate();
                            bridge.PushToolbarUpdate();
                            bridge.PushStatusBarUpdate();
                            TrayIconService.UpdateTrayIcon();
                        }
                    }
                });
            };

            InputHookManager.OnMouseEvent += (button, x, y, isDown, scrollDelta) =>
            {
                if (!mainController.IsRecording()) return;
                actionRecorder.RecordMouseAction(button, x, y, isDown, scrollDelta);
            };

            InputHookManager.OnKeyEvent += (key, isDown) =>
            {
                if (isDown && key == "Escape")
                {
                    // If in capture mode, cancel it and discard partial actions
                    if (mainController.IsCaptureMode())
                    {
                        mainController.CancelCaptureMode();
                        return;
                    }

                    if (mainController.IsInsertMode())
                    {
                        mainController.CancelInsertMode();
                        foreach (var action in Actions)
                        {
                            action.IsInsertionPoint = false;
                            action.IsVisuallyDeselected = true;
                        }
                        return;
                    }
                    // If not in any special mode, fall through to recording
                }

                if (!mainController.IsRecording()) return;
                actionRecorder.RecordKeyboardAction(key, isDown);
            };
        }

        public void CancelUIWatchdog()
        {
            _uiReadyWatchdog?.Dispose();
            _uiReadyWatchdog = null;
            _uiReloadAttempts = 0;
        }

        public void UpdateAlwaysOnTop(bool isAlwaysOnTop)
        {
            windowEventManager?.UpdateAlwaysOnTop(isAlwaysOnTop);
        }

        public bool IsMinimizeToTrayEnabled()
        {
            return UserProfile.Current.MinimizeToTray;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr LoadImage(IntPtr hInst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    }
}
