using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.Win32;
using TrueReplayer;
using TrueReplayer.Interop;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    public static class TrayIconService
    {
        // Shell_NotifyIcon messages
        private const uint NIM_ADD = 0x00000000;
        private const uint NIM_MODIFY = 0x00000001;
        private const uint NIM_DELETE = 0x00000002;

        // NotifyIconData flags
        private const uint NIF_MESSAGE = 0x01;
        private const uint NIF_ICON = 0x02;
        private const uint NIF_TIP = 0x04;
        private const uint NIF_STATE = 0x08;
        private const uint NIF_INFO = 0x10;

        // NotifyIcon state
        private const uint NIS_HIDDEN = 0x01;

        // Balloon icon flags
        private const uint NIIF_INFO = 0x01;

        // Window messages
        private const int WM_USER = 0x0400;
        private const int WM_LBUTTONDBLCLK = 0x0203;
        private const int WM_RBUTTONUP = 0x0205;

        // LoadImage constants
        private const uint IMAGE_ICON = 1;
        private const uint LR_LOADFROMFILE = 0x00000010;

        // Menu constants
        private const uint MF_STRING = 0x0000;
        private const uint MF_CHECKED = 0x0008;
        private const uint MF_SEPARATOR = 0x0800;
        private const uint TPM_RETURNCMD = 0x0100;

        private const string StartupRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string StartupValueName = "TrueReplayer";

        private static IntPtr hwnd;
        private static NotifyIconData notifyIcon;
        private static bool isInitialized = false;
        private static IntPtr currentIconHandle;

        public static void Initialize(object window, IntPtr windowHandle, bool showNotification = false)
        {
            if (isInitialized) return;
            hwnd = windowHandle;
            CreateTrayIcon(showNotification);
            isInitialized = true;
        }

        public static void CreateTrayIcon(bool showNotification = false)
        {
            if (isInitialized)
                Shell_NotifyIcon(NIM_DELETE, ref notifyIcon);

            // Read settings once and pass to both resolvers — avoids two disk reads (and a tiny
            // race window where a write between them could yield mismatched icon/tooltip).
            var settings = AppSettingsManager.Load();
            string iconPath = ResolveTrayIconPath(settings);

            ReleaseCurrentIcon();
            currentIconHandle = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);
            if (currentIconHandle == IntPtr.Zero)
                DiagnosticLog.Warn($"Tray icon LoadImage failed (Win32 error {Marshal.GetLastWin32Error()}) for '{iconPath}' — tray icon will appear blank");

            notifyIcon = new NotifyIconData
            {
                cbSize = (uint)Marshal.SizeOf(typeof(NotifyIconData)),
                hWnd = hwnd,
                uID = 1,
                uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP,
                uCallbackMessage = WM_USER + 1,
                hIcon = currentIconHandle,
                szTip = ResolveTooltip(settings)
            };

            if (!Shell_NotifyIcon(NIM_ADD, ref notifyIcon))
                DiagnosticLog.Error($"Shell_NotifyIcon(NIM_ADD) failed (Win32 error {Marshal.GetLastWin32Error()}) — tray icon was not registered");

            if (showNotification)
            {
                ShowMinimizeBalloon();
            }
        }

        public static void UpdateTrayIcon()
        {
            var settings = AppSettingsManager.Load();
            string iconPath = ResolveTrayIconPath(settings);

            ReleaseCurrentIcon();
            currentIconHandle = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);

            notifyIcon.hIcon = currentIconHandle;
            notifyIcon.szTip = ResolveTooltip(settings);
            Shell_NotifyIcon(NIM_MODIFY, ref notifyIcon);
        }

        public static void ShowMinimizeBalloon()
        {
            // Mutate the actual field, not a by-value copy — otherwise NIF_INFO / the balloon
            // text never persist on the static struct.
            notifyIcon.uFlags |= NIF_INFO;
            notifyIcon.szInfoTitle = "TrueReplayer is running in the background";
            notifyIcon.szInfo = "Click the tray icon to restore the window.";
            notifyIcon.dwInfoFlags = NIIF_INFO;
            if (!Shell_NotifyIcon(NIM_MODIFY, ref notifyIcon))
                DiagnosticLog.Warn($"Shell_NotifyIcon(NIM_MODIFY) for minimize balloon failed (Win32 error {Marshal.GetLastWin32Error()})");
            // Clear NIF_INFO so subsequent UpdateTrayIcon/RemoveTrayIcon NIM_MODIFY calls — which
            // reuse this field and do NOT rewrite uFlags — don't re-pop the balloon on an
            // unrelated tray refresh (mode toggle, profile-key toggle, settings change, etc.).
            notifyIcon.uFlags &= ~NIF_INFO;
        }

        public static void RemoveTrayIcon()
        {
            if (isInitialized)
            {
                // Hide the icon first so Windows removes it from the tray immediately
                // (without this, the ghost icon lingers until mouse hover)
                notifyIcon.uFlags |= NIF_STATE;
                notifyIcon.dwState = NIS_HIDDEN;
                notifyIcon.dwStateMask = NIS_HIDDEN;
                Shell_NotifyIcon(NIM_MODIFY, ref notifyIcon);

                Shell_NotifyIcon(NIM_DELETE, ref notifyIcon);
                ReleaseCurrentIcon();
                isInitialized = false;
            }
        }

        // Tray icon priority: Clicker mode (purple) > profile keys paused (red) > running (green).
        // Clicker is checked first so it overrides the "paused" state — in Clicker mode profile-key
        // semantics don't apply at all, so showing red there would be misleading.
        private static string ResolveTrayIconPath(AppSettingsManager.AppSettings settings)
        {
            string fileName;
            if (settings.UseCursorClick)
                fileName = "TrueReplayerPurple.ico";
            else if (UserProfile.Current.ProfileKeyEnabled)
                fileName = "TrueReplayer.ico";
            else
                fileName = "TrueReplayerRed.ico";
            return Path.Combine(AppContext.BaseDirectory, fileName);
        }

        // Tooltip mirrors the icon-resolution priority so the hover label always matches the color.
        // Capped at 127 chars + null terminator to fit the szTip buffer used by the shell.
        private static string ResolveTooltip(AppSettingsManager.AppSettings settings)
        {
            if (settings.UseCursorClick)
                return "TrueReplayer — Clicker mode";
            if (!UserProfile.Current.ProfileKeyEnabled)
                return "TrueReplayer — Replay mode (profile keys paused)";
            return "TrueReplayer — Replay mode";
        }

        private static void ReleaseCurrentIcon()
        {
            if (currentIconHandle != IntPtr.Zero)
            {
                DestroyIcon(currentIconHandle);
                currentIconHandle = IntPtr.Zero;
            }
        }

        /// Callback invoked when user clicks "Exit" from the tray. Should return true if exit is allowed.
        public static Func<Task<bool>>? OnTrayExitRequested { get; set; }

        public static bool IsRunOnStartup()
        {
            using var key = Registry.CurrentUser.OpenSubKey(StartupRegistryKey, false);
            return key?.GetValue(StartupValueName) != null;
        }

        public static void SetRunOnStartup(bool enable)
        {
            // Persist the user's intent regardless of where we're running from.
            var settings = AppSettingsManager.Load();
            settings.RunOnStartup = enable;
            AppSettingsManager.Save(settings);

            // Only the installed build owns the Run key. A dev/portable copy writing its own
            // (transient) path here is what previously left a dangling autostart entry when that
            // copy was later moved or deleted — guard against polluting it.
            if (!IsInstalledLocation()) return;
            WriteStartupKey(enable);
        }

        /// <summary>
        /// Startup self-heal: makes the Run key match the saved RunOnStartup intent AND point at
        /// THIS (current) exe. Rewrites a stale/missing entry — e.g. one left by a previous
        /// version, a moved install, or a now-deleted copy — so autostart can't silently break.
        /// No-op from non-installed (dev/portable) copies so they can't pollute the key.
        /// </summary>
        public static void SyncStartupRegistration(bool desired)
        {
            if (!IsInstalledLocation()) return;
            using var key = Registry.CurrentUser.OpenSubKey(StartupRegistryKey, true);
            if (key == null) return;

            string expected = StartupValue;
            string? current = key.GetValue(StartupValueName) as string;
            if (desired)
            {
                if (!string.Equals(current, expected, StringComparison.OrdinalIgnoreCase))
                    key.SetValue(StartupValueName, expected); // create or fix a stale path
            }
            else if (current != null)
            {
                key.DeleteValue(StartupValueName, false);
            }
        }

        private static string StartupValue => $"\"{Environment.ProcessPath}\" --startup";

        private static void WriteStartupKey(bool enable)
        {
            using var key = Registry.CurrentUser.OpenSubKey(StartupRegistryKey, true);
            if (key == null) return;
            if (enable)
                key.SetValue(StartupValueName, StartupValue);
            else
                key.DeleteValue(StartupValueName, false);
        }

        // True only when running from the Velopack install location
        // (%LocalAppData%\TrueReplayer\...). Dev (bin\) and portable copies return false.
        private static bool IsInstalledLocation()
        {
            var p = Environment.ProcessPath;
            if (string.IsNullOrEmpty(p)) return false;
            string installRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TrueReplayer");
            return p.StartsWith(installRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        /// Callback invoked after tray menu toggles a setting, so bridge can push updated state to UI.
        public static Action? OnTraySettingChanged { get; set; }

        /// Callback to apply Always On Top window state from the tray menu.
        public static Action<bool>? OnAlwaysOnTopChanged { get; set; }
        /// Callback to switch Macro/Clicker mode from the tray menu (true = Clicker).
        public static Action<bool>? OnSetMode { get; set; }
        public static Action? OnReloadUI { get; set; }
        public static Action? OnOpenDevTools { get; set; }
        public static Action? OnOpenLogsFolder { get; set; }

        public static async void ShowContextMenu()
        {
            // Current macro/clicker mode drives the checkmarks on the two mode items.
            bool isClicker = AppSettingsManager.Load().UseCursorClick;

            // ── Window category — temporarily disabled (kept for easy restore).
            //    To bring it back: uncomment this block, the AppendMenu calls and the
            //    cmd==5/6/3/4/7 handlers below.
            // bool isAlwaysOnTop = UserProfile.Current.AlwaysOnTop;
            // bool isMinimizeToTray = UserProfile.Current.MinimizeToTray;
            // bool isStartup = IsRunOnStartup();
            // bool isStartMinimized = UserProfile.Current.StartMinimized;
            // bool isRunAsAdmin = AppSettingsManager.Load().RunAsAdmin;

            IntPtr hMenu = CreatePopupMenu();
            AppendMenu(hMenu, MF_STRING, 1, "Restore");
            AppendMenu(hMenu, MF_SEPARATOR, 0, null);
            // Mode switch — mirrors the in-app Macro/Clicker toggle and the ScrollLock hotkey.
            AppendMenu(hMenu, MF_STRING | (!isClicker ? MF_CHECKED : 0), 11, "Macro Mode");
            AppendMenu(hMenu, MF_STRING | (isClicker ? MF_CHECKED : 0), 12, "Clicker Mode");
            AppendMenu(hMenu, MF_SEPARATOR, 0, null);
            // ── Window category — temporarily disabled (kept for easy restore).
            // AppendMenu(hMenu, MF_STRING | (isAlwaysOnTop ? MF_CHECKED : 0), 5, "Always On Top");
            // AppendMenu(hMenu, MF_STRING | (isMinimizeToTray ? MF_CHECKED : 0), 6, "System Tray");
            // AppendMenu(hMenu, MF_STRING | (isStartup ? MF_CHECKED : 0), 3, "Run on Startup");
            // AppendMenu(hMenu, MF_STRING | (isStartMinimized ? MF_CHECKED : 0), 4, "Startup Minimized");
            // AppendMenu(hMenu, MF_STRING | (isRunAsAdmin ? MF_CHECKED : 0), 7, "Run as Administrator");
            AppendMenu(hMenu, MF_STRING, 8, "Reload UI");
            AppendMenu(hMenu, MF_STRING, 9, "Open DevTools");
            AppendMenu(hMenu, MF_STRING, 10, "Open Logs Folder");
            AppendMenu(hMenu, MF_SEPARATOR, 0, null);
            AppendMenu(hMenu, MF_STRING, 2, "Exit");

            GetCursorPos(out NativeMethods.POINT pt);
            SetForegroundWindow(hwnd);
            int cmd;
            try
            {
                cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD, pt.x, pt.y, 0, hwnd, IntPtr.Zero);
            }
            finally
            {
                // Always free the popup menu, even if TrackPopupMenu throws — otherwise the HMENU leaks.
                DestroyMenu(hMenu);
            }

            if (cmd == 1) ShowWindow(hwnd, 9);
            // Mode switch: only fire when it actually changes, so re-picking the
            // current mode doesn't needlessly cancel a running replay/recording.
            else if (cmd == 11) { if (isClicker) OnSetMode?.Invoke(false); }
            else if (cmd == 12) { if (!isClicker) OnSetMode?.Invoke(true); }
            // ── Window category — temporarily disabled (kept for easy restore).
            // else if (cmd == 5)
            // {
            //     UserProfile.Current.AlwaysOnTop = !isAlwaysOnTop;
            //     OnAlwaysOnTopChanged?.Invoke(UserProfile.Current.AlwaysOnTop);
            //     var settings = AppSettingsManager.Load();
            //     settings.AlwaysOnTop = UserProfile.Current.AlwaysOnTop;
            //     AppSettingsManager.Save(settings);
            //     OnTraySettingChanged?.Invoke();
            // }
            // else if (cmd == 6)
            // {
            //     UserProfile.Current.MinimizeToTray = !isMinimizeToTray;
            //     var settings = AppSettingsManager.Load();
            //     settings.MinimizeToTray = UserProfile.Current.MinimizeToTray;
            //     AppSettingsManager.Save(settings);
            //     OnTraySettingChanged?.Invoke();
            // }
            // else if (cmd == 3)
            // {
            //     SetRunOnStartup(!isStartup);
            //     OnTraySettingChanged?.Invoke();
            // }
            // else if (cmd == 4)
            // {
            //     UserProfile.Current.StartMinimized = !isStartMinimized;
            //     var settings = AppSettingsManager.Load();
            //     settings.StartMinimized = UserProfile.Current.StartMinimized;
            //     AppSettingsManager.Save(settings);
            //     OnTraySettingChanged?.Invoke();
            // }
            // else if (cmd == 7)
            // {
            //     var settings = AppSettingsManager.Load();
            //     settings.RunAsAdmin = !isRunAsAdmin;
            //     AppSettingsManager.Save(settings);
            //     OnTraySettingChanged?.Invoke();
            // }
            else if (cmd == 8)
            {
                OnReloadUI?.Invoke();
            }
            else if (cmd == 9)
            {
                OnOpenDevTools?.Invoke();
            }
            else if (cmd == 10)
            {
                OnOpenLogsFolder?.Invoke();
            }
            else if (cmd == 2)
            {
                if (OnTrayExitRequested != null)
                {
                    ShowWindow(hwnd, 9); // Restore window so dialog is visible
                    bool canExit = await OnTrayExitRequested();
                    if (!canExit) return;
                }

                DiagnosticLog.Info("Tray Exit — terminating application");
                RemoveTrayIcon();
                Microsoft.UI.Xaml.Application.Current.Exit();
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct NotifyIconData
        {
            public uint cbSize;
            public IntPtr hWnd;
            public uint uID;
            public uint uFlags;
            public uint uCallbackMessage;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
            public uint dwState;
            public uint dwStateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
            public uint uTimeoutOrVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
            public uint dwInfoFlags;
            public Guid guidItem;
            public IntPtr hBalloonIcon;
        }

        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativeMethods.POINT lpPoint);
        [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll")] private static extern bool AppendMenu(IntPtr hMenu, uint uFlags, uint uIDNewItem, string? lpNewItem);
        [DllImport("user32.dll")]
        private static extern int

 TrackPopupMenu(IntPtr hMenu, uint uFlags, int x, int y, int nReserved, IntPtr hWnd, IntPtr prcRect);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Shell_NotifyIcon(uint dwMessage, ref NotifyIconData lpdata);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadImage(IntPtr hInst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr hMenu);
    }

    public static class WindowAppearanceService
    {
        public static void Configure(Window window)
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            var windowId = Win32Interop.GetWindowIdFromWindow(hwnd);
            var appWindow = AppWindow.GetFromWindowId(windowId);
            // AppWindow.Resize takes PHYSICAL pixels — scale the 1180×780 DIP design
            // size by the window's DPI (mirrors the WM_GETMINMAXINFO convention).
            // Unscaled, a 125% display opened the window at 1180 physical = 944 DIP,
            // under the React shell's ~1020px auto-collapse threshold — the app
            // started with its side panels folded for no reason.
            uint dpi = NativeMethods.GetDpiForWindowSafe(hwnd);
            appWindow.Resize(new Windows.Graphics.SizeInt32(
                (int)(1180 * dpi / 96.0),
                (int)(780 * dpi / 96.0)));
            CustomizeTitleBar(appWindow);
            CenterWindow(appWindow, windowId);
        }

        public static void CustomizeTitleBar(AppWindow appWindow)
        {
            appWindow.TitleBar.ExtendsContentIntoTitleBar = true;
            appWindow.TitleBar.ButtonBackgroundColor = Colors.Transparent;
            appWindow.TitleBar.ButtonInactiveBackgroundColor = Colors.Transparent;
        }

        public static void CenterWindow(AppWindow appWindow, WindowId windowId)
        {
            var displayArea = DisplayArea.GetFromWindowId(windowId, DisplayAreaFallback.Primary);
            var centerPosition = new Windows.Graphics.PointInt32
            {
                X = displayArea.WorkArea.X + (displayArea.WorkArea.Width - appWindow.Size.Width) / 2,
                Y = displayArea.WorkArea.Y + (displayArea.WorkArea.Height - appWindow.Size.Height) / 2
            };
            appWindow.Move(centerPosition);
        }

        public static void ApplyWindowState(Window window, UserProfile profile)
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            var windowId = Win32Interop.GetWindowIdFromWindow(hwnd);
            var appWindow = AppWindow.GetFromWindowId(windowId);
            SetWindowPos(hwnd, profile.AlwaysOnTop ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }

        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOACTIVATE = 0x0010;
        private static readonly IntPtr HWND_TOPMOST = new(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new(-2);

        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    }

    public class WindowEventManager
    {
        private readonly Window window;
        private readonly IntPtr hwnd;
        private readonly AppWindow appWindow;
        private bool closingConfirmed;

        /// Callback that returns true if close should proceed (no unsaved changes or user confirmed).
        /// Set from MainWindow after bridge is initialized.
        public Func<Task<bool>>? OnCloseRequested { get; set; }

        private const int WM_USER = 0x0400;
        private const int WM_LBUTTONDBLCLK = 0x0203;
        private const int WM_RBUTTONUP = 0x0205;
        private const int WM_GETMINMAXINFO = 0x0024;
        private const int WM_DISPLAYCHANGE = 0x007E;
        private const int SW_RESTORE = 9;
        // Layout minimum in DIPs. WM_GETMINMAXINFO works in physical pixels, so this
        // is scaled by the window's DPI before being written to ptMinTrackSize.
        // 960 (not the 1180 the window still OPENS at — see WindowAppearanceService.
        // Configure) so the app can be snapped to HALF of a 1920×1080 display next to
        // the game being macroed — the single most common arrangement for the target
        // workflow, at 100% display scaling. (At 125%+ the DPI-scaled floor exceeds
        // the 960-physical-px half-screen slot; going lower would break the React
        // layout, so scaled displays keep a slightly-over-half minimum.) Below
        // ~1020px the React shell auto-collapses the side panels to their icon
        // rails (App.tsx), so the center grid keeps a usable width.
        private const int BaseMinWidthDip = 960;
        private const int BaseMinHeightDip = 780;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOACTIVATE = 0x0010;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        public WindowEventManager(Window window)
        {
            this.window = window;
            hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);

            var windowId = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd);
            appWindow = AppWindow.GetFromWindowId(windowId);
            appWindow.Closing += OnAppWindowClosing;

            window.Closed += Window_Closed;
        }

        private async void OnAppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
        {
            if (closingConfirmed)
                return;

            // When System Tray is enabled, close (X) minimizes to tray instead of exiting
            if (((MainWindow)window).IsMinimizeToTrayEnabled())
            {
                args.Cancel = true;
                TrayIconService.Initialize((MainWindow)window, hwnd);
                TrayIconService.ShowMinimizeBalloon();
                appWindow.Hide();
                return;
            }

            if (OnCloseRequested == null)
                return;

            args.Cancel = true;

            bool canClose = await OnCloseRequested();
            if (canClose)
            {
                closingConfirmed = true;
                ForceExit();
            }
        }

        private void Window_Closed(object sender, WindowEventArgs args)
        {
            ForceExit();
        }

        private void ForceExit()
        {
            InputHookManager.Stop();
            TrayIconService.RemoveTrayIcon();
            Microsoft.UI.Xaml.Application.Current.Exit();
            Environment.Exit(0);
        }

        public IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == WM_GETMINMAXINFO)
            {
                MINMAXINFO mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam)!;
                // ptMinTrackSize is in physical pixels — scale the DIP minimum by the
                // window's current DPI so the floor matches the layout minimum at any scale
                // (GetDpiForWindow returns 96 at 100%; falls back to 96 if it ever returns 0).
                uint dpi = GetDpiForWindow(hwnd);
                if (dpi == 0) dpi = 96;
                mmi.ptMinTrackSize.x = (int)(BaseMinWidthDip * dpi / 96.0);
                mmi.ptMinTrackSize.y = (int)(BaseMinHeightDip * dpi / 96.0);
                Marshal.StructureToPtr(mmi, lParam, true);
                return IntPtr.Zero;
            }

            if (msg == WM_USER + 1)
            {
                if ((int)lParam == WM_LBUTTONDBLCLK)
                {
                    ShowWindow(hwnd, SW_RESTORE);
                    SetForegroundWindow(hwnd);
                }
                else if ((int)lParam == WM_RBUTTONUP)
                {
                    TrayIconService.ShowContextMenu();
                }
            }
            else if (msg == WM_DISPLAYCHANGE)
            {
                // Monitor/resolution/DPI change — drop the cached virtual-screen bounds so replay
                // coordinate normalization uses the new geometry instead of stale metrics.
                NativeMethods.VirtualScreen.Invalidate();
            }
            return HwndHookManager.CallOriginalWndProc(hwnd, msg, wParam, lParam);
        }

        public void BringToForeground()
        {
            // Make the window on-screen FIRST (unhide from tray, un-minimize) so the activation
            // below has a visible target regardless of prior state.
            if (!IsWindowVisible(hwnd))
                appWindow.Show();
            // Only restore if minimized — preserves maximized state.
            if (IsIconic(hwnd))
                ShowWindow(hwnd, SW_RESTORE);

            // Already the foreground window? Skip the activation dance entirely.
            if (GetForegroundWindow() == hwnd)
                return;

            uint currentThread = GetCurrentThreadId();
            IntPtr foregroundHwnd = GetForegroundWindow();
            // GetForegroundWindow returns NULL during focus transitions (menu just closed, an app
            // releasing fullscreen, etc.). Passing that to GetWindowThreadProcessId yields thread 0,
            // and AttachThreadInput(0, …) silently fails — so SetForegroundWindow gets rejected by
            // Windows' foreground lock and the window doesn't come up. That is the intermittent
            // "pressed the hotkey and nothing happened, worked next time" bug. Guard the 0 case so
            // we skip the (useless) attach instead of poisoning the whole call.
            uint foregroundThread = foregroundHwnd != IntPtr.Zero
                ? GetWindowThreadProcessId(foregroundHwnd, out _)
                : 0;

            // AttachThreadInput trick: share the foreground thread's input queue so Windows treats
            // our SetForegroundWindow as coming from the active thread. Track success so we only
            // detach what we actually attached (and always detach, via finally).
            bool attached = false;
            if (foregroundThread != 0 && foregroundThread != currentThread)
                attached = AttachThreadInput(foregroundThread, currentThread, true);

            // Belt-and-suspenders: temporarily zero the foreground-lock timeout so Windows honours
            // SetForegroundWindow from a background process even when the attach trick alone isn't
            // enough. The user's real value is saved and restored in finally so this can't leak.
            uint prevLockTimeout = 0;
            bool lockTimeoutZeroed = false;
            try
            {
                if (SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ref prevLockTimeout, 0))
                    lockTimeoutZeroed = SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);

                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }
            finally
            {
                if (lockTimeoutZeroed)
                    SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, new IntPtr(prevLockTimeout), SPIF_SENDCHANGE);
                if (attached)
                    AttachThreadInput(foregroundThread, currentThread, false);
            }
        }

        public void UpdateAlwaysOnTop(bool isAlwaysOnTop)
        {
            SetWindowPos(hwnd,
                isAlwaysOnTop ? HWND_TOPMOST : HWND_NOTOPMOST,
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MINMAXINFO
        {
            public NativeMethods.POINT ptReserved;
            public NativeMethods.POINT ptMaxSize;
            public NativeMethods.POINT ptMaxPosition;
            public NativeMethods.POINT ptMinTrackSize;
            public NativeMethods.POINT ptMaxTrackSize;
        }

        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
        // Two overloads: GET writes the value through a ref; SET passes the new value IN the
        // pvParam slot itself (SPI_SETFOREGROUNDLOCKTIMEOUT is a "value-in-pointer" action).
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
        private const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
        private const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
        private const uint SPIF_SENDCHANGE = 0x0002;
    }
}