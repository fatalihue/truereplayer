using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Win32;
using Velopack;
using Velopack.Sources;

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

            // Silent auto-update before the app window opens.
            // If an update is found, download and restart automatically.
            try
            {
                var mgr = new UpdateManager(new GithubSource(
                    "https://github.com/fatalihue/TrueReplayer-releases", null, false));

                if (mgr.IsInstalled)
                {
                    var update = Task.Run(() => mgr.CheckForUpdatesAsync()).GetAwaiter().GetResult();
                    if (update != null)
                    {
                        Task.Run(() => mgr.DownloadUpdatesAsync(update)).GetAwaiter().GetResult();
                        mgr.ApplyUpdatesAndRestart(update.TargetFullRelease);
                        return; // App will restart with the new version
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[AutoUpdate] Pre-launch update failed: {ex.Message}");
                // Continue launching the app normally if update fails
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
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[NativeHost] Registry registration failed: {ex.Message}");
            }
        }
    }
}
