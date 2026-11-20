using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

/// Owns the optional PAC relay connector child process (the locked
/// `daily_relay.pac_launcher` artifact under components/connector). The
/// supervisor materializes member credentials, writes the public PAC
/// descriptor, restarts the connector with bounded backoff and surfaces the
/// connector's `pac-relay/1` route line for invitation injection.
internal sealed class ConnectorSupervisor : IDisposable
{
    internal enum Phase { Off, Starting, Linking, Ready, Failed }

    internal sealed record Snapshot(Phase Phase, string? Detail, RelayRoute? Route,
        string? UserCode, bool PackagePresent);

    private static readonly TimeSpan BackoffBase = TimeSpan.FromSeconds(60);
    private static readonly string[] ProxyVariables =
        ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
         "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
         "CURL_CA_BUNDLE"];

    private readonly string installRoot;
    private readonly string memberOrigin;
    private readonly Func<bool> enabled;
    private readonly Func<Ports?> ports;
    private readonly Func<CancellationToken, Task<bool>> ensureDescriptor;
    private readonly Action<Uri> openBrowser;
    private readonly UpdateActivity updateActivity;
    private readonly string workDir;
    private readonly string logDir;
    private readonly string descriptorFile;
    private readonly string pythonPath;
    private readonly bool packagePresent;
    private readonly SemaphoreSlim signal = new(0);
    private readonly object gate = new();
    private readonly StringBuilder errorTail = new();
    private readonly List<Task> readers = [];

    private OwnedProcess? owned;
    private Phase phase = Phase.Off;
    private string? detail;
    private RelayRoute? route;
    private string? userCode;
    private bool wantLink;
    private bool linkActive;
    private bool cancelLink;
    private bool browserOpened;
    private int failures;
    private DateTimeOffset nextAttempt = DateTimeOffset.MinValue;
    private string? activePacOrigin;
    private DateTimeOffset startedAt;
    private Task? loop;
    private bool disposed;

    internal ConnectorSupervisor(string installRoot, string memberOrigin,
        Func<bool> enabled, Func<Ports?> ports,
        Func<CancellationToken, Task<bool>> ensureDescriptor, Action<Uri> openBrowser, UpdateActivity updateActivity)
    {
        this.installRoot = installRoot;
        this.memberOrigin = memberOrigin;
        this.enabled = enabled;
        this.ports = ports;
        this.ensureDescriptor = ensureDescriptor;
        this.openBrowser = openBrowser;
        this.updateActivity = updateActivity;
        workDir = Path.Combine(LinkProtocol.Root, "connector");
        logDir = Path.Combine(LinkProtocol.Root, "logs");
        descriptorFile = Path.Combine(workDir, "public-pac-descriptor.json");
        pythonPath = Path.Combine(installRoot, "components", "connector", "python", "python.exe");
        var manifest = Path.Combine(installRoot, "components", "connector", "relay-manifest.json");
        packagePresent = File.Exists(pythonPath) && File.Exists(manifest)
            && TryReadManifestSchema(manifest);
    }

    private static bool TryReadManifestSchema(string path)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            return doc.RootElement.TryGetProperty("schemaVersion", out var schema)
                && schema.GetString() == "control-relay-package/1";
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    internal bool PackagePresent => packagePresent;

    internal bool LoginPending
    {
        get { lock (gate) return wantLink || linkActive || cancelLink || MemberCredentials.LogoutPending; }
    }

    internal async Task StopForUpdateAsync()
    {
        OwnedProcess? process;
        lock (gate) process = owned;
        if (process is not null) await StopOwnedAsync(process);
    }

    internal Task RunAsync(CancellationToken cancellation) =>
        loop = MonitorAsync(cancellation);

    internal void RequestLogin()
    {
        // A stored session only needs a plain restart; --link is for the
        // first approval or an explicit re-link after logout.
        lock (gate)
        {
            wantLink = !MemberCredentials.HasSession();
            failures = 0;
            nextAttempt = DateTimeOffset.MinValue;
            if (phase == Phase.Failed) phase = Phase.Off;
            detail = null;
        }
        Kick();
    }

    internal void RequestCancel()
    {
        lock (gate)
        {
            wantLink = false;
            if (phase == Phase.Linking)
            {
                linkActive = false;
                cancelLink = true;
                phase = Phase.Off;
                userCode = null;
            }
        }
        Kick();
    }

    internal void RequestLogout()
    {
        lock (gate)
        {
            MemberCredentials.BeginLogout();
            wantLink = false;
            linkActive = false;
            cancelLink = false;
            phase = Phase.Off;
            route = null;
            userCode = null;
            detail = null;
            failures = 0;
            nextAttempt = DateTimeOffset.MinValue;
        }
        Kick();
    }

    internal Snapshot GetSnapshot()
    {
        lock (gate)
        {
            if (MemberCredentials.LogoutPending || cancelLink)
                return new(Phase.Off, null, null, null, packagePresent);
            var alive = owned is { Process.HasExited: false };
            return new(phase, detail, alive ? route : null, alive ? userCode : null, packagePresent);
        }
    }

    private async Task MonitorAsync(CancellationToken cancellation)
    {
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                using var activity = updateActivity.Enter();
                if (activity is not null) await EvaluateAsync(cancellation);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
            catch (Exception) { }
            try { await signal.WaitAsync(TimeSpan.FromMilliseconds(1500), cancellation); }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
        }
    }

    private void Kick()
    {
        try { signal.Release(); } catch (SemaphoreFullException) { }
    }

    private async Task EvaluateAsync(CancellationToken cancellation)
    {
        OwnedProcess? stop = null;
        Ports? spawnPorts = null;
        var spawnLink = false;
        var exited = false;
        lock (gate)
        {
            if (disposed) return;
            var active = ports();
            if (MemberCredentials.LogoutPending)
            {
                stop = owned;
            }
            else if (cancelLink || !packagePresent || active is null || !enabled()
                || !(wantLink || MemberCredentials.HasSession()))
            {
                if (!cancelLink) wantLink = false;
                linkActive = false;
                browserOpened = false;
                stop = owned;
                phase = Phase.Off;
                route = null;
                userCode = null;
                detail = null;
                failures = 0;
                nextAttempt = DateTimeOffset.MinValue;
            }
            else if (owned is { } process)
            {
                exited = process.Process.HasExited;
                // A connector's pinned loopback target can change on gateway restart.
                if (exited || activePacOrigin != PacOrigin(active)) stop = process;
            }
            else if (DateTimeOffset.UtcNow >= nextAttempt)
            {
                spawnPorts = active;
                spawnLink = wantLink;
            }
        }
        if (stop is not null) await StopOwnedAsync(stop);
        lock (gate)
        {
            if (MemberCredentials.LogoutPending)
            {
                if (owned is null) MemberCredentials.CompleteLogout();
                return;
            }
            if (cancelLink)
            {
                if (owned is null) cancelLink = false;
                return;
            }
            if (exited) HandleExit();
            // Seal credentials when idle so the next connector restores them.
            if (owned is null && spawnPorts is null) MemberCredentials.Collect();
        }
        if (spawnPorts is not null) await SpawnAsync(spawnPorts, spawnLink, cancellation);
    }

    private void HandleExit()
    {
        var uptime = DateTimeOffset.UtcNow - startedAt;
        var tail = ErrorTail();
        if (uptime >= BackoffBase) failures = 0;
        if (linkActive)
        {
            // A --link run that exits before printing its route never produced
            // a usable session; report the reason and wait for an explicit retry.
            linkActive = false;
            wantLink = false;
            phase = Phase.Off;
            userCode = null;
            detail = tail ?? "会员授权未完成或已过期";
            return;
        }
        failures++;
        if (failures >= 5)
        {
            phase = Phase.Failed;
            detail = tail ?? "会员连接多次失败";
            nextAttempt = DateTimeOffset.MaxValue;
            return;
        }
        phase = Phase.Starting;
        detail = null;
        var delay = failures switch { 1 => 1, 2 => 2, 3 => 5, 4 => 10, _ => 30 };
        nextAttempt = DateTimeOffset.UtcNow.AddSeconds(delay);
    }

    private async Task SpawnAsync(Ports active, bool link, CancellationToken cancellation)
    {
        Directory.CreateDirectory(workDir);
        Directory.CreateDirectory(logDir);
        if (!await ensureDescriptor(cancellation))
        {
            lock (gate) nextAttempt = DateTimeOffset.UtcNow.AddSeconds(5);
            return;
        }
        var info = LinkHost.ProcessInfo(pythonPath, workDir);
        info.ArgumentList.Add("-I");
        info.ArgumentList.Add("-B");
        info.ArgumentList.Add("-m");
        info.ArgumentList.Add("daily_relay.pac_launcher");
        info.ArgumentList.Add("--member-origin");
        info.ArgumentList.Add(memberOrigin);
        info.ArgumentList.Add("--owner-origin");
        info.ArgumentList.Add($"http://127.0.0.1:{active.Owner}");
        info.ArgumentList.Add("--pac-origin");
        info.ArgumentList.Add($"https://127.0.0.1:{active.Relay}");
        info.ArgumentList.Add("--pac-descriptor");
        info.ArgumentList.Add(descriptorFile);
        if (link)
        {
            info.ArgumentList.Add("--link");
            info.ArgumentList.Add("--client-id");
            info.ArgumentList.Add("agent-link");
        }
        info.Environment["PAC_RELAY_ENV_FILE"] = MemberCredentials.EnvFilePath;
        foreach (var name in ProxyVariables)
            if (Environment.GetEnvironmentVariable(name) is { } value) info.Environment[name] = value;

        OwnedProcess proc;
        lock (gate)
        {
            // A sign-out or cancellation can arrive while the descriptor is fetched.
            if (disposed || MemberCredentials.LogoutPending || cancelLink || link != wantLink) return;
            MemberCredentials.EnsureMaterialized();
            try { proc = new OwnedProcess(info, signalStart: false); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or Win32Exception
                or InvalidOperationException)
            {
                failures++;
                phase = failures >= 5 ? Phase.Failed : Phase.Starting;
                detail = phase == Phase.Failed ? "会员连接组件无法启动" : null;
                var delay = failures switch { 1 => 1, 2 => 2, 3 => 5, 4 => 10, _ => 30 };
                nextAttempt = DateTimeOffset.UtcNow.AddSeconds(delay);
                return;
            }
            owned = proc;
            activePacOrigin = PacOrigin(active);
            startedAt = DateTimeOffset.UtcNow;
            linkActive = link;
            browserOpened = false;
            errorTail.Clear();
            phase = link ? Phase.Linking : Phase.Starting;
            route = null;
            detail = null;
            userCode = null;
        }
        readers.Clear();
        readers.Add(ReadOutputAsync(proc, proc.Process.StandardOutput, Path.Combine(logDir, "connector.out.log"), true));
        readers.Add(ReadOutputAsync(proc, proc.Process.StandardError, Path.Combine(logDir, "connector.err.log"), false));
    }

    private async Task ReadOutputAsync(OwnedProcess process, StreamReader reader, string logFile, bool stdout)
    {
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) is not null)
            {
                try { await File.AppendAllTextAsync(logFile, line + "\n"); } catch (Exception) { }
                lock (gate)
                {
                    if (owned != process || cancelLink || MemberCredentials.LogoutPending) continue;
                    if (stdout) HandleStdoutLine(line.Trim());
                    else AppendError(line);
                }
            }
        }
        catch (Exception) { }
    }

    private void HandleStdoutLine(string line)
    {
        if (RelayContract.TryParseRouteLine(line, out var parsed) && parsed is not null)
        {
            route = parsed;
            phase = Phase.Ready;
            wantLink = false;
            linkActive = false;
            userCode = null;
            detail = null;
            failures = 0;
            nextAttempt = DateTimeOffset.MinValue;
            return;
        }
        if (RelayContract.TryParseApprovalLine(line, out var uri, out var code)
            && uri is not null && Uri.TryCreate(uri, UriKind.Absolute, out var target))
        {
            var first = !browserOpened;
            browserOpened = true;
            phase = Phase.Linking;
            userCode = code;
            if (first)
            {
                try { openBrowser(target); } catch (Exception) { }
            }
        }
    }

    private void AppendError(string line)
    {
        if (line.Length == 0) return;
        errorTail.Append(line).Append('\n');
        if (errorTail.Length > 8000) errorTail.Remove(0, errorTail.Length - 4000);
    }

    private string? ErrorTail()
    {
        lock (gate)
        {
            var text = errorTail.ToString().Trim();
            if (text.Length == 0) return null;
            var cut = text.LastIndexOf('\n');
            var last = cut >= 0 ? text[(cut + 1)..] : text;
            return last.Length > 200 ? last[..200] : last;
        }
    }

    private static string PacOrigin(Ports active) => $"https://127.0.0.1:{active.Relay}";

    private async Task StopOwnedAsync(OwnedProcess proc)
    {
        // Keep ownership on failure so the next poll can confirm the job has stopped.
        await proc.StopForUpdateAsync(requireCleanExit: false);
        lock (gate)
        {
            owned = null;
            proc.Dispose();
        }
    }

    public void Dispose()
    {
        lock (gate) disposed = true;
        OwnedProcess? stop;
        lock (gate) { stop = owned; owned = null; }
        if (stop is not null)
        {
            try { stop.StopAsync(TimeSpan.FromSeconds(1)).Wait(TimeSpan.FromSeconds(3)); }
            catch (Exception) { }
            stop.Dispose();
        }
        MemberCredentials.Collect();
        try { loop?.Wait(TimeSpan.FromSeconds(2)); } catch (Exception) { }
    }
}
