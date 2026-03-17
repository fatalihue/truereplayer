using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
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

            global::WinRT.ComWrappersSupport.InitializeComWrappers();
            Application.Start(p =>
            {
                var context = new DispatcherQueueSynchronizationContext(
                    DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                new App();
            });
        }
    }
}
