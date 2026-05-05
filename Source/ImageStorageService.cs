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
            if (string.IsNullOrEmpty(imagePath)) return null;

            string fullPath = Path.Combine(GetImageDirectory(profileName), imagePath);
            if (!File.Exists(fullPath)) return null;

            // Load into memory to avoid file lock
            using var stream = new MemoryStream(File.ReadAllBytes(fullPath));
            return new Bitmap(stream);
        }

        /// <summary>
        /// Deletes a reference image file.
        /// </summary>
        public static void DeleteReferenceImage(string profileName, string imagePath)
        {
            if (string.IsNullOrEmpty(imagePath)) return;

            string fullPath = Path.Combine(GetImageDirectory(profileName), imagePath);
            try { if (File.Exists(fullPath)) File.Delete(fullPath); }
            catch { /* best effort */ }
        }

        /// <summary>
        /// Reads a reference image as base64 (for embedding in export).
        /// </summary>
        public static string? ReadAsBase64(string profileName, string imagePath)
        {
            if (string.IsNullOrEmpty(imagePath)) return null;

            string fullPath = Path.Combine(GetImageDirectory(profileName), imagePath);
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
            string dir = GetImageDirectory(profileName);
            Directory.CreateDirectory(dir);

            string fullPath = Path.Combine(dir, filename);
            File.WriteAllBytes(fullPath, Convert.FromBase64String(base64Data));
        }

        /// <summary>
        /// Copies a reference image from one profile to another (or within the same profile)
        /// under a new GUID filename. Returns the new filename, or null if the source doesn't exist.
        /// </summary>
        public static string? CloneReferenceImage(string srcProfile, string srcImagePath, string dstProfile)
        {
            if (string.IsNullOrEmpty(srcImagePath)) return null;

            string srcFullPath = Path.Combine(GetImageDirectory(srcProfile), srcImagePath);
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

        private static string SanitizeFolderName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');
            return name;
        }
    }
}
