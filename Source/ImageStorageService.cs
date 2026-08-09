using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
// ExternalException — the base GDI+ failure type Bitmap can surface for a damaged image.
using System.Runtime.InteropServices;

namespace TrueReplayer.Services
{
    public static class ImageStorageService
    {
        // Reference images live under %LocalAppData%\TrueReplayer\Images — the same
        // machine-local root as the WebView2 data and logs. They were previously in
        // %AppData% (Roaming), but Roaming is the wrong home for large binary crops
        // (it bloats the roaming profile and slows domain logins), and keeping them
        // in Local consolidates all app-internal storage to one place (only Documents
        // — perfis/settings — stays separate as user-facing data).
        private static bool _legacyMigrationChecked;

        private static string GetBaseDirectory()
        {
            string baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TrueReplayer", "Images");
            // One-shot, lazy migration the first time any image op resolves the base
            // dir — no startup wiring needed, and the bool guard keeps it off the hot
            // path after the first call.
            if (!_legacyMigrationChecked)
            {
                _legacyMigrationChecked = true;
                TryMigrateLegacyImages(baseDir);
            }
            return baseDir;
        }

        // Moves any images left in the old Roaming location into the new Local one.
        // Per-profile-dir merge (never clobbers an existing Local subdir), then drops
        // the old root if it ends up empty. Best-effort: failures are logged, not fatal.
        private static void TryMigrateLegacyImages(string newBaseDir)
        {
            try
            {
                string oldBase = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "TrueReplayer", "Images");
                if (!Directory.Exists(oldBase)) return; // nothing legacy to migrate

                Directory.CreateDirectory(newBaseDir);
                foreach (var oldDir in Directory.EnumerateDirectories(oldBase))
                {
                    string dest = Path.Combine(newBaseDir, Path.GetFileName(oldDir));
                    if (!Directory.Exists(dest))
                        try { Directory.Move(oldDir, dest); } catch { /* best effort */ }
                }
                // Defensive: relocate any loose PNGs sitting at the old root too.
                foreach (var f in Directory.EnumerateFiles(oldBase, "*.png"))
                {
                    string dest = Path.Combine(newBaseDir, Path.GetFileName(f));
                    if (!File.Exists(dest))
                        try { File.Move(f, dest); } catch { /* best effort */ }
                }
                if (!Directory.EnumerateFileSystemEntries(oldBase).Any())
                    try { Directory.Delete(oldBase); } catch { /* best effort */ }

                DiagnosticLog.Info("[Images] Migrated reference images from Roaming to LocalAppData");
            }
            catch (Exception ex)
            {
                try { DiagnosticLog.Info($"[Images] Legacy image migration failed: {ex.Message}"); } catch { }
            }
        }

        public static string GetImageDirectory(string profileName)
        {
            return Path.Combine(GetBaseDirectory(), SanitizeFolderName(profileName));
        }

        /// <summary>
        /// Saves a reference image for a profile and returns the filename.
        /// </summary>
        public static string SaveReferenceImage(Bitmap image, string profileName)
        {
            string dir = GetImageDirectory(profileName);
            Directory.CreateDirectory(dir);

            string filename = $"wait-{Guid.NewGuid():N}.png";
            string fullPath = Path.Combine(dir, filename);

            // Write to a temp file and rename, instead of encoding straight into the final path.
            // Bitmap.Save streams the PNG out incrementally, so a process death partway through —
            // a Velopack update restarting the app, a crash, a full disk — used to leave a
            // TRUNCATED file sitting at the exact name an action already references. That file then
            // exists (File.Exists is true, so no caller treats it as missing) but cannot be decoded,
            // which is how LoadReferenceImage came to throw where its callers expected null. The
            // rename is the same temp+rename pattern FileHelper already gives profile writes; reuse
            // its retry so an antivirus scan of the freshly-written temp doesn't fail the save.
            //
            // The temp deliberately ends in ".png" so CleanupOrphanImages' startup sweep reaps any
            // leftover as an unreferenced image, and deliberately does NOT use the "wait-" prefix so
            // a half-written file can never be mistaken for a live reference by a human reading the
            // folder.
            string tempPath = Path.Combine(dir, $"partial-{Guid.NewGuid():N}.png");
            try
            {
                image.Save(tempPath, ImageFormat.Png);
                FileHelper.MoveAtomic(tempPath, fullPath);
            }
            catch
            {
                try { File.Delete(tempPath); } catch { }
                throw;
            }
            return filename;
        }

