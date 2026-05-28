using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace TrueReplayer.Services
{
    public static class ImageStorageService
    {
        private static string GetBaseDirectory()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "TrueReplayer", "Images");
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
            image.Save(fullPath, ImageFormat.Png);
            return filename;
        }

        /// <summary>
        /// Loads a reference image from the profile's image directory.
        /// </summary>
        public static Bitmap? LoadReferenceImage(string profileName, string imagePath)
        {
            if (!TryResolveImageFile(profileName, imagePath, out string fullPath)) return null;
            if (!File.Exists(fullPath)) return null;

            // Load into a detached bitmap: System.Drawing.Bitmap keeps a reference to its
            // backing stream for its lifetime, so copy into an independent Bitmap before the
            // MemoryStream is disposed — otherwise later pixel access / Save throws GDI+ errors.
            using var stream = new MemoryStream(File.ReadAllBytes(fullPath));
            using var loaded = new Bitmap(stream);
            return new Bitmap(loaded);
        }

        /// <summary>
        /// Deletes a reference image file.
        /// </summary>
        public static void DeleteReferenceImage(string profileName, string imagePath)
        {
            if (!TryResolveImageFile(profileName, imagePath, out string fullPath)) return;

            try { if (File.Exists(fullPath)) File.Delete(fullPath); }
            catch { /* best effort */ }
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

        /// <summary>
        /// Saves a base64-encoded image to the profile directory (for import).
        /// </summary>
        public static string SaveFromBase64(string base64Data, string profileName)
        {
            string dir = GetImageDirectory(profileName);
            Directory.CreateDirectory(dir);

            string filename = $"wait-{Guid.NewGuid():N}.png";
            string fullPath = Path.Combine(dir, filename);
            File.WriteAllBytes(fullPath, Convert.FromBase64String(base64Data));
            return filename;
        }

        /// <summary>
        /// Saves a base64-encoded image with a specific filename (for import with original name).
        /// </summary>
        public static void SaveFromBase64(string base64Data, string profileName, string filename)
        {
            // filename originates from an imported .trprofile (untrusted). Resolve it to a
            // sanitized path inside the profile's image dir, rejecting traversal/invalid names.
            // The same Path.GetFileName reduction runs on the read side (LoadReferenceImage et
            // al.), so a name like "..\\x.png" maps to "x.png" consistently and the action's
            // ImagePath still resolves after import.
            if (!TryResolveImageFile(profileName, filename, out string fullPath)) return;

            Directory.CreateDirectory(GetImageDirectory(profileName));
            File.WriteAllBytes(fullPath, Convert.FromBase64String(base64Data));
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
        public static int CleanupOrphanImages(IReadOnlyDictionary<string, HashSet<string>> referencedByProfile)
        {
            int deleted = 0;
            string baseDir = GetBaseDirectory();
            if (!Directory.Exists(baseDir)) return 0;

            foreach (var profileDir in Directory.EnumerateDirectories(baseDir))
            {
                string profileFolder = Path.GetFileName(profileDir);
                // profileFolder is sanitized; map back is not exact, but referencedByProfile keys
                // are sanitized via the same SanitizeFolderName used to write, so equivalent lookup.
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

        private static string SanitizeFolderName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');
            return name;
        }
    }
}
