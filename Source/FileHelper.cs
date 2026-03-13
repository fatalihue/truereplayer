using System.IO;
using System.Threading.Tasks;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Provides atomic file write operations to prevent data corruption
    /// from crashes or power loss during writes.
    /// </summary>
    public static class FileHelper
    {
        /// <summary>
        /// Writes content to a file atomically by first writing to a temp file,
        /// then renaming it over the target. If the process crashes mid-write,
        /// the original file remains intact.
        /// </summary>
        public static void WriteAllTextAtomic(string filePath, string content)
        {
            var dir = Path.GetDirectoryName(filePath)!;
            var tempPath = Path.Combine(dir, Path.GetRandomFileName());
            File.WriteAllText(tempPath, content);
            File.Move(tempPath, filePath, overwrite: true);
        }

        /// <summary>
        /// Async version of WriteAllTextAtomic.
        /// </summary>
        public static async Task WriteAllTextAtomicAsync(string filePath, string content)
        {
            var dir = Path.GetDirectoryName(filePath)!;
            var tempPath = Path.Combine(dir, Path.GetRandomFileName());
            await File.WriteAllTextAsync(tempPath, content);
            File.Move(tempPath, filePath, overwrite: true);
        }
    }
}
