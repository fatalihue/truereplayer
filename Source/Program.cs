using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Win32;
using Velopack;
using TrueReplayer.Services;

namespace TrueReplayer
{
    public static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // Velopack must run before any WinUI/XAML initialization.
            // It handles install/uninstall/update hooks and exits early when
            // invoked by the updater (e.g. --velopack-install).
            VelopackApp.Build().Run();

            // Auto-update is handled in-app with a visual overlay (UpdateOverlay.tsx)
            // after the UI loads, via WebViewBridge → UpdateService.

            // Self-elevate if RunAsAdmin setting is enabled and not already elevated
            if (ShouldElevate())
            {
                try
                {
                    var exe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
                    if (exe != null)
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = exe,
                            UseShellExecute = true,
                            Verb = "runas"
                        });
                    }
                }
                catch { /* User declined UAC — continue without admin */ }
                return;
            }

            // Check WebView2 Runtime before initializing UI
            if (!IsWebView2Available())
            {
                NativeMessageBox(
                    "TrueReplayer requires Microsoft Edge WebView2 Runtime.\n\n" +
                    "Click OK to open the download page.\n" +
                    "After installing, restart TrueReplayer.",
                    "TrueReplayer — Missing Dependency");
                Process.Start(new ProcessStartInfo
                {
                    FileName = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
                    UseShellExecute = true
                });
                return;
            }

            // Register Native Messaging Host for Chrome Extension
            RegisterNativeMessagingHost();

            global::WinRT.ComWrappersSupport.InitializeComWrappers();
            Application.Start(p =>
            {
                var context = new DispatcherQueueSynchronizationContext(
                    DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                new App();
            });
        }

        private static bool ShouldElevate()
        {
            var settings = AppSettingsManager.Load();
            if (!settings.RunAsAdmin) return false;

            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            return !principal.IsInRole(WindowsBuiltInRole.Administrator);
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

        private static void NativeMessageBox(string text, string caption)
        {
            // MB_OK | MB_ICONWARNING = 0x00000030
            MessageBoxW(IntPtr.Zero, text, caption, 0x00000030);
        }

        private static bool IsWebView2Available()
        {
            try
            {
                var version = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
                return !string.IsNullOrEmpty(version);
            }
            catch
            {
                return false;
            }
        }

        private static void RegisterNativeMessagingHost()
        {
            try
            {
                string appDir = AppContext.BaseDirectory;
                string hostExe = Path.Combine(appDir, "TrueReplayer.NativeHost.exe");
                string manifestPath = Path.Combine(appDir, "native-messaging-manifest.json");

                if (!File.Exists(hostExe)) return;

                // Write the manifest file with the correct path
                string manifest = $$"""
                {
                  "name": "com.truereplayer.native",
                  "description": "TrueReplayer Native Messaging Host",
                  "path": "{{hostExe.Replace("\\", "\\\\")}}",
                  "type": "stdio",
                  "allowed_origins": ["chrome-extension://akbcjaimplfchfaeoedhgkebhjaeebko/"]
                }
                """;
                File.WriteAllText(manifestPath, manifest);

                // Register in Chrome's NativeMessagingHosts registry
                using var key = Registry.CurrentUser.CreateSubKey(
                    @"Software\Google\Chrome\NativeMessagingHosts\com.truereplayer.native");
                key?.SetValue("", manifestPath);

                // Also register for Edge (same Chromium base)
                using var edgeKey = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Edge\NativeMessagingHosts\com.truereplayer.native");
                edgeKey?.SetValue("", manifestPath);

                // Also register for Brave
                using var braveKey = Registry.CurrentUser.CreateSubKey(
                    @"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.truereplayer.native");
                braveKey?.SetValue("", manifestPath);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[NativeHost] Registry registration failed: {ex.Message}");
            }
        }
    }
}
