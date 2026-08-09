using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Single source of truth for "is this string safe to use as a profile name (and therefore
    /// as its on-disk file name AND image-folder key)". This was previously duplicated as a
    /// private <c>IsSafeProfileName</c> in both <see cref="TrueReplayer.Controllers"/>'s
    /// ProfileController and TrueReplayer's WebViewBridge — a security/data-loss validator with
    /// "no shared owner", exactly the kind that must never drift between copies. It now lives here
    /// and both callers delegate, so a hardening change can never be applied to only one copy.
    /// </summary>
    public static class ProfileNameValidator
    {
        // Windows reserved device names, matched case-insensitively on the part before the first
        // dot (e.g. "CON", "CON.json", "COM1.foo" all resolve to the device, not a file).
        private static readonly Regex ReservedDeviceNames =
            new(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        /// <summary>
        /// Maximum length of a profile name, in characters. Public so a caller can surface the
        /// number in an error message instead of a bare "Invalid profile name".
        ///
        /// Where 120 comes from. The longest path a profile name feeds is NOT its own .json — it is
        /// the reference image, %LocalAppData%\TrueReplayer\Images\&lt;name&gt;\wait-&lt;32 hex&gt;.png, whose
        /// fixed parts total 86 chars ("C:\Users\" 9 + "\AppData\Local\TrueReplayer\Images\" 35 +
        /// the separator 1 + "wait-" 5 + 32 hex + ".png" 4). The profile file itself is cheaper: 52
        /// fixed chars even after ".json" AND the " (99)" suffix ProfileController's
        /// AllocateImportName appends on a name collision. app.manifest declares no
        /// &lt;longPathAware&gt;, so the usable limit stays MAX_PATH's 259 (260 including the NUL).
        /// 259 - 86 leaves 173 to split between the user-profile folder and the name; reserving a
        /// generous 40 for "C:\Users\&lt;user&gt;" (a domain-suffixed or redirected profile folder runs
        /// past the 20-char SAM account limit) leaves 133, rounded down to 120 for slack. Still
        /// five times the longest name in a real profile set.
        /// </summary>
        public const int MaxNameLength = 120;

        // Filenames the application itself owns inside %USERPROFILE%\Documents\TrueReplayer\Profiles.
        // Stored WITHOUT the ".json" so the lookup can run against baseName — the same
        // extension-insensitive trick the device-name check uses, and what makes "profile-order",
        // "profile-order.json" and "PROFILE-ORDER.JSON" all collapse onto one entry. That matters
        // because the two write paths disagree: import does entry.Name + ".json" while the WebView
        // create/rename path appends ".json" only when it isn't already there, so the colliding
        // spelling differs per call site.
        //
        // Grepped, not guessed — these are every constant filename any code path writes INTO the
        // Profiles directory:
        //   profile-order.json  ProfileController.ProfileOrderPath (folders / pins / colours)
        //   profile.json        SettingsManager.GetDefaultProfilePath — the startup default profile
        //                       that MainWindow loads through the parameterless LoadProfileAsync()
        // Everything else the app persists (remaps.json, remaps.bak.json, remaps.pending.json,
        // run-cursors.json, automation-stats.json, appsettings.json, icon-cache.json) lives one
        // level UP in ...\TrueReplayer\, out of a profile name's reach. Re-check this list if a
        // sidecar ever moves down into Profiles.
        private static readonly HashSet<string> ReservedAppFileNames =
            new(StringComparer.OrdinalIgnoreCase) { "profile-order", "profile" };

        /// <summary>
        /// True when <paramref name="name"/> is a bare, storable profile name: no traversal, no
        /// path separators / invalid chars, no trailing dot or space, and not a reserved device
        /// name. Guards against a malicious/buggy .trprofile envelope or WebView payload smuggling
        /// a name that later feeds Path.Combine / File.Move.
        /// </summary>
        public static bool IsSafe(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
            // Nothing else in the app bounds this. The create/rename dialogs in ProfilePanel.tsx
            // carry no maxLength at all, and import reads entry.Name verbatim out of the .trprofile
            // envelope — whose 50 MB ceiling comfortably holds a thousand 300-character names.
            // Uncapped, an over-long name does not fail fast, it fails EXPENSIVELY: File.Exists
            // returns false for a too-long path instead of throwing, the import's containment check
            // passes (Path.GetFullPath does not enforce MAX_PATH on .NET 8), and the first thing
            // that actually objects is FileHelper's File.Move, throwing PathTooLongException /
            // DirectoryNotFoundException — both IOException subclasses, i.e. indistinguishable from
            // a transient antivirus lock to a naive retry filter. Rejecting here is what keeps that
            // path from being reached at all; FileHelper.IsPermanentPathFailure is the second half.
            if (name.Length > MaxNameLength) return false;
            if (name == "." || name == "..") return false;
            string baseName = name.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? name[..^5] : name;
            if (string.IsNullOrWhiteSpace(baseName)) return false;
            if (baseName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
            // A trailing '.' or ' ' is silently stripped by Windows when the file/folder is
            // created, so "Farm." is written to disk as "Farm" while the image-folder key stays
            // "Farm." (SanitizeFolderName keeps the dot). At startup CleanupOrphanImages then
            // enumerates the on-disk "Farm" folder, misses the "Farm." key, treats every PNG as
            // orphaned and DELETES the profile's reference images. Reject rather than silently
            // normalize so the name can never diverge from its on-disk key.
            if (baseName.Length != baseName.TrimEnd('.', ' ').Length) return false;
            // Reserved device names hit the device instead of a file (Images\CON can't be created),
            // corrupting the profile + its image storage.
            string deviceName = baseName;
            int dot = deviceName.IndexOf('.');
            if (dot >= 0) deviceName = deviceName[..dot];
            if (ReservedDeviceNames.IsMatch(deviceName)) return false;
            // The application's own files share the Profiles directory with user profiles, and
            // nothing downstream re-checks a name against them. Importing {"name":"profile-order"}
            // onto a machine with no organisation file yet writes the profile straight into
            // profile-order.json — and then LoadProfileListAsync filters that exact filename out of
            // the listing, so it is counted as imported and is invisible. Nothing reports the damage
            // either: LoadProfileOrderAsync deserialises the UserProfile JSON as ProfileOrderData
            // WITHOUT throwing (System.Text.Json ignores unknown properties and the two types share
            // no keys), so the catch that would have preserved a .bak never runs, and the next pin
            // or folder action overwrites the file. "profile" is the same trap via SettingsManager's
            // default path; that one is at least listed, but the startup default-profile load/save
            // treats it as its own scratch file.
            if (ReservedAppFileNames.Contains(baseName)) return false;
            return true;
        }
    }
}