        /// <summary>
        /// Loads a reference image from the profile's image directory.
        /// </summary>
        public static Bitmap? LoadReferenceImage(string profileName, string imagePath)
        {
            if (!TryResolveImageFile(profileName, imagePath, out string fullPath)) return null;
            if (!File.Exists(fullPath)) return null;

            // Every caller — WaitImage and If-ImageFound in ActionExecution, the image-condition
            // watcher in TriggerService, the crop/test handlers in WebViewBridge — reads null as
            // "no usable reference image" and has a policy for it (WaitImage's is the OnTimeout
            // policy its comment already promises to apply to a PNG that is "missing/unreadable").
            // The method is even declared Bitmap?. But an undecodable file used to come out as a
            // THROW, not a null: GDI+ answers a truncated or non-PNG stream with ArgumentException,
            // and — a long-standing quirk, not a real allocation failure — with OutOfMemoryException
            // for image data it cannot parse. Neither ever reached the null branch, so the
            // "unreadable" half of that promise did not exist; the exception escaped into the replay
            // loop instead. Fail the way the callers were written for, and log so the file can be
            // found and re-captured.
            //
            // The read itself (File.ReadAllBytes) is included: a locked or vanished file is the same
            // "no usable image" answer, and racing File.Exists above cannot rule it out.
            try
            {
                // Load into a detached bitmap: System.Drawing.Bitmap keeps a reference to its
                // backing stream for its lifetime, so copy into an independent Bitmap before the
                // MemoryStream is disposed — otherwise later pixel access / Save throws GDI+ errors.
                using var stream = new MemoryStream(File.ReadAllBytes(fullPath));
                using var loaded = new Bitmap(stream);
                return new Bitmap(loaded);
            }
            catch (Exception ex) when (ex is ArgumentException
                                    || ex is OutOfMemoryException
                                    || ex is IOException
                                    || ex is UnauthorizedAccessException
                                    || ex is ExternalException)
            {
                try { DiagnosticLog.Info($"[Images] Reference image '{fullPath}' could not be decoded ({ex.GetType().Name}: {ex.Message}) — treated as missing. Truncated by an interrupted save, or not a PNG; re-capture it."); } catch { }
                return null;
            }
        }

        /// <summary>
        /// Reads a reference image as base64 (for embedding in export).
        /// </summary>
        public static string? ReadAsBase64(string profileName, string imagePath)
        {
            if (!TryResolveImageFile(profileName, imagePath, out string fullPath)) return null;
            if (!File.Exists(fullPath)) return null;

            return Convert.ToBase64String(File.ReadAllBytes(fullPath));
        }

        // PNG 8-byte signature. Imported reference images must be real PNGs within sane size
        // bounds — rejects an empty/oversized blob or a non-image payload smuggled in a hostile
        // .trprofile before it ever lands on disk.
        private static readonly byte[] PngSignature = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
        private static bool IsValidPng(byte[] bytes)
        {
            // Upper bound covers a full-screen / multi-monitor PNG (the 50 MB base64 envelope cap
            // decodes to ~37 MB); reject only genuinely absurd/oversized blobs.
            if (bytes.Length < 8 || bytes.Length > 40 * 1024 * 1024) return false;
            for (int i = 0; i < PngSignature.Length; i++)
                if (bytes[i] != PngSignature[i]) return false;
            return true;
        }

