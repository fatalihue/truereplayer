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
        private const int MaxReloadAttempts = 5;
        // Navigation target is stored on first init so recovery doesn't depend on
        // CoreWebView2.Source, which can return an empty string after the renderer crashes.
        private string _targetUrl = "";
        // Tracks how many recovery attempts happened since the last successful ui:ready.
        // If we exhaust levels 1 → 2 repeatedly, level 3 (process restart) is triggered.
        private int _consecutiveRecoveryAttempts = 0;

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
            this.Closed += (_, _) =>
            {
                Services.DiagnosticLog.Info("Window closing — disposing bridge and controllers");
                _uiReadyWatchdog?.Dispose();
                _uiReadyWatchdog = null;
                bridge?.Dispose();
                profileController.Dispose();
            };

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
                // User-initiated recovery from the tray. Start at level 1 by default, but if
                // the UI is already in an attempting-recovery state (black screen), escalate.
                RecoverWebView("tray Reload UI");
            };

            TrayIconService.OnOpenDevTools = () =>
            {
                DispatcherQueue.TryEnqueue(() =>
                {
                    try
                    {
                        WebView?.CoreWebView2?.OpenDevToolsWindow();
                    }
                    catch (Exception ex)
                    {
                        Services.DiagnosticLog.Error("OpenDevTools failed", ex);
                    }
                });
            };

            TrayIconService.OnOpenLogsFolder = () =>
            {
                try
                {
                    var dir = Services.DiagnosticLog.LogDirectory;
                    if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                    {
                        Services.DiagnosticLog.Warn("Open Logs: directory missing");
                        return;
                    }
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = "explorer.exe",
                        Arguments = $"\"{dir}\"",
                        UseShellExecute = true,
                    });
                }
                catch (Exception ex)
                {
                    Services.DiagnosticLog.Error("Open Logs Folder failed", ex);
                }
            };

            // Recover from any WebView2 process failure — renderer exit, unresponsive renderer,
            // GPU crash, etc. We do NOT try to recover from BrowserProcessExited because that
            // means the entire WebView2 runtime died; Reload/Navigate won't help, we'd need a
            // full process restart, which RecoverWebView handles at level 3.
            WebView.CoreWebView2.ProcessFailed += (s, e) =>
            {
                Services.DiagnosticLog.Warn($"WebView2 ProcessFailed: Kind={e.ProcessFailedKind}, Reason={e.Reason}, ExitCode={e.ExitCode}, ProcessDescription={e.ProcessDescription}");
                RecoverWebView($"ProcessFailed:{e.ProcessFailedKind}");
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

                    // Start watchdog: if UI doesn't send ui:ready within 5s, escalate via the
                    // shared recovery path (Reload → Navigate → process restart).
                    _uiReadyWatchdog?.Dispose();
                    _uiReadyWatchdog = new System.Threading.Timer(_ =>
                    {
                        if (_uiReloadAttempts >= MaxReloadAttempts)
                        {
                            // Exhausted watchdog attempts without a ui:ready — go nuclear.
                            DispatcherQueue.TryEnqueue(() => RecoverWebView("watchdog max attempts — forcing restart"));
                            return;
                        }
                        _uiReloadAttempts++;
                        DispatcherQueue.TryEnqueue(() => RecoverWebView($"watchdog ({_uiReloadAttempts}/{MaxReloadAttempts})"));
                    }, null, 5000, System.Threading.Timeout.Infinite);
                }
            };

#if DEBUG
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _targetUrl = "http://localhost:5173";
            WebView.CoreWebView2.Navigate(_targetUrl);
