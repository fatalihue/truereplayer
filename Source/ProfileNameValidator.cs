using System;
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
        /// True when <paramref name="name"/> is a bare, storable profile name: no traversal, no
        /// path separators / invalid chars, no trailing dot or space, and not a reserved device
        /// name. Guards against a malicious/buggy .trprofile envelope or WebView payload smuggling
        /// a name that later feeds Path.Combine / File.Move.
        /// </summary>
        public static bool IsSafe(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
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
            return true;
        }
    }
}
