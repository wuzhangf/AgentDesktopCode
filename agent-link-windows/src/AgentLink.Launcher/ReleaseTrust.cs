using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AgentLink;

internal sealed record BootstrapConfig(PayloadRelease Seed, string PublisherKey, int BootstrapVersion,
    WindowsChannel? Channel)
{
    internal static BootstrapConfig Read()
    {
        using var packaged = Assembly.GetExecutingAssembly().GetManifestResourceStream("AgentLink.Launcher.config");
        var config = packaged is null ? null : JsonSerializer.Deserialize<BootstrapConfig>(packaged, JsonSerializerOptions.Web);
        if (config is not { Seed: not null, BootstrapVersion: > 0, PublisherKey.Length: 64 } ||
            !config.PublisherKey.All(char.IsAsciiHexDigit))
            throw new InvalidDataException("Missing Windows bootstrap release configuration.");
        return config;
    }
}

internal sealed record WindowsChannel(string MetadataBaseUrl, string TargetBaseUrl, string ReleaseRecordPath,
    string Channel, string NodeSha256, string VerifierSha256);

internal sealed record WindowsReleaseResult(string State, long[] Withdrawn, PayloadRelease? Target, string? ArchivePath);

/// <summary>Retains results previously obtained from the packaged TUF verifier for offline startup.</summary>
internal sealed class ReleaseTrust
{
    private sealed record State(PayloadRelease[] Accepted, long[] Withdrawn, string Cohort);
    private readonly string path;
    private readonly byte[] entropy;
    private readonly PayloadRelease seed;
    private State state;

    internal ReleaseTrust(string root, BootstrapConfig config)
    {
        path = Path.Combine(root, "trusted-releases.dpapi");
        entropy = SHA256.HashData(Encoding.UTF8.GetBytes("AgentLink.Windows.Release.v1:" + config.PublisherKey.ToUpperInvariant()));
        seed = config.Seed;
        if (!File.Exists(path))
        {
            state = new([], [], Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant());
            Save();
            return;
        }
        PathSafety.RegularFile(path);
        using var input = File.OpenRead(path);
        if (input.Length > 1024 * 1024) throw new InvalidDataException("Windows release trust is oversized.");
        var wrapped = new byte[(int)input.Length];
        input.ReadExactly(wrapped);
        var clear = ProtectedData.Unprotect(wrapped, entropy, DataProtectionScope.CurrentUser);
        try
        {
            state = JsonSerializer.Deserialize<State>(clear, JsonSerializerOptions.Web)
                ?? throw new InvalidDataException("Missing Windows release trust.");
            if (state.Accepted is null || state.Withdrawn is null || state.Cohort is not { Length: 32 })
                throw new InvalidDataException("Invalid Windows release trust.");
        }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }

    internal string Cohort => state.Cohort;
    internal bool Allows(PayloadRelease release) =>
        !state.Withdrawn.Contains(release.BuildNumber) && (release == seed || state.Accepted.Contains(release));

    internal void Observe(WindowsReleaseResult result)
    {
        if (result.Withdrawn is null || result.Withdrawn.Any(build => build <= 0))
            throw new InvalidDataException("Invalid Windows release withdrawal data.");
        var accepted = state.Accepted;
        if (result.State == "candidate" && result.Target is { } release)
        {
            if (accepted.Any(entry => entry.BuildNumber == release.BuildNumber && entry != release) ||
                release.BuildNumber == seed.BuildNumber && release != seed)
                throw new InvalidDataException("Windows release reuses a build number with different bytes.");
            accepted = accepted.Append(release).Distinct().ToArray();
        }
        var withdrawn = state.Withdrawn.Concat(result.Withdrawn).Distinct().ToArray();
        state = state with { Accepted = accepted.Where(entry => !withdrawn.Contains(entry.BuildNumber)).ToArray(),
            Withdrawn = withdrawn };
        Save();
    }

    private void Save()
    {
        var clear = JsonSerializer.SerializeToUtf8Bytes(state, JsonSerializerOptions.Web);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                output.Write(ProtectedData.Protect(clear, entropy, DataProtectionScope.CurrentUser));
                output.Flush(flushToDisk: true);
            }
            PathSafety.ReplaceFile(temp, path);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(clear);
            File.Delete(temp);
        }
    }
}
