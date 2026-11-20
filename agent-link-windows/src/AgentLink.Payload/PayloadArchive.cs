using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace AgentLink;

internal static class PayloadArchive
{
    private const string ManifestName = "release-manifest.json";
    private const int ManifestLimit = 2 * 1024 * 1024;
    private static readonly StringComparer Names = StringComparer.OrdinalIgnoreCase;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly string[] RequiredFiles =
        ["AgentLink.exe", "host/AgentLink.Host.exe", "runtime/gateway-node.exe", "components/gateway/device-gateway.mjs"];
    private static readonly HashSet<string> DeviceNames = new(Names)
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
    };

    private sealed record FileHash(string Path, string Sha256);
    private sealed record Manifest(int SchemaVersion, string Product, long BuildNumber, FileHash[] Files);
    private sealed record Contents(Dictionary<string, ZipArchiveEntry> Files, Dictionary<string, string> Hashes);

    internal static void Extract(string path, string payload, PayloadRelease release)
    {
        using var archive = Open(path, release);
        var contents = ReadContents(archive, release);
        PathSafety.DirectoryTree(payload, create: true);
        var buffer = new byte[64 * 1024];
        foreach (var (name, entry) in contents.Files)
        {
            var target = Path.Combine(payload, name.Replace('/', Path.DirectorySeparatorChar));
            PathSafety.DirectoryTree(Path.GetDirectoryName(target)!, create: true);
            using var source = entry.Open();
            using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            for (var remaining = entry.Length; remaining > 0;)
            {
                var count = (int)Math.Min(remaining, buffer.Length);
                source.ReadExactly(buffer.AsSpan(0, count));
                output.Write(buffer.AsSpan(0, count));
                remaining -= count;
            }
            if (source.ReadByte() != -1) throw new InvalidDataException("Windows payload entry length changed.");
            output.Flush(flushToDisk: true);
        }
        VerifyDirectory(payload, contents.Hashes);
    }

    internal static void Verify(string path, string payload, PayloadRelease release)
    {
        using var archive = Open(path, release);
        VerifyDirectory(payload, ReadContents(archive, release).Hashes);
    }

    private static ZipArchive Open(string path, PayloadRelease release)
    {
        PathSafety.RegularFile(path);
        var stream = File.OpenRead(path);
        try
        {
            if (stream.Length != release.ArchiveLength ||
                !Names.Equals(Convert.ToHexString(SHA256.HashData(stream)), release.ArchiveSha256))
                throw new InvalidDataException("Windows payload archive differs from the trusted target.");
            stream.Position = 0;
            return new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: false);
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static Contents ReadContents(ZipArchive archive, PayloadRelease release)
    {
        var files = new Dictionary<string, ZipArchiveEntry>(Names);
        var names = new HashSet<string>(Names);
        foreach (var entry in archive.Entries)
        {
            var directory = entry.FullName.EndsWith('/');
            var name = directory ? entry.FullName[..^1] : entry.FullName;
            var unixType = (entry.ExternalAttributes >> 16) & 0xf000;
            var windowsAttributes = (FileAttributes)(entry.ExternalAttributes & 0xffff);
            if (!SafeName(name) || !names.Add(name) ||
                unixType != 0 && unixType != (directory ? 0x4000 : 0x8000) ||
                (windowsAttributes & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0 ||
                !directory && (windowsAttributes & FileAttributes.Directory) != 0 ||
                directory && entry.Length != 0)
                throw new InvalidDataException("Windows payload contains an unsupported path or entry.");
            if (!directory) files.Add(name, entry);
        }
        if (!files.TryGetValue(ManifestName, out var manifestEntry) || manifestEntry.Length is < 1 or > ManifestLimit)
            throw new InvalidDataException("Windows payload is missing a bounded release manifest.");
        var data = new byte[(int)manifestEntry.Length];
        using (var stream = manifestEntry.Open())
        {
            stream.ReadExactly(data);
            if (stream.ReadByte() != -1) throw new InvalidDataException("Invalid Windows release manifest length.");
        }
        ReadOnlySpan<byte> body = data;
        ReadOnlySpan<byte> bom = [0xef, 0xbb, 0xbf];
        if (body.StartsWith(bom)) body = body[bom.Length..];
        var manifest = JsonSerializer.Deserialize<Manifest>(body, Json);
        if (manifest is not { SchemaVersion: 1, Product: "Agent Link", Files: not null } ||
            manifest.BuildNumber != release.BuildNumber || manifest.Files.Length != files.Count - 1)
            throw new InvalidDataException("Windows release manifest does not describe the trusted build.");
        var hashes = new Dictionary<string, string>(Names)
        {
            { ManifestName, Convert.ToHexString(SHA256.HashData(data)) },
        };
        foreach (var file in manifest.Files)
        {
            if (file?.Path is null || !SafeName(file.Path) || file.Sha256 is not { Length: 64 } digest ||
                digest.Any(character => !char.IsAsciiHexDigit(character)) ||
                !files.ContainsKey(file.Path) || !hashes.TryAdd(file.Path, digest))
                throw new InvalidDataException("Windows release manifest contains an invalid file entry.");
        }
        if (RequiredFiles.Any(name => !hashes.ContainsKey(name)))
            throw new InvalidDataException("Windows payload is missing a required runtime file.");
        return new(files, hashes);
    }

    private static void VerifyDirectory(string payload, Dictionary<string, string> hashes)
    {
        PathSafety.DirectoryTree(payload);
        var pending = new Stack<string>();
        var seen = new HashSet<string>(Names);
        pending.Push(payload);
        while (pending.TryPop(out var directory))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Windows payload directory contains a redirected entry.");
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    pending.Push(entry);
                    continue;
                }
                PathSafety.RegularFile(entry);
                var name = Path.GetRelativePath(payload, entry).Replace(Path.DirectorySeparatorChar, '/');
                if (!hashes.TryGetValue(name, out var digest) || !seen.Add(name))
                    throw new InvalidDataException("Windows payload directory contains an unexpected file.");
                using var stream = File.OpenRead(entry);
                if (!Names.Equals(Convert.ToHexString(SHA256.HashData(stream)), digest))
                    throw new InvalidDataException("Windows payload file differs from its release manifest.");
            }
        }
        if (seen.Count != hashes.Count) throw new InvalidDataException("Windows payload directory is incomplete.");
    }

    private static bool SafeName(string name) =>
        name.Split('/').All(part => part.Length > 0 && !part.EndsWith('.') && !part.EndsWith(' ') &&
            !DeviceNames.Contains(part.Split('.')[0].TrimEnd(' ')) &&
            !part.Any(character => char.IsControl(character) || "<>:\"\\|?*".Contains(character)));
}
