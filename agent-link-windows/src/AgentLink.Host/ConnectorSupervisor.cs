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
    private bool browserOpened;
    private int failures;
    private DateTimeOffset nextAttempt = DateTimeOffset.MinValue;
    private string? activePacOrigin;
    private DateTimeOffset startedAt;
    private Task? loop;
    private bool disposed;

    internal ConnectorSupervisor(string installRoot, string memberOrigin,
        Func<bool> enabled, Func<Ports?> ports,
        Func<CancellationToken, Task<bool>> ensureDescriptor, Action<Uri> openBrowser)
    {
        this.installRoot = installRoot;
        this.memberOrigin = memberOrigin;
        this.enabled = enabled;
        this.ports = ports;
        this.ensureDescriptor = ensureDescriptor;
        this.openBrowser = openBrowser;
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

    internal Task RunAsync(CancellationToken cancellation) =>
        loop = MonitorAsync(cancellation);

    internal void RequestLogin()
    {
        // A stored session only needs a plain restart; --link is for the
        // first approval or an explicit re-link after logout.
        var hasSession = MemberCredentials.HasSession();
        lock (gate)
        {
            wantLink = !hasSession;
            failures = 0;
            nextAttempt = DateTimeOffset.MinValue;
            if (phase == Phase.Failed) phase = Phase.Off;
            detail = null;
        }
        Kick();
    }

    internal void RequestCancel()
    {
        OwnedProcess? stop = null;
        lock (gate)
        {
            wantLink = false;
            if (phase == Phase.Linking)
            {
                linkActive = false;
                if (owned is not null) { stop = owned; owned = null; }
                phase = Phase.Off;
                userCode = null;
            }
        }
        if (stop is not null) _ = StopOwnedAsync(stop);
        Kick();
    }

    internal void RequestLogout()
    {
        OwnedProcess? stop = null;
        lock (gate)
        {
            wantLink = false;
            linkActive = false;
            stop = owned;
            owned = null;
            phase = Phase.Off;
            route = null;
            userCode = null;
            detail = null;
            failures = 0;
            nextAttempt = DateTimeOffset.MinValue;
        }
        MemberCredentials.Clear();
        if (stop is not null) _ = StopOwnedAsync(stop);
        Kick();
    }

    internal Snapshot GetSnapshot()
    {
        lock (gate)
        {
            var alive = owned is { Process.HasExited: false };
            return new(phase, detail, alive ? route : null, alive ? userCode : null, packagePresent);
        }
    }

    private async Task MonitorAsync(CancellationToken cancellation)
    {
        while (!cancellation.IsCancellationRequested)
        {
            try { await EvaluateAsync(cancellation); }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
            catch (Exception) { }
            var delay = Task.Delay(1500, cancellation);
            var kick = signal.WaitAsync(cancellation);
            await Task.WhenAny(delay, kick);
        }
    }

    private void Kick()
    {
        try { signal.Release(); } catch (SemaphoreFullException) { }
    }

    private async Task EvaluateAsync(CancellationToken cancellation)
    {
        lock (gate) { if (disposed) return; }
        var active = ports();
        var session = MemberCredentials.HasSession();
        var desired = packagePresent && active is not null && enabled() && (session || wantLink);

        OwnedProcess? stop = null;
        Ports? spawnPorts = null;
        var spawnLink = false;
        lock (gate)
        {
            if (!desired)
            {
                wantLink = false;
                linkActive = false;
                browserOpened = false;
                if (owned is not null) { stop = owned; owned = null; }
                if (phase != Phase.Off || route is not null || userCode is not null || detail is not null)
                {
                    phase = Phase.Off;
                    route = null;
                    userCode = null;
                    detail = null;
                }
                failures = 0;
                nextAttempt = DateTimeOffset.MinValue;
            }
            else
            {
                if (owned is { Process.HasExited: false })
                {
                    if (activePacOrigin != PacOrigin(active!))
                    {
                        // The gateway moved to different ports; the connector's
                        // pinned loopback target is stale — respawn it.
                        stop = owned;
                        owned = null;
                    }
                }
                else if (owned is not null)
                {
                    owned = null;
                    HandleExit();
                }
                if (owned is null && DateTimeOffset.UtcNow >= nextAttempt)
                {
                    spawnPorts = active;
                    spawnLink = wantLink;
                }
            }
        }
        if (stop is not null) await StopOwnedAsync(stop);
        if (spawnPorts is not null)
        {
            await SpawnAsync(spawnPorts, spawnLink, cancellation);
        }
        else
        {
            // No connector process and none starting: seal the credential
            // env file so member secrets only sit plaintext while a
            // connector session actually exists. The next spawn restores it.
            lock (gate) { if (owned is null) MemberCredentials.Collect(); }
        }
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
        MemberCredentials.EnsureMaterialized();
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

        OwnedProcess? proc;
        try { proc = new OwnedProcess(info, signalStart: false); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or Win32Exception
            or InvalidOperationException)
        {
            lock (gate)
            {
                failures++;
                phase = failures >= 5 ? Phase.Failed : Phase.Starting;
                detail = phase == Phase.Failed ? "会员连接组件无法启动" : null;
                var delay = failures switch { 1 => 1, 2 => 2, 3 => 5, 4 => 10, _ => 30 };
                nextAttempt = DateTimeOffset.UtcNow.AddSeconds(delay);
            }
            return;
        }

        lock (gate)
        {
            if (disposed) { proc.Dispose(); return; }
            owned = proc;
            activePacOrigin = PacOrigin(active);
            startedAt = DateTimeOffset.UtcNow;
            linkActive = link;
            browserOpened = false;
            errorTail.Clear();
            phase = link ? Phase.Linking : Phase.Starting;
            detail = null;
            userCode = null;
        }
        readers.Clear();
        readers.Add(ReadOutputAsync(proc.Process.StandardOutput, Path.Combine(logDir, "connector.out.log"), true));
        readers.Add(ReadOutputAsync(proc.Process.StandardError, Path.Combine(logDir, "connector.err.log"), false));
    }

    private async Task ReadOutputAsync(StreamReader reader, string logFile, bool stdout)
    {
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) is not null)
            {
                try { await File.AppendAllTextAsync(logFile, line + "\n"); } catch (Exception) { }
                if (stdout) HandleStdoutLine(line.Trim());
                else lock (gate) AppendError(line);
            }
        }
        catch (Exception) { }
    }

    private void HandleStdoutLine(string line)
    {
        if (RelayContract.TryParseRouteLine(line, out var parsed) && parsed is not null)
        {
            lock (gate)
            {
                route = parsed;
                phase = Phase.Ready;
                wantLink = false;
                linkActive = false;
                userCode = null;
                detail = null;
                failures = 0;
                nextAttempt = DateTimeOffset.MinValue;
            }
            return;
        }
        if (RelayContract.TryParseApprovalLine(line, out var uri, out var code)
            && uri is not null && Uri.TryCreate(uri, UriKind.Absolute, out var target))
        {
            var first = false;
            lock (gate)
            {
                first = !browserOpened;
                browserOpened = true;
                phase = Phase.Linking;
                userCode = code;
            }
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
        try { await proc.StopAsync(TimeSpan.FromSeconds(2)); } catch (Exception) { }
        proc.Dispose();
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
