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

            Shell_NotifyIcon(NIM_ADD, ref notifyIcon);

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
            NotifyIconData data = notifyIcon;
            data.uFlags |= NIF_INFO;
            data.szInfoTitle = "TrueReplayer is running in the background";
            data.szInfo = "Click the tray icon to restore the window.";
            data.dwInfoFlags = NIIF_INFO;
            Shell_NotifyIcon(NIM_MODIFY, ref data);
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
            using var key = Registry.CurrentUser.OpenSubKey(StartupRegistryKey, true);
            if (key == null) return;

            if (enable)
                key.SetValue(StartupValueName, $"\"{Environment.ProcessPath}\" --startup");
            else
                key.DeleteValue(StartupValueName, false);

            // Persist to appsettings
            var settings = AppSettingsManager.Load();
            settings.RunOnStartup = enable;
            AppSettingsManager.Save(settings);
        }

        /// Callback invoked after tray menu toggles a setting, so bridge can push updated state to UI.
        public static Action? OnTraySettingChanged { get; set; }

        /// Callback to apply Always On Top window state from the tray menu.
        public static Action<bool>? OnAlwaysOnTopChanged { get; set; }
        public static Action? OnReloadUI { get; set; }
        public static Action? OnOpenDevTools { get; set; }
        public static Action? OnOpenLogsFolder { get; set; }

        public static async void ShowContextMenu()
        {
            bool isAlwaysOnTop = UserProfile.Current.AlwaysOnTop;
            bool isMinimizeToTray = UserProfile.Current.MinimizeToTray;
            bool isStartup = IsRunOnStartup();
            bool isStartMinimized = UserProfile.Current.StartMinimized;
            bool isRunAsAdmin = AppSettingsManager.Load().RunAsAdmin;

            IntPtr hMenu = CreatePopupMenu();
            AppendMenu(hMenu, MF_STRING, 1, "Restore");
            AppendMenu(hMenu, MF_SEPARATOR, 0, null);
            AppendMenu(hMenu, MF_STRING | (isAlwaysOnTop ? MF_CHECKED : 0), 5, "Always On Top");
            AppendMenu(hMenu, MF_STRING | (isMinimizeToTray ? MF_CHECKED : 0), 6, "System Tray");
            AppendMenu(hMenu, MF_STRING | (isStartup ? MF_CHECKED : 0), 3, "Run on Startup");
            AppendMenu(hMenu, MF_STRING | (isStartMinimized ? MF_CHECKED : 0), 4, "Startup Minimized");
            AppendMenu(hMenu, MF_STRING | (isRunAsAdmin ? MF_CHECKED : 0), 7, "Run as Administrator");
            AppendMenu(hMenu, MF_STRING, 8, "Reload UI");
            AppendMenu(hMenu, MF_STRING, 9, "Open DevTools");
            AppendMenu(hMenu, MF_STRING, 10, "Open Logs Folder");
            AppendMenu(hMenu, MF_SEPARATOR, 0, null);
            AppendMenu(hMenu, MF_STRING, 2, "Exit");

            GetCursorPos(out NativeMethods.POINT pt);
            SetForegroundWindow(hwnd);
            int cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD, pt.x, pt.y, 0, hwnd, IntPtr.Zero);
            DestroyMenu(hMenu);

            if (cmd == 1) ShowWindow(hwnd, 9);
            else if (cmd == 5)
            {
                UserProfile.Current.AlwaysOnTop = !isAlwaysOnTop;
                OnAlwaysOnTopChanged?.Invoke(UserProfile.Current.AlwaysOnTop);
                var settings = AppSettingsManager.Load();
                settings.AlwaysOnTop = UserProfile.Current.AlwaysOnTop;
                AppSettingsManager.Save(settings);
                OnTraySettingChanged?.Invoke();
            }
            else if (cmd == 6)
            {
                UserProfile.Current.MinimizeToTray = !isMinimizeToTray;
                var settings = AppSettingsManager.Load();
                settings.MinimizeToTray = UserProfile.Current.MinimizeToTray;
                AppSettingsManager.Save(settings);
                OnTraySettingChanged?.Invoke();
            }
            else if (cmd == 3)
            {
                SetRunOnStartup(!isStartup);
                OnTraySettingChanged?.Invoke();
            }
            else if (cmd == 4)
            {
                UserProfile.Current.StartMinimized = !isStartMinimized;
                var settings = AppSettingsManager.Load();
                settings.StartMinimized = UserProfile.Current.StartMinimized;
                AppSettingsManager.Save(settings);
                OnTraySettingChanged?.Invoke();
            }
            else if (cmd == 7)
            {
                var settings = AppSettingsManager.Load();
                settings.RunAsAdmin = !isRunAsAdmin;
                AppSettingsManager.Save(settings);
                OnTraySettingChanged?.Invoke();
            }
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
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIcon(uint dwMessage, ref NotifyIconData lpdata);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadImage(IntPtr hInst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);
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
            appWindow.Resize(new Windows.Graphics.SizeInt32(1180, 780));
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
        private const int WM_SYSCOMMAND = 0x0112;
        private const int WM_GETMINMAXINFO = 0x0024;
        private const int SC_MINIMIZE = 0xF020;
        private const int SW_RESTORE = 9;
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
                mmi.ptMinTrackSize.x = 1180;
                mmi.ptMinTrackSize.y = 780;
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
            return HwndHookManager.CallOriginalWndProc(hwnd, msg, wParam, lParam);
        }

        public void BringToForeground()
        {
            // AttachThreadInput trick: attach our thread to the foreground thread
            // so Windows allows SetForegroundWindow from background
            var foregroundHwnd = GetForegroundWindow();
            uint foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out _);
            uint currentThread = GetCurrentThreadId();

            if (foregroundThread != currentThread)
                AttachThreadInput(foregroundThread, currentThread, true);

            // If hidden in the system tray (appWindow.Hide()), bring it back
            if (!IsWindowVisible(hwnd))
                appWindow.Show();
            // Only restore if minimized — preserves maximized state
            if (IsIconic(hwnd))
                ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);

            if (foregroundThread != currentThread)
                AttachThreadInput(foregroundThread, currentThread, false);
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
    }
}