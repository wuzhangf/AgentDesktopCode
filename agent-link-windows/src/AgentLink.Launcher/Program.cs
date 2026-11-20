using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace AgentLink;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var automatic = args is ["--check-update-background"];
        var check = automatic || args is ["--check-update" or "--repair"];
        if (!check && args is not ([] or ["--background"] or ["--autostart-on"] or ["--autostart-off"])) return 2;
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000)) return 2;
        var install = AppContext.BaseDirectory;
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Steercrew", "AgentLinkRuntime", LinkProtocol.Instance);
        string result = "repair-required";
        long? active = null;
        int? bootstrap = null;
        FileStream? running = null;
        var writeStatus = false;
        try
        {
            PathSafety.DirectoryTree(root, create: true);
            running = Acquire(root);
            if (running is null) return 0;
            writeStatus = !automatic;
            var config = BootstrapConfig.Read();
            bootstrap = config.BootstrapVersion;
            var schedule = new WindowsUpdateSchedule(LinkProtocol.Root);
            var checkedAt = DateTimeOffset.UtcNow;
            AutomaticUpdatePolicy? policy = null;
            if (automatic)
            {
                if (config.Channel is null || !schedule.CanStart(checkedAt)) return 0;
                schedule.Record(checkedAt, checkedAt, "checking", 0);
                policy = new AutomaticUpdatePolicy(schedule);
                if (policy.Block(installation: false) is { } reason)
                {
                    RecordSchedule(schedule, checkedAt, reason);
                    return 0;
                }
            }
            writeStatus = true;
            var publisher = new PublisherTrust(config.PublisherKey);
            var launcher = Environment.ProcessPath ?? throw new IOException("Missing Windows launcher executable.");
            publisher.Verify(launcher);
            WindowsUpdateSession.PruneProbeSnapshots();
            var trust = new ReleaseTrust(root, config);
            var store = new PayloadActivation(root, trust.Allows, publisher.Verify);
            var selection = store.Inspect();
            var selected = selection.Runnable;
            if (selection.Committed is null)
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
            var relaunch = true;
            if (config.Channel is not null && (check || selected is null))
            {
                var committed = selection.Committed ?? selected!.Release;
                if (!check && args is ["--background"]) policy = new AutomaticUpdatePolicy(schedule);
                (selected, result, relaunch) = await CheckAsync(install, root, config, trust, store, committed, selected,
                    policy, allowOffline: !automatic);
                RecordSchedule(schedule, checkedAt, selected is null && result is not ("busy" or "waiting-window" or
                    "waiting-network" or "disabled" or "download-deferred") ? "repair-required" : result);
            }
            else if (config.Channel is not null)
            {
                try { schedule.Initialize(checkedAt, Random.Shared.Next(1, 61)); }
                catch (Exception error) when (Expected(error)) { }
            }
            if (selected is null)
            {
                result = "repair-required";
                return 3;
            }
            active = selected.Release.BuildNumber;
            if (automatic && !relaunch) return 0;
            var start = new ProcessStartInfo(Path.Combine(selected.Directory, "AgentLink.exe"))
                { UseShellExecute = false, WorkingDirectory = selected.Directory };
            start.Environment["AGENT_LINK_WINDOWS_LAUNCHER"] = launcher;
            start.Environment["AGENT_LINK_WINDOWS_UPDATE_AVAILABLE"] = config.Channel is null ? "0" : "1";
            start.Environment["AGENT_LINK_WINDOWS_SCHEDULE_AVAILABLE"] = config.Channel is null ? "0" : "1";
            if (check)
            {
                start.ArgumentList.Add("--background");
                start.Environment["AGENT_LINK_WINDOWS_RESUMING_UPDATE"] = "1";
            }
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
                    if (writeStatus)
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
    }

    private static void RecordSchedule(WindowsUpdateSchedule schedule, DateTimeOffset checkedAt, string result)
    {
        try { schedule.Record(checkedAt, DateTimeOffset.UtcNow, result, Random.Shared.Next(-30, 31)); }
        catch (Exception error) when (Expected(error)) { }
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

    private static async Task<(InstalledPayload?, string, bool)> CheckAsync(string install, string root,
        BootstrapConfig config, ReleaseTrust trust, PayloadActivation store, PayloadRelease committed,
        InstalledPayload? current, AutomaticUpdatePolicy? policy, bool allowOffline)
    {
        PruneWorkDirectories(root);
        var staging = Path.Combine(root, ".update-" + Guid.NewGuid().ToString("N"));
        var archiveCache = Path.Combine(root, "cached-windows-payload.zip");
        Directory.CreateDirectory(staging);
        await using var upgrade = new WindowsUpdateSession(Guid.NewGuid().ToString("N"), seed: false,
            allowOffline: allowOffline);

        string? DownloadBlock() => policy?.Block(installation: false);
        void RequireInstallWindow()
        {
            if (policy?.Block(installation: true) is { } reason) throw new AutomaticUpdateDeferredException(reason);
        }

        try
        {
            var verifier = new WindowsReleaseSource(install, Path.Combine(root, "metadata"),
                archiveCache, config, trust.Cohort);
            var selected = await verifier.SelectAsync(committed.BuildNumber, staging, confirm: false, default,
                policy is null ? null : DownloadBlock);
            trust.Observe(selected);
            if (!trust.Allows(committed)) current = null;
            if (selected is not { State: "candidate", Target: { } candidate, ArchivePath: { } archive })
                return (current, selected.State, false);
            RequireInstallWindow();
            var repair = current is null;

            var installed = await store.ActivateAsync(candidate, archive, cancellation =>
            {
                RequireInstallWindow();
                return upgrade.PrepareAsync(cancellation);
            }, upgrade.ProbeAsync, confirmCommit: async cancellation =>
            {
                RequireInstallWindow();
                var fresh = await verifier.SelectAsync(committed.BuildNumber, staging, confirm: true, cancellation,
                    policy is null ? null : DownloadBlock);
                trust.Observe(fresh);
                if (fresh.State != "candidate" || fresh.Target != candidate ||
                    (!repair && !trust.Allows(committed)) || !trust.Allows(candidate))
                    throw new InvalidDataException("The Windows release changed during installation.");
                RequireInstallWindow();
            }, repair: repair);
            if (installed.Status == ActivationStatus.Committed)
            {
                try { File.Delete(archiveCache); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            }
            return (installed.Current, installed.Status.ToString().ToLowerInvariant(),
                upgrade.ShutdownAccepted || installed.Status == ActivationStatus.Committed);
        }
        catch (Exception error) when (Expected(error))
        {
            var outcome = error is AutomaticUpdateDeferredException deferred ? deferred.Outcome : "recovered";
            return (store.Inspect().Runnable, outcome, upgrade.ShutdownAccepted);
        }
        finally { PathSafety.TryDeleteDirectory(staging); }
    }

    private static void PruneWorkDirectories(string root)
    {
        try
        {
            foreach (var directory in Directory.EnumerateDirectories(root, ".update-*"))
                if (PathSafety.IsOperationDirectory(Path.GetFileName(directory), ".update-"))
                    PathSafety.TryDeleteDirectory(directory);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private static bool Expected(Exception error) => error is IOException or UnauthorizedAccessException or
        InvalidDataException or CryptographicException or Win32Exception or JsonException or OperationCanceledException;
}
