using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
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
        private const uint NIF_INFO = 0x10;

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
        private const uint TPM_RETURNCMD = 0x0100;

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

            string iconPath = UserProfile.Current.ProfileKeyEnabled
                ? Path.Combine(AppContext.BaseDirectory, "TrueReplayer.ico")
                : Path.Combine(AppContext.BaseDirectory, "TrueReplayerRed.ico");

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
                szTip = "TrueReplayer"
            };

            Shell_NotifyIcon(NIM_ADD, ref notifyIcon);

            if (showNotification)
            {
                ShowMinimizeBalloon();
            }
        }

        public static void UpdateTrayIcon()
        {
            string iconPath = UserProfile.Current.ProfileKeyEnabled
                ? Path.Combine(AppContext.BaseDirectory, "TrueReplayer.ico")
                : Path.Combine(AppContext.BaseDirectory, "TrueReplayerRed.ico");

            ReleaseCurrentIcon();
            currentIconHandle = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);

            notifyIcon.hIcon = currentIconHandle;
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
                Shell_NotifyIcon(NIM_DELETE, ref notifyIcon);
                ReleaseCurrentIcon();
                isInitialized = false;
            }
        }

        private static void ReleaseCurrentIcon()
        {
            if (currentIconHandle != IntPtr.Zero)
            {
                DestroyIcon(currentIconHandle);
                currentIconHandle = IntPtr.Zero;
            }
        }

        public static void ShowContextMenu()
        {
            IntPtr hMenu = CreatePopupMenu();
            AppendMenu(hMenu, MF_STRING, 1, "Restaurar");
            AppendMenu(hMenu, MF_STRING, 2, "Sair");

            GetCursorPos(out NativeMethods.POINT pt);
            SetForegroundWindow(hwnd);
            int cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD, pt.x, pt.y, 0, hwnd, IntPtr.Zero);
            DestroyMenu(hMenu);

            if (cmd == 1) ShowWindow(hwnd, 9);
            else if (cmd == 2)
            {
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
        [DllImport("user32.dll")] private static extern bool AppendMenu(IntPtr hMenu, uint uFlags, uint uIDNewItem, string lpNewItem);
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
            appWindow.Resize(new Windows.Graphics.SizeInt32(1180, 750));
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
            // Register the closing event handler
            window.Closed += Window_Closed;
        }

        private void Window_Closed(object sender, WindowEventArgs args)
        {
            InputHookManager.Stop();
            TrayIconService.RemoveTrayIcon();
        }

        public IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == WM_GETMINMAXINFO)
            {
                MINMAXINFO mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam)!;
                mmi.ptMinTrackSize.x = 1180;
                mmi.ptMinTrackSize.y = 750;
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
            else if (msg == WM_SYSCOMMAND)
            {
                int command = wParam.ToInt32() & 0xFFF0;

                if (command == SC_MINIMIZE && ((MainWindow)window).IsMinimizeToTrayEnabled())
                {
                    TrayIconService.Initialize((MainWindow)window, hwnd);
                    TrayIconService.ShowMinimizeBalloon();

                    var windowId = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd);
                    AppWindow.GetFromWindowId(windowId).Hide();

                    return IntPtr.Zero;
                }
            }

            return HwndHookManager.CallOriginalWndProc(hwnd, msg, wParam, lParam);
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
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    }
}