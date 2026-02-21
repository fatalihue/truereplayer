using Microsoft.UI.Xaml;
using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Runtime.InteropServices;
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

        private IntPtr hwnd;

        public MainWindow()
        {
            this.InitializeComponent();
            this.Title = "TrueReplayer";

            var appSettings = AppSettingsManager.Load();
            UserProfile.Current.AlwaysOnTop = appSettings.AlwaysOnTop;
            UserProfile.Current.MinimizeToTray = appSettings.MinimizeToTray;

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

            replayService = new ReplayService(
                Actions,
                DispatcherQueue,
                () => mainController.UpdateButtonStates(),
                status => bridge?.PushStatusChange(status),
                (text, isActive) => bridge?.PushButtonStates(),
                index => bridge?.PushActionHighlight(index)
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
            this.Closed += (_, _) => profileController.Dispose();

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
                this);

            WebView.CoreWebView2.WebMessageReceived += (s, e) =>
            {
                bridge.HandleMessage(e.WebMessageAsJson);
            };

            // Reveal WebView only after page is fully loaded to prevent color flash
            WebView.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                WebView.Opacity = 1;
            };

#if DEBUG
            WebView.CoreWebView2.Navigate("http://localhost:5173");
#else
            // Enable DevTools in release for diagnostics (F12)
            WebView.CoreWebView2.Settings.AreDevToolsEnabled = true;

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
                    bridge.ApplyProfile(defaultProfile);
                    TrayIconService.UpdateTrayIcon();
                }

                bridge.PushProfilesUpdate();
                bridge.PushStatusBarUpdate();

                var hotkeys = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(hotkeys);
            });
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
                        mainController.ToggleReplay(
                            bridge?.EnableLoop ?? false,
                            bridge?.LoopCount ?? "1",
                            bridge?.LoopIntervalEnabled ?? false,
                            bridge?.LoopInterval ?? "0");
                    }
                    else if (key.StartsWith("PROFILE::"))
                    {
                        string profileName = key.Substring("PROFILE::".Length);
                        var profile = await profileController.LoadProfileByNameAsync(profileName);

                        if (profile != null)
                        {
                            mainController.SetLastHotkeyPressed(key);
                            UserProfile.Current = profile;
                            bridge?.ApplyProfile(profile);
                            bridge!.CurrentProfileName = profileName;

                            mainController.ToggleReplay(
                                profile.EnableLoop,
                                profile.LoopCount.ToString(),
                                profile.LoopIntervalEnabled,
                                profile.LoopInterval.ToString());

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
                    mainController.CancelInsertMode();
                    foreach (var action in Actions)
                    {
                        action.IsInsertionPoint = false;
                        action.IsVisuallyDeselected = true;
                    }
                    return;
                }

                if (!mainController.IsRecording()) return;
                actionRecorder.RecordKeyboardAction(key, isDown);
            };
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
