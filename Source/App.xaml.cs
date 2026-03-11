using System;
using Microsoft.UI.Xaml;
using TrueReplayer.Models;
using TrueReplayer.Services;
using WinRT.Interop;

namespace TrueReplayer
{
    public sealed partial class App : Application
    {
        public App()
        {
            this.InitializeComponent();
        }

        protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
        {
            m_window = new MainWindow();
            m_window.Activate();

            // Only minimize if launched by OS autostart (no user interaction),
            // not when the user opens the app manually.
            if (UserProfile.Current.StartMinimized && IsAutoStartLaunch())
            {
                var hwnd = WindowNative.GetWindowHandle(m_window);
                var windowId = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd);
                Microsoft.UI.Windowing.AppWindow.GetFromWindowId(windowId).Hide();
                TrayIconService.ShowMinimizeBalloon();
            }
        }

        /// <summary>
        /// Detects if the app was launched by Windows autostart (Run registry key)
        /// by checking if Explorer.exe is the parent process.
        /// </summary>
        private static bool IsAutoStartLaunch()
        {
            try
            {
                using var currentProcess = System.Diagnostics.Process.GetCurrentProcess();
                var parentId = GetParentProcessId(currentProcess.Id);
                if (parentId <= 0) return false;

                using var parentProcess = System.Diagnostics.Process.GetProcessById(parentId);
                return string.Equals(parentProcess.ProcessName, "explorer",
                    StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        [System.Runtime.InteropServices.DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            IntPtr processHandle, int processInformationClass,
            ref PROCESS_BASIC_INFORMATION processInformation,
            int processInformationLength, out int returnLength);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        private static int GetParentProcessId(int processId)
        {
            var handle = System.Diagnostics.Process.GetProcessById(processId).Handle;
            var pbi = new PROCESS_BASIC_INFORMATION();
            int status = NtQueryInformationProcess(handle, 0, ref pbi, System.Runtime.InteropServices.Marshal.SizeOf(pbi), out _);
            return status == 0 ? pbi.InheritedFromUniqueProcessId.ToInt32() : -1;
        }

        private Window? m_window;
    }
}