        /// <summary>
        /// True when a reference image already exists on disk for the profile. Used by import to
        /// avoid falsely flagging a WaitImage / If-ImageFound row as broken when an Overwrite
        /// re-import omits an image the receiver already has.
        /// </summary>
        public static bool ReferenceImageExists(string profileName, string untrustedName)
            => TryResolveImageFile(profileName, untrustedName, out var fullPath) && File.Exists(fullPath);

        /// <summary>
        /// Saves a base64-encoded image with a specific filename (for import with original name).
        /// </summary>
        /// Returns true if the image was written; false if the filename was rejected
        /// (traversal/invalid) or the base64 payload was malformed. The import counts the
        /// false returns to warn the user about reference images that didn't restore,
        /// instead of the action silently pointing at a missing PNG.
        public static bool SaveFromBase64(string base64Data, string profileName, string filename)
        {
            // filename originates from an imported .trprofile (untrusted). Resolve it to a
            // sanitized path inside the profile's image dir, rejecting traversal/invalid names.
            // The same Path.GetFileName reduction runs on the read side (LoadReferenceImage et
            // al.), so a name like "..\\x.png" maps to "x.png" consistently and the action's
            // ImagePath still resolves after import.
            if (!TryResolveImageFile(profileName, filename, out string fullPath)) return false;

            // The payload must BE a PNG (IsValidPng below) but the NAME was unconstrained, so an
            // envelope could ask for "payload.dll" and get a file whose bytes start with \x89PNG
            // written into the profile's image folder. Nothing loads that folder and the content is
            // still a PNG, so this is not code execution — the real cost is that it becomes
            // permanent litter: CleanupOrphanImages only enumerates "*.png", so the startup sweep
            // never reaps it, and even deleting the profile leaves it behind unless the whole
            // directory goes. Every reference image this app writes is a .png; requiring the
            // extension costs nothing and keeps the folder to one file type.
            if (!fullPath.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
            {
                try { DiagnosticLog.Info($"[Images] Rejected '{filename}': reference images must be .png."); } catch { }
                return false;
            }

            Directory.CreateDirectory(GetImageDirectory(profileName));
            // base64Data is untrusted import data and this runs once per image inside
            // ConfirmImportAsync's loop. Swallow a malformed payload (log + skip this one
            // image) so one bad entry doesn't abort the rest of the import — but report it
            // via the return value so the import can surface a warning.
            try
            {
                var bytes = Convert.FromBase64String(base64Data);
                if (!IsValidPng(bytes)) { try { DiagnosticLog.Info($"[Images] Rejected '{filename}': not a valid PNG or out of size bounds."); } catch { } return false; }
                File.WriteAllBytes(fullPath, bytes);
                return true;
            }
            catch (Exception ex)
            {
                try { DiagnosticLog.Info($"[Images] Skipped '{filename}' with invalid base64 data: {ex.Message}"); } catch { }
                return false;
            }
        }

        /// <summary>
        /// Copies a reference image from one profile to another (or within the same profile)
        /// under a new GUID filename. Returns the new filename, or null if the source doesn't exist.
        /// </summary>
        public static string? CloneReferenceImage(string srcProfile, string srcImagePath, string dstProfile)
        {
            if (!TryResolveImageFile(srcProfile, srcImagePath, out string srcFullPath)) return null;
            if (!File.Exists(srcFullPath)) return null;

            string dstDir = GetImageDirectory(dstProfile);
            Directory.CreateDirectory(dstDir);

            string newFilename = $"wait-{Guid.NewGuid():N}.png";
            string dstFullPath = Path.Combine(dstDir, newFilename);
            try
            {
                File.Copy(srcFullPath, dstFullPath, overwrite: false);
                return newFilename;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Renames a profile's image directory. No-op if the old directory doesn't exist
        /// or the new directory already exists.
        /// </summary>
        public static void RenameProfileDirectory(string oldProfileName, string newProfileName)
        {
            string oldDir = GetImageDirectory(oldProfileName);
            string newDir = GetImageDirectory(newProfileName);

            if (string.Equals(oldDir, newDir, StringComparison.OrdinalIgnoreCase)) return;
            if (!Directory.Exists(oldDir)) return;
            if (Directory.Exists(newDir)) return;

            try { Directory.Move(oldDir, newDir); }
            catch { /* best effort */ }
        }

        /// <summary>
        /// Deletes a profile's entire image directory. Best-effort.
        /// </summary>
        public static void DeleteProfileDirectory(string profileName)
        {
            string dir = GetImageDirectory(profileName);
            try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
            catch { /* best effort */ }
        }

        /// <summary>
        /// Sweep at app startup: deletes PNGs in each profile's image directory that aren't
        /// referenced by any action across all profiles. Runs before any user-driven undo can
        /// happen so we never delete a file the in-memory undo stack still expects.
        /// referencedByProfile maps profileName → set of ImagePath filenames that should be kept.
        /// Profiles without an entry have all their PNGs deleted (and the dir if it ends up empty).
        /// </summary>
        public static int CleanupOrphanImages(IReadOnlyDictionary<string, HashSet<string>> referencedByProfile, IReadOnlySet<string>? keepEntirelyFolders = null)
        {
            int deleted = 0;
            string baseDir = GetBaseDirectory();
            if (!Directory.Exists(baseDir)) return 0;

            foreach (var profileDir in Directory.EnumerateDirectories(baseDir))
            {
                string profileFolder = Path.GetFileName(profileDir);
                // profileFolder is sanitized; map back is not exact, but referencedByProfile keys
                // are sanitized via the same SanitizeFolderName used to write, so equivalent lookup.
                // A profile that FAILED to load (corrupt/half-written JSON) is recorded in
                // _loadFailures but has NO entry in referencedByProfile — without this skip its
                // entire image folder would be treated as orphaned and deleted, losing the user's
                // reference PNGs on a recoverable error. Keep such folders untouched.
                if (keepEntirelyFolders?.Contains(profileFolder) == true) continue;
                referencedByProfile.TryGetValue(profileFolder, out var referenced);
                referenced ??= new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                try
                {
                    foreach (var file in Directory.EnumerateFiles(profileDir, "*.png"))
                    {
                        string name = Path.GetFileName(file);
                        if (!referenced.Contains(name))
                        {
                            try { File.Delete(file); deleted++; }
                            catch { /* best effort */ }
                        }
                    }
                    // Remove empty profile directories left behind by deleted profiles whose
                    // referencedByProfile entry was missing entirely.
                    if (!referencedByProfile.ContainsKey(profileFolder)
                        && !Directory.EnumerateFileSystemEntries(profileDir).Any())
                    {
                        try { Directory.Delete(profileDir); }
                        catch { /* best effort */ }
                    }
                }
                catch { /* best effort */ }
            }
            return deleted;
        }

        /// <summary>
        /// Returns the sanitized folder name actually used on disk for a profile. Useful when
        /// building the referenced-image map for CleanupOrphanImages so the keys line up with
        /// the directory names returned by enumeration.
        /// </summary>
        public static string GetSanitizedProfileFolder(string profileName) => SanitizeFolderName(profileName);

        /// <summary>
        /// Resolves an untrusted image file name to a full path guaranteed to live directly
        /// inside the profile's image directory. Strips directory components (defeats "..\\"
        /// and absolute-path traversal) and rejects names with invalid characters. Returns
        /// false (empty path) when the name can't be safely resolved.
        /// </summary>
        private static bool TryResolveImageFile(string profileName, string untrustedName, out string fullPath)
        {
            fullPath = string.Empty;
            if (string.IsNullOrEmpty(untrustedName)) return false;

            // Reduce to a bare file name: "..\\..\\evil.png" -> "evil.png", "C:\\x\\y.png" -> "y.png".
            string safeName = Path.GetFileName(untrustedName);
            if (string.IsNullOrEmpty(safeName)) return false;
            if (safeName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;

            string dir = GetImageDirectory(profileName);
            string candidate = Path.Combine(dir, safeName);

            // Defense in depth: confirm the resolved path stays under the image directory.
            string canonicalDir = Path.GetFullPath(dir);
            if (!canonicalDir.EndsWith(Path.DirectorySeparatorChar))
                canonicalDir += Path.DirectorySeparatorChar;
            if (!Path.GetFullPath(candidate).StartsWith(canonicalDir, StringComparison.OrdinalIgnoreCase))
                return false;

            fullPath = candidate;
            return true;
        }

        // Path.GetInvalidFileNameChars() allocates a FRESH char[] on every call (it hands out a copy
        // so callers cannot mutate the framework's own array), and SanitizeFolderName runs twice per
        // TryResolveImageFile. One copy, taken once.
        private static readonly char[] InvalidFileNameChars = Path.GetInvalidFileNameChars();

        private static string SanitizeFolderName(string name)
        {
            // The overwhelmingly common case is a name with no invalid char at all, and IndexOfAny
            // answers that in one pass instead of 41 string.Replace calls (each of which allocates
            // whether or not it replaced anything).
            if (name.IndexOfAny(InvalidFileNameChars) >= 0)
            {
                foreach (char c in InvalidFileNameChars)
                    name = name.Replace(c, '_');
            }

            // '.' and ' ' are NOT in Path.GetInvalidFileNameChars(), so "." and ".." come through
            // the loop completely untouched — and this is the ONLY guard the folder name ever gets.
            // TryResolveImageFile's containment check protects the FILE name; every caller of
            // GetImageDirectory (SaveReferenceImage, CloneReferenceImage, RenameProfileDirectory,
            // DeleteProfileDirectory, GetSanitizedProfileFolder) feeds the folder straight into
            // Path.Combine with no check of its own. Verified against the real APIs:
            //   Combine(...\Images, "..")  -> %LocalAppData%\TrueReplayer
            //   Combine(...\Images, ".")   -> %LocalAppData%\TrueReplayer\Images
            //   Combine(...\Images, "")    -> %LocalAppData%\TrueReplayer\Images
            //   Combine(...\Images, "   ") -> %LocalAppData%\TrueReplayer\Images\  (spaces stripped)
            // so DeleteProfileDirectory("..") is Directory.Delete(recursive: true) on the entire
            // app-local root — WebView2 data, Logs, Images, run cursors, automation stats,
            // appsettings, remaps — and "." / "" / "   " wipe the whole Images tree.
            //
            // ProfileNameValidator.IsSafe rejects "." and "..", so this is NOT reachable from an
            // imported .trprofile (import also always writes entry.Name + ".json"). But the
            // validator does not OWN this path, and its own comment claims coverage it cannot give:
            // a file literally named "...json" dropped into the Profiles directory by a zip
            // extraction, a cloud-sync artefact or a manual copy is perfectly legal on NTFS (no
            // trailing dot, no invalid char), matches LoadProfileListAsync's "*.json" enumeration,
            // and Path.GetFileNameWithoutExtension splits at the LAST dot — yielding "..". The
            // "..json" and ".json" variants yield "." and "" the same way. Those names reach the
            // sidebar without ever passing through the validator, and deleting the phantom profile
            // is what pulls the trigger. Neutralize at the folder boundary, where it belongs.
            //
            // Only names with NO substantive content are rewritten — everything that keeps at least
            // one non-dot, non-space character is returned byte-identical. That is deliberate: the
            // on-disk folder key must stay exactly what previous versions wrote, or
            // CleanupOrphanImages stops matching existing folders and deletes every reference PNG
            // the user has. (The degenerate names do collide with each other — "" and "." both map
            // to "_" — which is fine: none of them should exist, and sharing one junk folder is not
            // in the same universe as erasing LocalAppData.)
            if (name.TrimEnd('.', ' ').Length == 0)
                name = name.Length == 0 ? "_" : name.Replace('.', '_').Replace(' ', '_');

            return name;
        }
    }
}