#else
            // DevTools enabled so the "Open DevTools" tray item works in Release too.
            // F12 remains blocked (AreBrowserAcceleratorKeysEnabled = false above) — the only
            // way to open DevTools is via the tray menu, which keeps it out of games' way.
            WebView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;

            // Use virtual host mapping instead of file:// to avoid CORS issues with CSS/JS
            string wwwrootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "app.local", wwwrootPath,
                Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
            _targetUrl = "https://app.local/index.html";
            WebView.CoreWebView2.Navigate(_targetUrl);
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
                InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
            });
        }

        private async Task<bool> HandleCloseGuardAsync()
        {
            Services.DiagnosticLog.Info("Close requested — checking unsaved changes");

            bool canClose;
            if (bridge == null || !bridge.HasUnsavedChanges || Actions.Count == 0)
            {
                canClose = true;
            }
            else
            {
                var result = await profileController.ShowUnsavedChangesDialogAsync();

                if (result == ContentDialogResult.Primary) // Save
                {
                    if (bridge.CurrentProfilePath != null)
                    {
                        var profile = bridge.CreateProfileFromState();
                        profile.CustomHotkey = UserProfile.Current.CustomHotkey;
                        await SettingsManager.SaveProfileAsync(bridge.CurrentProfilePath, profile);
                        canClose = true;
                    }
                    else
                    {
                        canClose = await profileController.SaveProfileAsync();
                    }
                }
                else if (result == ContentDialogResult.Secondary) // Discard
                    canClose = true;
                else
                    canClose = false; // Cancel
            }

            Services.DiagnosticLog.Info($"Close guard resolved: canClose={canClose}");
            return canClose;
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

                    // PROFILE_STOP:: is fired by WhilePressed release to cancel a running replay.
                    // Must run even when IsReplayInProgress (that's the whole point).
                    // We intentionally do NOT call ClearActiveHold here — the hook thread already
                    // cleared its own state before dispatching PROFILE_STOP. Touching those fields
                    // from the UI thread would race with any later hook-thread keydown writes.
                    if (key.StartsWith("PROFILE_STOP::"))
                    {
                        if (mainController.IsReplayInProgress())
                            mainController.StopReplayIfRunning();
                        return;
                    }

                    bool isProfileTrigger = key.StartsWith("PROFILE::") || key.StartsWith("PROFILE_HOLD::") || key.StartsWith("PROFILE_TOGGLE::");
                    if (isProfileTrigger && (!UserProfile.Current.ProfileKeyEnabled || mainController.IsRecording()))
                    {
                        return;
                    }

                    // Re-triggering OnPress / OnRelease during an active replay stops it —
                    // otherwise a user running an infinite-loop profile in OnRelease mode has
                    // no way to stop without using the global replay hotkey.
                    if (key.StartsWith("PROFILE::") && mainController.IsReplayInProgress())
                    {
                        mainController.StopReplayIfRunning();
                        return;
                    }

                    // PROFILE_HOLD:: during active replay: ignored (WhilePressed shouldn't re-enter).
                    // PROFILE_TOGGLE:: passes through — ToggleReplay handles the "press again = stop".
                    if (key.StartsWith("PROFILE_HOLD::") && mainController.IsReplayInProgress())
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
                                UserProfile.Current.WindowHeight,
                                UserProfile.Current.WindowX,
                                UserProfile.Current.WindowY,
                                UserProfile.Current.LockPosition);
                        }
                    }
                    else if (key.StartsWith("PROFILE::") || key.StartsWith("PROFILE_HOLD::") || key.StartsWith("PROFILE_TOGGLE::"))
                    {
                        string prefix = key.StartsWith("PROFILE_HOLD::") ? "PROFILE_HOLD::"
                            : key.StartsWith("PROFILE_TOGGLE::") ? "PROFILE_TOGGLE::"
                            : "PROFILE::";
                        string profileName = key.Substring(prefix.Length);
                        bool forceInfiniteLoop = prefix == "PROFILE_HOLD::";

                        var profile = await profileController.LoadProfileByNameAsync(profileName);

                        // Race guard for WhilePressed: user may have already released the key
                        // before this async handler reached here. In that case the key-up already
                        // fired a PROFILE_STOP, the hold state was cleared, and we should NOT
                        // start the replay — otherwise it would loop forever with no keyup to
                        // stop it.
                        if (forceInfiniteLoop && !InputHookManager.IsHoldActiveForProfile(profileName))
                        {
                            return;
                        }

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
                                UserProfile.Current.WindowHeight,
                                UserProfile.Current.WindowX,
                                UserProfile.Current.WindowY,
                                UserProfile.Current.LockPosition,
                                forceInfiniteLoop);

                            // Post-start safety net for WhilePressed: if the user released the
                            // key between the race guard above and the moment IsReplayInProgress
                            // became true, the STOP handler would have seen no running replay
                            // and done nothing — leaving an infinite-loop replay with no way to
                            // stop it. Re-check hold state right after starting and stop if the
                            // key is no longer held.
                            if (forceInfiniteLoop && !InputHookManager.IsHoldActiveForProfile(profileName))
                            {
                                mainController.StopReplayIfRunning();
                            }

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
            // UI is alive — reset the escalation counter so future crashes start back at level 1
            _consecutiveRecoveryAttempts = 0;
        }

        /// <summary>
        /// Escalating WebView2 recovery. Triggered by ProcessFailed, watchdog timeout, or the
        /// tray "Reload UI" menu item. Goes through increasingly disruptive levels until the UI
        /// comes back or we give up and restart the process.
        ///   Level 1: CoreWebView2.Reload() — respawns renderer, preserves WebView state.
        ///   Level 2: CoreWebView2.Navigate(_targetUrl) — forces a fresh page load.
        ///   Level 3: Process.Start TrueReplayer.exe and exit current — nuclear option.
        /// Each level is tried once per recovery; if this is called while a previous recovery
        /// hasn't produced a ui:ready yet, we escalate to the next level.
        /// </summary>
        private void RecoverWebView(string reason)
        {
            _consecutiveRecoveryAttempts++;
            Services.DiagnosticLog.Warn($"Recovery requested — reason='{reason}', attempt #{_consecutiveRecoveryAttempts}");

            DispatcherQueue.TryEnqueue(() =>
            {
                // Level 1: Reload (cheapest)
                if (_consecutiveRecoveryAttempts == 1 && TryReload())
                {
                    Services.DiagnosticLog.Info("Recovery level 1 (Reload) issued");
                    return;
                }

                // Level 2: Navigate to stored URL
                if (_consecutiveRecoveryAttempts <= 2 && TryNavigate())
                {
                    Services.DiagnosticLog.Info("Recovery level 2 (Navigate) issued");
                    return;
                }

                // Level 3: Restart the entire process. The user's profile is already on disk,
                // so a fresh process reopens to the same state.
                Services.DiagnosticLog.Warn("Recovery level 3: restarting process");
                TryRestartProcess();
            });
        }

        private bool TryReload()
        {
            try
            {
                var cw2 = WebView?.CoreWebView2;
                if (cw2 == null)
                {
                    Services.DiagnosticLog.Warn("Reload() skipped: CoreWebView2 is null");
                    return false;
                }
                cw2.Reload();
                return true;
            }
            catch (Exception ex)
            {
                Services.DiagnosticLog.Error("Reload() threw", ex);
                return false;
            }
        }

        private bool TryNavigate()
        {
            try
            {
                var cw2 = WebView?.CoreWebView2;
                if (cw2 == null || string.IsNullOrEmpty(_targetUrl))
                {
                    Services.DiagnosticLog.Warn($"Navigate() skipped: cw2Null={cw2 == null}, urlEmpty={string.IsNullOrEmpty(_targetUrl)}");
                    return false;
                }
                cw2.Navigate(_targetUrl);
                return true;
            }
            catch (Exception ex)
            {
                Services.DiagnosticLog.Error("Navigate() threw", ex);
                return false;
            }
        }

        private void TryRestartProcess()
        {
            try
            {
                string? exePath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
                if (string.IsNullOrEmpty(exePath))
                {
                    Services.DiagnosticLog.Error("Restart aborted: can't resolve exe path");
                    return;
                }

                var startInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = exePath,
                    UseShellExecute = true,
                };
                System.Diagnostics.Process.Start(startInfo);
                Services.DiagnosticLog.Info("Launched replacement process, exiting current");
                Environment.Exit(0);
            }
            catch (Exception ex)
            {
                Services.DiagnosticLog.Error("Restart failed", ex);
            }
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
