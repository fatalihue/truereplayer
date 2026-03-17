using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

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

        private static string SanitizeFolderName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');
            return name;
        }
    }
}
