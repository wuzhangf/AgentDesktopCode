using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace AgentLink;

internal sealed class WindowsReleaseSource(string install, string metadata, string archiveCache,
    BootstrapConfig config, string cohort)
{
    internal async Task<WindowsReleaseResult> SelectAsync(long currentBuild, string staging, bool confirm,
        CancellationToken cancellation, Func<string?>? blocked = null)
    {
        if (config.Channel is not { } channel) throw new InvalidOperationException("Windows update channel is unavailable.");
        var node = Path.Combine(install, "update-node.exe");
        var script = Path.Combine(install, "verify-windows.cjs");
        CheckHash(node, channel.NodeSha256);
        CheckHash(script, channel.VerifierSha256);
        PathSafety.DirectoryTree(metadata, create: true);
        var rootPath = Path.Combine(metadata, "root.json");
        if (!File.Exists(rootPath))
        {
            using var root = Assembly.GetExecutingAssembly().GetManifestResourceStream("AgentLink.Launcher.root")
                ?? throw new InvalidDataException("Missing packaged Windows update trust root.");
            using var output = new FileStream(rootPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            root.CopyTo(output);
            output.Flush(flushToDisk: true);
        }
        PathSafety.RegularFile(rootPath);
        var request = Path.Combine(staging, "request.json");
        var options = new
        {
            metadataDir = metadata, channel.MetadataBaseUrl, channel.TargetBaseUrl, channel.ReleaseRecordPath,
            stagingParent = staging, cohort, archiveCache,
            installed = new { platform = "windows", arch = "x86_64", channel = channel.Channel, buildNumber = currentBuild,
                bootstrapVersion = config.BootstrapVersion, stateVersion = 1 },
        };
        File.WriteAllBytes(request, JsonSerializer.SerializeToUtf8Bytes(options, JsonSerializerOptions.Web));
        var start = new ProcessStartInfo(node)
        {
            WorkingDirectory = install, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        start.Environment.Clear();
        foreach (var name in new[] { "SystemRoot", "WINDIR", "TEMP", "TMP" })
            if (Environment.GetEnvironmentVariable(name) is { } value) start.Environment[name] = value;
        start.ArgumentList.Add(script);
        start.ArgumentList.Add(request);
        if (confirm) start.ArgumentList.Add("confirm");
        CheckPolicy(blocked);
        using var child = Process.Start(start) ?? throw new IOException("Windows verifier did not start.");
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(confirm ? 30 : 180));
            var read = child.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = child.StandardError.BaseStream.CopyToAsync(Stream.Null, timeout.Token);
            var exited = child.WaitForExitAsync(timeout.Token);
            if (blocked is not null)
            {
                while (!exited.IsCompleted)
                {
                    try { await exited.WaitAsync(TimeSpan.FromSeconds(1)); }
                    catch (TimeoutException) { CheckPolicy(blocked); }
                }
            }
            await exited;
            var output = await read;
            await errors;
            if (child.ExitCode != 0 || output.Length > 64 * 1024)
                throw new InvalidDataException("Windows release verification did not complete.");
            var result = JsonSerializer.Deserialize<WindowsReleaseResult>(output, JsonSerializerOptions.Web);
            if (result is null || result.State is not ("candidate" or "deferred" or "download-deferred" or "repair") ||
                result.State == "candidate" && (result.Target is null || !confirm && !StagedPath(staging, result.ArchivePath)))
                throw new InvalidDataException("Invalid Windows verifier output.");
            return result;
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync();
            }
        }
    }

    private static void CheckPolicy(Func<string?>? blocked)
    {
        if (blocked?.Invoke() is { } reason) throw new AutomaticUpdateDeferredException(reason);
    }

    private static bool StagedPath(string staging, string? path)
    {
        if (path is null || !Path.IsPathFullyQualified(path)) return false;
        var relative = Path.GetRelativePath(staging, path);
        return relative.StartsWith("link-update-", StringComparison.Ordinal) &&
            Path.GetDirectoryName(relative) is { } parent &&
            !parent.Contains(Path.DirectorySeparatorChar) &&
            Path.GetFileName(relative) == "archive";
    }

    private static void CheckHash(string file, string expected)
    {
        PathSafety.RegularFile(file);
        using var stream = File.OpenRead(file);
        if (!Convert.ToHexString(SHA256.HashData(stream)).Equals(expected, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("Windows verifier differs from its signed bootstrap.");
    }
}
