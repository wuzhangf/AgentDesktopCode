using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace AgentLink;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var check = args is ["--check-update"];
        if (!check && args is not ([] or ["--background"] or ["--autostart-on"] or ["--autostart-off"])) return 2;
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000)) return 2;
        var install = AppContext.BaseDirectory;
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Steercrew", "AgentLinkRuntime", LinkProtocol.Instance);
        string result = "repair-required";
        long? active = null;
        int? bootstrap = null;
        FileStream? running = null;
        try
        {
            PathSafety.DirectoryTree(root, create: true);
            running = Acquire(root);
            if (running is null) return 0;
            var config = BootstrapConfig.Read();
            bootstrap = config.BootstrapVersion;
            var publisher = new PublisherTrust(config.PublisherKey);
            var launcher = Environment.ProcessPath ?? throw new IOException("Missing Windows launcher executable.");
            publisher.Verify(launcher);
            var trust = new ReleaseTrust(root, config);
            var store = new PayloadActivation(root, trust.Allows, publisher.Verify);
            var selected = store.Recover();
            if (selected is null)
            {
                await using var seed = new WindowsUpdateSession(Guid.NewGuid().ToString("N"), seed: true);
                var installed = await store.ActivateAsync(config.Seed, Path.Combine(install, "seed.zip"),
                    seed.PrepareAsync, seed.ProbeAsync);
                if (installed.Current is null)
                {
                    result = installed.Status == ActivationStatus.Busy ? "busy" : "seed-rejected";
                    return 1;
                }
                selected = installed.Current;
            }
            result = "active";
            if (check && config.Channel is not null)
                (selected, result) = await CheckAsync(install, root, config, trust, store, selected);
            active = selected.Release.BuildNumber;
            var start = new ProcessStartInfo(Path.Combine(selected.Directory, "AgentLink.exe"))
                { UseShellExecute = false, WorkingDirectory = selected.Directory };
            start.Environment["AGENT_LINK_WINDOWS_LAUNCHER"] = launcher;
            start.Environment["AGENT_LINK_WINDOWS_UPDATE_AVAILABLE"] = config.Channel is null ? "0" : "1";
            if (check) start.ArgumentList.Add("--background");
            else foreach (var arg in args) start.ArgumentList.Add(arg);
            using var tray = Process.Start(start) ?? throw new IOException("Agent Link tray did not start.");
            return 0;
        }
        catch (Exception error) when (Expected(error))
        {
            result = "repair-required";
            return 1;
        }
        finally
        {
            if (running is not null)
            {
                using (running)
                {
                    try
                    {
                        var status = Path.Combine(root, "launch-status.json");
                        if (PathSafety.Exists(status)) PathSafety.RegularFile(status);
                        File.WriteAllBytes(status, JsonSerializer.SerializeToUtf8Bytes(
                            new { state = result, bootstrapVersion = bootstrap, activeBuild = active }, JsonSerializerOptions.Web));
                    }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException) { }
                }
            }
        }
    }

    private static FileStream? Acquire(string root)
    {
        var path = Path.Combine(root, "launcher.lock");
        try
        {
            if (PathSafety.Exists(path)) PathSafety.RegularFile(path);
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None);
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33) { return null; }
    }

    private static async Task<(InstalledPayload, string)> CheckAsync(string install, string root, BootstrapConfig config,
        ReleaseTrust trust, PayloadActivation store, InstalledPayload current)
    {
        var staging = Path.Combine(root, ".update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            var verifier = new WindowsReleaseSource(install, Path.Combine(root, "metadata"), config, trust.Cohort);
            var selected = await verifier.SelectAsync(current.Release.BuildNumber, staging, confirm: false, default);
            trust.Observe(selected);
            if (!trust.Allows(current.Release)) throw new InvalidDataException("The running release was withdrawn.");
            if (selected is not { State: "candidate", Target: { } candidate, ArchivePath: { } archive })
                return (current, "deferred");

            await using var upgrade = new WindowsUpdateSession(Guid.NewGuid().ToString("N"), seed: false);
            var installed = await store.ActivateAsync(candidate, archive, upgrade.PrepareAsync, async (payload, cancellation) =>
            {
                if (!await upgrade.ProbeAsync(payload, cancellation)) return false;
                var fresh = await verifier.SelectAsync(current.Release.BuildNumber, staging, confirm: true, cancellation);
                trust.Observe(fresh);
                return fresh.State == "candidate" && fresh.Target == candidate &&
                    trust.Allows(current.Release) && trust.Allows(candidate);
            });
            return (installed.Current ?? throw new InvalidDataException("No trusted release after Windows update."),
                installed.Status.ToString().ToLowerInvariant());
        }
        catch (Exception error) when (Expected(error))
        {
            return (store.Recover() ?? throw new InvalidDataException("No trusted Windows update recovery."), "recovered");
        }
        finally { DeletePrivateDirectory(staging); }
    }

    internal static void DeletePrivateDirectory(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private static bool Expected(Exception error) => error is IOException or UnauthorizedAccessException or
        InvalidDataException or CryptographicException or Win32Exception or JsonException or OperationCanceledException;
}
