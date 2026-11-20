using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--bridge", var pipe, var capability])
            return WindowsTaskFiles.RunMcpAsync(pipe, capability).GetAwaiter().GetResult();
        if (args is ["--probe-update" or "--probe-seed", var operationId])
        {
            try { return WindowsGatewayProbe.RunAsync(operationId, seed: args[0] == "--probe-seed").GetAwaiter().GetResult() ? 0 : 1; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException
                or System.Security.Cryptography.CryptographicException or JsonException or Win32Exception
                or HttpRequestException or OperationCanceledException or InvalidOperationException) { return 1; }
        }
        if (args is ["--status"] or ["--stop"])
        {
            try
            {
                var reply = LinkProtocol.CallAsync(new(args[0] == "--status" ? "status" : "exit"))
                    .GetAwaiter().GetResult();
                return reply.Ok ? 0 : 1;
            }
            catch (TimeoutException) { return 2; }
            catch (IOException) { return 2; }
        }
        using var singleton = new Mutex(false, LinkProtocol.HostLock);
        try { if (!singleton.WaitOne(0)) return 0; }
        catch (AbandonedMutexException) { }
        try
        {
            if (LinkUpdateTransition.IsHeld()) return 0;
            using var host = new LinkHost();
            host.RunAsync().GetAwaiter().GetResult();
            return 0;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException
            or InvalidDataException or System.Security.Cryptography.CryptographicException
            or JsonException or Win32Exception)
        {
            return 1;
        }
        finally { singleton.ReleaseMutex(); }
    }
}

internal sealed class LinkHost : IDisposable
{
    private const string OwnerRoot = "/api/v2/personal-access/";
    private static string InstallRoot => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
    private static string MemberOrigin =>
        Environment.GetEnvironmentVariable("AGENT_LINK_MEMBER_ORIGIN") is { Length: > 0 } configured
            && configured.StartsWith("https://", StringComparison.Ordinal)
            ? configured : "https://api.steercrew.com";
    private readonly CancellationTokenSource stop = new();
    private readonly HttpClient owner = new(new SocketsHttpHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(2),
    }) { Timeout = TimeSpan.FromSeconds(5) };
    private readonly string computer = Environment.MachineName;
    private readonly SemaphoreSlim mutations = new(1, 1);
    private readonly UpdateActivity updateActivity = new();
    private volatile PreparedUpdate? preparedUpdate;
    private bool gatewayStoppedForUpdate;
    private volatile LinkStatus status;
    private LinkIdentity? identity;
    private volatile bool enabled;
    private volatile bool pairingApproval;
    private volatile Ports? ports;
    private string WorkerPathFile => Path.Combine(LinkProtocol.Root, "worker-card.path");
    private string AttachedFile => Path.Combine(LinkProtocol.Root, "worker-cards.json");
    private readonly Dictionary<string, WorkerCard> registered = new(StringComparer.Ordinal);
    private readonly ManagedAgents managed;
    private readonly ConnectorSupervisor connector;
    private readonly WindowsLinkFiles fileService;
    private readonly WindowsTaskFiles taskFiles;
    private string? descriptorCertificatePem;

    internal LinkHost()
    {
        managed = new ManagedAgents(InstallRoot, OwnerAsync);
        connector = new ConnectorSupervisor(InstallRoot, MemberOrigin,
            enabled: () => enabled, ports: () => ports,
            ensureDescriptor: EnsureDescriptorAsync, openBrowser: OpenMemberPage, updateActivity: updateActivity);
        fileService = new WindowsLinkFiles(InstallRoot, MemberOrigin, updateActivity);
        taskFiles = new WindowsTaskFiles(fileService, updateActivity);
        status = NewStatus("正在启动");
    }

    private LinkStatus NewStatus(string message) => new(false, message, computer, null, 0, 0, null, null, null, enabled,
        MemberStateName(connector.GetSnapshot().Phase), null, PairingApprovalRequired: pairingApproval);

    internal async Task RunAsync()
    {
        var local = ServeAsync(stop.Token);
        var relay = connector.RunAsync(stop.Token);
        var files = fileService.RunAsync(stop.Token);
        var taskFileBroker = fileService.Installed ? taskFiles.RunAsync(stop.Token) : Task.CompletedTask;
        try
        {
            try
            {
                identity = LinkIdentity.Load();
                enabled = !File.Exists(Path.Combine(LinkProtocol.Root, "disabled"));
                pairingApproval = File.Exists(Path.Combine(LinkProtocol.Root, "pairing-approval"));
                await SuperviseAsync(stop.Token);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException
                or InvalidDataException or System.Security.Cryptography.CryptographicException or JsonException)
            {
                status = NewStatus("无法读取本机状态");
                await local;
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        finally
        {
            stop.Cancel();
            await local;
            await relay;
            await files;
            try
            {
                await taskFileBroker;
                if (preparedUpdate is { } update && gatewayStoppedForUpdate &&
                    LinkUpdateTransition.Matches(update.Receipt.OperationId))
                {
                    await Task.WhenAll(managed.StopForUpdateAsync(), connector.StopForUpdateAsync());
                    if (LinkUpdateTransition.Matches(update.Receipt.OperationId))
                        LinkIdentity.SaveAtomic(LinkUpdateTransition.StoppedReceipt,
                            JsonSerializer.SerializeToUtf8Bytes(update.Receipt, LinkProtocol.Json));
                }
            }
            catch (OperationCanceledException error)
            {
                throw new IOException("Windows update could not confirm process shutdown.", error);
            }
            finally
            {
                connector.Dispose();
                preparedUpdate?.Activity.Dispose();
            }
        }
    }

    private async Task SuperviseAsync(CancellationToken cancellation)
    {
        var delay = 1;
        while (!cancellation.IsCancellationRequested)
        {
            var started = Stopwatch.GetTimestamp();
            try { await RunGatewayAsync(cancellation); }
            catch (Exception error) when (error is IOException or Win32Exception or InvalidOperationException
                or HttpRequestException or TimeoutException or JsonException
                || error is OperationCanceledException && !cancellation.IsCancellationRequested)
            {
                status = NewStatus("后台需要处理（" + error.GetType().Name + "）");
            }
            if (Stopwatch.GetElapsedTime(started) >= TimeSpan.FromMinutes(1)) delay = 1;
            await Task.Delay(TimeSpan.FromSeconds(delay), cancellation);
            delay = Math.Min(delay * 2, 30);
        }
    }

    private async Task RunGatewayAsync(CancellationToken cancellation)
    {
        var data = Path.Combine(LinkProtocol.Root, "gateway");
        Directory.CreateDirectory(data);
        var portsFile = Path.Combine(LinkProtocol.Root, "ports.json");
        var persistPorts = !File.Exists(portsFile);
        var chosen = persistPorts ? AllocatePorts() :
            JsonSerializer.Deserialize<Ports>(File.ReadAllBytes(portsFile), LinkProtocol.Json)
                ?? throw new InvalidDataException("Missing saved ports.");
        // Installs from before the relay listener have no saved Relay port;
        // allocate one rather than reusing a port another product may own.
        if (chosen.Relay is < 1024 or > 65535 || chosen.Relay == chosen.Phone || chosen.Relay == chosen.Owner)
        {
            chosen = chosen with { Relay = FreeLoopbackPort() };
            persistPorts = true;
        }
        if (chosen.Phone is < 1024 or > 65535 || chosen.Owner is < 1024 or > 65535 || chosen.Phone == chosen.Owner)
            throw new InvalidDataException("Invalid saved ports.");
        // A persisted port is only trustworthy while it still binds — Windows
        // port-exclusion ranges and port thieves would otherwise wedge every
        // restart. Re-pick all three at once rather than half-patching (same
        // rule the Mac service uses on gateway respawn).
        if (!persistPorts && !(PortFree(chosen.Phone) && PortFree(chosen.Owner) && PortFree(chosen.Relay)))
        {
            chosen = AllocatePorts();
            persistPorts = true;
        }

        var launch = ProcessInfo(Path.Combine(InstallRoot, "runtime", "gateway-node.exe"), data);
        launch.ArgumentList.Add("--import");
        launch.ArgumentList.Add(new Uri(Path.Combine(InstallRoot, "runtime", "await-parent.mjs")).AbsoluteUri);
        launch.ArgumentList.Add(Path.Combine(InstallRoot, "components", "gateway", "device-gateway.mjs"));
        using var certificate = identity!.Certificate();
        using var key = certificate.GetRSAPrivateKey() ?? throw new InvalidDataException("Missing TLS private key.");
        var origin = $"https://{computer}.local:{chosen.Phone}";
        var variables = launch.Environment;
        if (fileService.Installed && Environment.ProcessPath is { } hostExecutable)
        {
            variables["SAGE_LINK_FILE_SOCKET"] = taskFiles.PipePath;
            variables["SAGE_LINK_FILE_GATEWAY_KEY"] = taskFiles.GatewayKey;
            variables["SAGE_LINK_FILE_MCP"] = hostExecutable;
        }
        var acsUrl = Environment.GetEnvironmentVariable("DEVICE_GATEWAY_ACS_URL");
        if (string.IsNullOrWhiteSpace(acsUrl))
        {
            variables["DEVICE_GATEWAY_PROFILE"] = "LOCAL_CLI";
        }
        else
        {
            var acsToken = Environment.GetEnvironmentVariable("ACS_TOKEN");
            if (string.IsNullOrWhiteSpace(acsToken))
                throw new InvalidOperationException("Configured ACS requires ACS_TOKEN.");
            variables["DEVICE_GATEWAY_ACS_URL"] = acsUrl;
            variables["DEVICE_GATEWAY_ACS_HANDOFF_BRIDGE"] = "1";
            variables["DEVICE_GATEWAY_ACS_OWNER_TOKEN"] = acsToken;
            if (Environment.GetEnvironmentVariable("DEVICE_GATEWAY_DAILY_ORIGIN") is { } dailyOrigin)
                variables["DEVICE_GATEWAY_DAILY_ORIGIN"] = dailyOrigin;
        }
        variables["DEVICE_GATEWAY_DATA_DIR"] = data;
        variables["DEVICE_GATEWAY_WINDOWS_CLOUD_ORIGIN"] = MemberOrigin.TrimEnd('/');
        variables["DEVICE_GATEWAY_WINDOWS_CLOUD_SESSION"] = MemberCredentials.EnvFilePath;
        variables["DEVICE_GATEWAY_BIND"] = "::";
        variables["DEVICE_GATEWAY_PORT"] = chosen.Phone.ToString();
        variables["DEVICE_GATEWAY_OWNER_PORT"] = chosen.Owner.ToString();
        variables["DEVICE_GATEWAY_RELAY_PORT"] = chosen.Relay.ToString();
        variables["DEVICE_GATEWAY_ORIGIN"] = origin;
        variables["DEVICE_GATEWAY_DISPLAY_NAME"] = computer;
        variables["DEVICE_GATEWAY_MDNS_NAME"] = computer;
        variables["DEVICE_GATEWAY_OWNER_TOKEN"] = identity.OwnerToken;
        variables["DEVICE_GATEWAY_OWNER_CLIENT_TOKEN"] = identity.ClientToken;
        variables["DEVICE_GATEWAY_STORE_KEY"] = identity.StoreKey;
        variables["DEVICE_GATEWAY_TLS_KEY"] = key.ExportPkcs8PrivateKeyPem();
        variables["DEVICE_GATEWAY_TLS_CERT"] = certificate.ExportCertificatePem();
        variables["DEVICE_GATEWAY_STOP_ON_STDIN_END"] = "1";
        variables["DEVICE_GATEWAY_PHONE_START_DISABLED"] = enabled ? "0" : "1";
        // Discovery pairing: default auto-approve; marker file opts the owner
        // into manual approval. Invite/QR pairing always approves — scanning
        // the QR is the approval.
        variables["DEVICE_GATEWAY_PAIRING_AUTO_APPROVE"] = pairingApproval ? "0" : "1";
        using var gateway = new OwnedProcess(launch);
        var stderr = DrainAsync(gateway.Process.StandardError);
        Task? stdout = null;
        try
        {
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            startup.CancelAfter(TimeSpan.FromSeconds(12));
            await WaitForListenerAsync(gateway.Process.StandardOutput, chosen, startup.Token);
            stdout = DrainAsync(gateway.Process.StandardOutput);
            ports = chosen;
            registered.Clear();
            managed.GatewayRestarted();
            await mutations.WaitAsync(cancellation);
            try
            {
                // The owner listener binds seconds after the announce line —
                // retry instead of treating the first refusal as fatal.
                for (var attempt = 0; ; attempt++)
                {
                    try { await RefreshAsync(gateway.Process.Id, cancellation); break; }
                    catch (Exception error) when ((error is HttpRequestException or IOException) && attempt < 30)
                    {
                        await Task.Delay(500, cancellation);
                    }
                }
                if (persistPorts) LinkIdentity.SaveAtomic(portsFile, JsonSerializer.SerializeToUtf8Bytes(chosen, LinkProtocol.Json));
            }
            finally { mutations.Release(); }
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
            var exited = gateway.Process.WaitForExitAsync(cancellation);
            var refreshFailures = 0;
            while (!exited.IsCompleted)
            {
                var tick = timer.WaitForNextTickAsync(cancellation).AsTask();
                if (await Task.WhenAny(tick, exited) == exited) break;
                await tick;
                await mutations.WaitAsync(cancellation);
                try
                {
                    if (!updateActivity.Held) await RefreshAsync(gateway.Process.Id, cancellation);
                    refreshFailures = 0;
                }
                // A transient owner-API failure must not kill a live gateway;
                // only surface it after ~30s of consecutive failures.
                catch (Exception error) when (error is HttpRequestException or IOException)
                {
                    if (++refreshFailures >= 10)
                        status = NewStatus("后台刷新失败（" + error.GetType().Name + "）");
                }
                finally { mutations.Release(); }
            }
            await exited;
            managed.GatewayStopped();
            status = NewStatus($"后台网关已退出（{gateway.Process.ExitCode}），正在恢复");
        }
        finally
        {
            ports = null;
            if (preparedUpdate?.Receipt.GatewayPid == gateway.Process.Id && stop.IsCancellationRequested)
            {
                await gateway.StopForUpdateAsync(requireCleanExit: true);
                gatewayStoppedForUpdate = true;
            }
            else await gateway.StopAsync();
            await stderr;
            if (stdout is not null) await stdout;
        }
    }

    private static async Task WaitForListenerAsync(StreamReader output, Ports chosen, CancellationToken cancellation)
    {
        while (await output.ReadLineAsync(cancellation) is { } line)
        {
            if (!line.StartsWith('{')) continue;
            var item = JsonNode.Parse(line);
            if (item?["listener"]?.GetValue<string>() == "device-gateway" &&
                item?["port"]?.GetValue<int>() == chosen.Phone &&
                item?["owner"]?["port"]?.GetValue<int>() == chosen.Owner &&
                item?["relay"]?["port"]?.GetValue<int>() == chosen.Relay) return;
        }
        throw new IOException("Gateway exited before opening its listeners.");
    }

    private static async Task DrainAsync(StreamReader reader)
    {
        var buffer = new char[4096];
        while (await reader.ReadAsync(buffer) != 0) { }
    }

    internal static ProcessStartInfo ProcessInfo(string file, string work)
    {
        var info = new ProcessStartInfo(file)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = work,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        info.Environment.Clear();
        string[] allowed = ["SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA",
            "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)"];
        foreach (var name in allowed)
            if (Environment.GetEnvironmentVariable(name) is { } value) info.Environment[name] = value;
        return info;
    }

    internal static Ports AllocatePorts()
    {
        for (var attempt = 0; ; attempt++)
        {
            using var phone = new TcpListener(IPAddress.IPv6Any, 0);
            using var owner = new TcpListener(IPAddress.Loopback, 0);
            using var relay = new TcpListener(IPAddress.Loopback, 0);
            phone.Server.DualMode = true;
            phone.Start();
            owner.Start();
            relay.Start();
            var chosen = new Ports(((IPEndPoint)phone.LocalEndpoint).Port,
                ((IPEndPoint)owner.LocalEndpoint).Port, ((IPEndPoint)relay.LocalEndpoint).Port);
            if (attempt == 2 || chosen.Phone != chosen.Owner && chosen.Phone != chosen.Relay
                && chosen.Owner != chosen.Relay) return chosen;
        }
    }

    private static bool PortFree(int port)
    {
        try
        {
            var v6 = new TcpListener(IPAddress.IPv6Any, port);
            v6.Start();
            v6.Stop();
            var v4 = new TcpListener(IPAddress.Loopback, port);
            v4.Start();
            v4.Stop();
            return true;
        }
        catch (SocketException) { return false; }
    }

    private static int FreeLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static string? LanAddress()
    {
        var candidates = NetworkInterface.GetAllNetworkInterfaces()
            .Where(nic => nic.OperationalStatus == OperationalStatus.Up &&
                nic.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211);
        foreach (var nic in candidates)
        {
            var ip = nic.GetIPProperties();
            if (!ip.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork)) continue;
            foreach (var item in ip.UnicastAddresses)
            {
                var bytes = item.Address.GetAddressBytes();
                if (bytes.Length == 4 && bytes[0] != 127 && !(bytes[0] == 169 && bytes[1] == 254) &&
                    !(bytes[0] == 198 && bytes[1] is 18 or 19)) return item.Address.ToString();
            }
        }
        return null;
    }

    private async Task<JsonNode?> OwnerAsync(HttpMethod method, string route, object? body, CancellationToken cancellation)
    {
        var active = ports ?? throw new IOException("Gateway is unavailable.");
        using var req = new HttpRequestMessage(method, $"http://127.0.0.1:{active.Owner}{OwnerRoot}{route}");
        req.Headers.Authorization = new("Bearer", identity!.OwnerToken);
        req.Headers.Add("X-Client-Session", identity.ClientToken);
        if (body is not null) req.Content = System.Net.Http.Json.JsonContent.Create(body);
        using var response = await owner.SendAsync(req, cancellation);
        var text = await response.Content.ReadAsStringAsync(cancellation);
        var node = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException(node?["code"]?.GetValue<string>() ?? $"HTTP {(int)response.StatusCode}");
        return node;
    }

    private async Task<JsonNode?> FetchCapabilitiesAsync(CancellationToken cancellation)
    {
        try { return await OwnerAsync(HttpMethod.Get, "capabilities", null, cancellation); }
        catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException
            && !cancellation.IsCancellationRequested) { return null; }
    }

    /// Writes the connector's public five-field PAC trust descriptor. Only
    /// rewritten when the advertised identity actually changes.
    private async Task<bool> EnsureDescriptorAsync(CancellationToken cancellation)
    {
        var cap = await FetchCapabilitiesAsync(cancellation);
        if (cap is not JsonObject fields) return false;
        string? Text(string key) => fields[key] is JsonValue value
            && value.TryGetValue<string>(out var text) && text.Length > 0 ? text : null;
        var hostId = Text("personalHostId");
        var storeId = Text("storeId");
        var certificateSha256 = Text("certificateSha256");
        var origin = Text("origin");
        if (hostId is null || storeId is null || certificateSha256 is null || origin is null) return false;
        var pem = descriptorCertificatePem ??= identity!.Certificate().ExportCertificatePem();
        var body = JsonSerializer.SerializeToUtf8Bytes(new JsonObject
        {
            ["personalHostId"] = hostId,
            ["storeId"] = storeId,
            ["certificateSha256"] = certificateSha256,
            ["certificatePem"] = pem,
            ["origin"] = origin,
        }, LinkProtocol.Json);
        var file = Path.Combine(LinkProtocol.Root, "connector", "public-pac-descriptor.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var current = File.Exists(file) ? await File.ReadAllBytesAsync(file, cancellation) : null;
        if (current is null || !current.AsSpan().SequenceEqual(body))
            LinkIdentity.SaveAtomic(file, body);
        return true;
    }

    private static void OpenMemberPage(Uri uri)
    {
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception) { }
    }

    private async Task RefreshAsync(int gatewayPid, CancellationToken cancellation)
    {
        await RefreshWorkerAsync(cancellation);
        await managed.ReconcileAsync(cancellation);
        var cap = await OwnerAsync(HttpMethod.Get, "capabilities", null, cancellation);
        var devices = await OwnerAsync(HttpMethod.Get, "devices", null, cancellation) as JsonArray;
        var scopesSynced = true;
        if (enabled)
        {
            foreach (var (deviceId, body) in DeviceScopeSync.Changes(cap?["localSource"], devices))
            {
                try
                {
                    await OwnerAsync(HttpMethod.Put, $"devices/{Uri.EscapeDataString(deviceId)}/scope", body, cancellation);
                }
                catch (HttpRequestException)
                {
                    // Re-read the catalog and grant revision on the next refresh.
                    scopesSynced = false;
                }
            }
        }
        var requests = await OwnerAsync(HttpMethod.Get, "pairing-requests", null, cancellation) as JsonArray;
        var member = connector.GetSnapshot();
        var message = !enabled ? "手机连接已关闭" : scopesSynced ? "后台已就绪" : "手机授权同步暂未完成";
        status = new(true, message, computer,
            LanAddress() is { } ip ? $"https://{ip}:{ports!.Phone}" : cap?["origin"]?.GetValue<string>(),
            devices?.Count(d => d?["state"]?.GetValue<string>() == "ACTIVE") ?? 0,
            requests?.Count(d => d?["state"]?.GetValue<string>() == "PENDING") ?? 0,
            cap?["personalHostId"]?.GetValue<string>(), cap?["storeId"]?.GetValue<string>(), gatewayPid, enabled,
            MemberStateName(member.Phase), member.UserCode ?? member.Detail
                ?? (!member.PackagePresent ? "此安装不包含会员连接组件" : null),
            cap?["dailyOrigin"]?.GetValue<string>(), pairingApproval,
            cap?["acsSessionCreate"]?.GetValue<bool>() == true);
    }

    private static string MemberStateName(ConnectorSupervisor.Phase phase) => phase switch
    {
        ConnectorSupervisor.Phase.Linking => "LINKING",
        ConnectorSupervisor.Phase.Ready => "LINKED",
        ConnectorSupervisor.Phase.Failed => "ERROR",
        ConnectorSupervisor.Phase.Starting => "CONNECTING",
        _ => "NONE",
    };

    private static async Task<WorkerCard> LoadWorkerAsync(string path, CancellationToken cancellation)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\") || path.Length > 1024)
            throw new IOException("Expected a local worker card.");
        using var stream = File.OpenRead(path);
        if (stream.Length > 8192) throw new IOException("Worker card exceeds size limit.");
        var card = await JsonSerializer.DeserializeAsync<WorkerCard>(stream, LinkProtocol.Json, cancellation);
        if (card is null || card.ConnectionId is not { Length: > 0 and < 129 } ||
            card.ConnectionId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.') ||
            card.Token is not { Length: >= 24 and <= 1024 } ||
            !Uri.TryCreate(card.Url, UriKind.Absolute, out var address) || address.Scheme != "http" ||
            address.Host != "127.0.0.1" || address.AbsolutePath != "/" ||
            address.UserInfo.Length + address.Query.Length + address.Fragment.Length != 0)
            throw new IOException("Invalid loopback worker card.");
        return card;
    }

    private async Task<(bool Ok, string? Detail)> ProbeWorkerAsync(WorkerCard card, CancellationToken cancellation)
    {
        try
        {
            using var probe = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(card.Url), "/local/v1/identity"));
            probe.Headers.Authorization = new("Bearer", card.Token);
            using var response = await owner.SendAsync(probe, cancellation);
            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadAsStringAsync(cancellation);
            return (true, body.Length > 512 ? body[..512] : body);
        }
        catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException
            && !cancellation.IsCancellationRequested)
        {
            return (false, "引擎不可达：" + error.Message);
        }
    }

    /// Attached worker-card paths — `worker-cards.json` holds the set; the
    /// legacy single-slot `worker-card.path` is read once as a migration seed.
    private HashSet<string> LoadAttachedPaths()
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (File.Exists(AttachedFile))
            {
                foreach (var path in JsonSerializer.Deserialize<string[]>(
                    File.ReadAllBytes(AttachedFile), LinkProtocol.Json) ?? [])
                    if (path is { Length: > 0 }) set.Add(path);
            }
            else if (File.Exists(WorkerPathFile))
            {
                var path = File.ReadAllText(WorkerPathFile).Trim();
                if (path.Length > 0) set.Add(path);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
        return set;
    }

    private void SaveAttachedPaths(HashSet<string> set)
    {
        LinkIdentity.SaveAtomic(AttachedFile,
            JsonSerializer.SerializeToUtf8Bytes(set.Order(StringComparer.Ordinal).ToArray(), LinkProtocol.Json));
        if (File.Exists(WorkerPathFile)) File.Delete(WorkerPathFile);
    }

    /// The owner's attached set is the desired state; `registered` mirrors the
    /// gateway. Dead workers lose their registration but keep the intent — a
    /// returning worker rejoins without a second tray toggle. A card whose
    /// file vanished withdrew consent, so its intent drops with it.
    private async Task SyncWorkersAsync(CancellationToken cancellation)
    {
        var attached = LoadAttachedPaths();
        var wanted = new Dictionary<string, WorkerCard>(StringComparer.Ordinal);
        var stale = new List<string>();
        foreach (var path in attached)
        {
            try { var card = await LoadWorkerAsync(path, cancellation); wanted[card.ConnectionId] = card; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException
                || error is OperationCanceledException && !cancellation.IsCancellationRequested)
            {
                if (!File.Exists(path)) stale.Add(path);
            }
        }
        if (stale.Count > 0) { attached.ExceptWith(stale); SaveAttachedPaths(attached); }
        foreach (var id in registered.Keys.Where(id => !wanted.ContainsKey(id)).ToArray())
        {
            try { await OwnerAsync(HttpMethod.Delete, "worker-registrations/" + id, null, cancellation); }
            catch (HttpRequestException) { }
            registered.Remove(id);
        }
        foreach (var (id, card) in wanted)
        {
            if (registered.TryGetValue(id, out var cur) && cur.Url == card.Url && cur.Token == card.Token) continue;
            var (ok, _) = await ProbeWorkerAsync(card, cancellation);
            if (!ok)
            {
                if (registered.Remove(id))
                    try { await OwnerAsync(HttpMethod.Delete, "worker-registrations/" + id, null, cancellation); }
                    catch (HttpRequestException) { }
                continue;
            }
            var body = new { card.ConnectionId, card.Url, card.Token, displayName = card.DisplayName ?? card.ConnectionId };
            try { await OwnerAsync(HttpMethod.Post, "worker-registrations", body, cancellation); }
            catch (HttpRequestException)
            {
                // The gateway may already hold a row for this connection
                // (replay after respawn) — refresh it rather than failing.
                try { await OwnerAsync(HttpMethod.Delete, "worker-registrations/" + id, null, cancellation); }
                catch (HttpRequestException) { }
                await OwnerAsync(HttpMethod.Post, "worker-registrations", body, cancellation);
            }
            registered[id] = card;
        }
    }

    private async Task RefreshWorkerAsync(CancellationToken cancellation)
    {
        try { await SyncWorkersAsync(cancellation); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or HttpRequestException
            || error is OperationCanceledException && !cancellation.IsCancellationRequested) { }
    }

    private async Task ServeAsync(CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                await using var channel = new NamedPipeServerStream(LinkProtocol.Pipe, PipeDirection.InOut,
                    1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await channel.WaitForConnectionAsync(cancellation);
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                deadline.CancelAfter(TimeSpan.FromSeconds(8));
                var updateAcknowledged = false;
                try
                {
                    var request = await LinkProtocol.ReadAsync<LinkRequest>(channel, deadline.Token);
                    LinkReply reply;
                    try { reply = await HandleAsync(request, deadline.Token); }
                    catch (HttpRequestException error) { reply = new(false, error.Message); }
                    catch (IOException error) { reply = new(false, error.Message); }
                    catch (UnauthorizedAccessException) { reply = new(false, "无法访问本机配置"); }
                    catch (Exception unexpected)
                    {
                        try { File.AppendAllText(Path.Combine(LinkProtocol.Root, "pipe-errors.log"),
                            DateTimeOffset.Now + " " + request.Operation + " " + unexpected + "\n"); } catch { }
                        reply = new(false, "内部错误：" + unexpected.GetType().Name);
                    }
                    await LinkProtocol.WriteAsync(channel, reply, deadline.Token);
                    updateAcknowledged = request.Operation == "prepare-update" && reply.Ok;
                    if (reply.Ok && (request.Operation == "exit" || updateAcknowledged)) stop.Cancel();
                }
                catch (Exception error) when (error is IOException or OperationCanceledException or JsonException) { }
                finally
                {
                    if (!updateAcknowledged && preparedUpdate is { } abandoned)
                    {
                        try { await ReleaseUpdateAsync(abandoned.Receipt.OperationId, abandoned.Ports); }
                        finally
                        {
                            preparedUpdate = null;
                            abandoned.Activity.Dispose();
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private async Task<LinkReply> HandleAsync(LinkRequest request, CancellationToken cancellation)
    {
        if (request.Operation == "status") return new(true, Data: JsonSerializer.SerializeToNode(status, LinkProtocol.Json));
        if (request.Operation == "localUsage")
        {
            var days = request.Id == "7" ? 7 : 1;
            return new(true, Data: JsonSerializer.SerializeToNode(CcSwitch.ReadUsage(DateTimeOffset.UtcNow, days), LinkProtocol.Json));
        }
        if (request.Operation == "exit") return new(true);
        await mutations.WaitAsync(cancellation);
        try
        {
            if (request.Operation == "managedAgents")
                return new(true, Data: JsonSerializer.SerializeToNode(managed.List(), LinkProtocol.Json));
            if (!status.Ready || ports is null) return new(false, "后台网关暂未就绪");
            if (request.Operation == "prepare-update") return await PrepareUpdateAsync(request.Id, cancellation);
            switch (request.Operation)
            {
                case "handoffSigningKey":
                    return new(true, Data: await OwnerAsync(HttpMethod.Get, "work-handoffs/signing-key", null, cancellation));
                case "handoffPeers":
                    return new(true, Data: await OwnerAsync(HttpMethod.Get, "work-handoffs/trusted-peer-keys", null, cancellation));
                case "setHandoffPeer" when request.Args is JsonObject peer:
                    return new(true, Data: await OwnerAsync(HttpMethod.Put, "work-handoffs/trusted-peer-keys", peer, cancellation));
                case "handoffRecoveries":
                    return new(true, Data: await OwnerAsync(HttpMethod.Get, "work-handoffs/recovery-grants", null, cancellation));
                case "setHandoffRecovery" when request.Args is JsonObject recovery:
                    return new(true, Data: await OwnerAsync(HttpMethod.Put, "work-handoffs/recovery-grants", recovery, cancellation));
                case "cloudLaunch" or "setCloudLaunch":
                    try
                    {
                        var reading = request.Operation == "cloudLaunch";
                        if (!reading && request.Args is not JsonObject) return new(false, "授权参数无效");
                        return new(true, Data: await OwnerAsync(reading ? HttpMethod.Get : HttpMethod.Put,
                            "cloud-launch-grant", reading ? null : request.Args, cancellation));
                    }
                    catch (HttpRequestException error)
                    {
                        return new(false, error.Message switch
                        {
                            "CLOUD_SESSION_REQUIRED" => "请先连接会员账号。若已连接，请重新登录会员。",
                            "CLOUD_SESSION_CHANGED" => "会员账号已切换，请重新打开授权窗口。",
                            "CLOUD_GRANT_CHANGED" => "云任务授权已变化，请重新打开授权窗口。",
                            "CLOUD_TARGET_UNAVAILABLE" => "所选目标已变化，请重新打开授权窗口。",
                            "CLOUD_GRANT_INVALID" => "授权参数无效",
                            _ => "暂时无法核对云任务授权，请重试。",
                        });
                    }
                case "agents":
                    var cap = await OwnerAsync(HttpMethod.Get, "capabilities", null, cancellation);
                    return new(true, Data: cap?["localSource"]?.DeepClone());
                case "worker" when request.Id is { } path:
                    var card = await LoadWorkerAsync(path, cancellation);
                    var (okAttach, attachDetail) = await ProbeWorkerAsync(card, cancellation);
                    if (!okAttach) return new(false, attachDetail);
                    var attached = LoadAttachedPaths();
                    attached.Add(Path.GetFullPath(path));
                    SaveAttachedPaths(attached);
                    await SyncWorkersAsync(cancellation);
                    return new(true);
                case "detachWorker":
                    var remaining = LoadAttachedPaths();
                    if (request.Id is { } detachPath)
                    {
                        var full = Path.GetFullPath(detachPath);
                        remaining.RemoveWhere(p => string.Equals(p, full, StringComparison.OrdinalIgnoreCase));
                    }
                    else remaining.Clear();
                    SaveAttachedPaths(remaining);
                    await SyncWorkersAsync(cancellation);
                    return new(true);
                case "testWorker" when request.Id is { } testPath:
                    var tested = await LoadWorkerAsync(testPath, cancellation);
                    var (ok, detail) = await ProbeWorkerAsync(tested, cancellation);
                    return ok ? new(true, Data: JsonValue.Create(detail)) : new(false, detail);
                case "agentAdd" when request.Args is { } addArgs:
                    managed.Add(
                        addArgs["engine"]?.GetValue<string>() is { Length: > 0 } engine ? engine
                            : throw new IOException("缺少引擎"),
                        addArgs["executable"]?.GetValue<string>(),
                        addArgs["project"]?.GetValue<string>() is { Length: > 0 } project ? project
                            : throw new IOException("缺少工作区目录"),
                        addArgs["model"]?.GetValue<string>(),
                        addArgs["skipPermissions"]?.GetValue<bool>() ?? true,
                        addArgs["enabled"]?.GetValue<bool>() ?? true);
                    // Spawn happens on the next refresh tick — a 12s startup probe
                    // would outlast this pipe's 8s deadline; the entry shows 启动中.
                    return new(true, Data: JsonSerializer.SerializeToNode(managed.List(), LinkProtocol.Json));
                case "agentSet" when request.Id is { } setKey && request.Args is { } setArgs:
                    await managed.UpdateAsync(setKey, setArgs, cancellation);
                    return new(true, Data: JsonSerializer.SerializeToNode(managed.List(), LinkProtocol.Json));
                case "agentRemove" when request.Id is { } removeKey:
                    await managed.RemoveAsync(removeKey, cancellation);
                    return new(true, Data: JsonSerializer.SerializeToNode(managed.List(), LinkProtocol.Json));
                case "agentTest" when request.Id is { } testKey:
                    var (okAgent, agentDetail) = await managed.TestAsync(testKey);
                    return okAgent ? new(true, Data: JsonValue.Create(agentDetail)) : new(false, agentDetail);
                case "agentHistory" when request.Args is { } histArgs:
                    return new(true, Data: await managed.HistoryListAsync(
                        histArgs["engine"]?.GetValue<string>() ?? "", cancellation));
                case "agentAdopt" when request.Id is { } adoptKey && request.Args is { } adoptArgs:
                    return new(true, Data: await managed.AdoptAsync(adoptKey,
                        adoptArgs["file"]?.GetValue<string>(),
                        adoptArgs["title"]?.GetValue<string>(), cancellation));
                case "agentHistoryRead" when request.Args is { } histArgs:
                    return new(true, Data: await managed.HistoryReadAsync(
                        histArgs["engine"]?.GetValue<string>() ?? "",
                        histArgs["file"]?.GetValue<string>(), cancellation));
                case "devices":
                    return new(true, Data: await OwnerAsync(HttpMethod.Get, "devices", null, cancellation));
                case "requests":
                    return new(true, Data: await OwnerAsync(HttpMethod.Get, "pairing-requests", null, cancellation));
                case "approve" or "reject":
                    if (request.Id is not { Length: > 0 and < 129 } id ||
                        id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.'))
                        return new(false, "配对请求无效");
                    await OwnerAsync(HttpMethod.Post, $"pairing-requests/{id}/decisions",
                        new { approve = request.Operation == "approve" }, cancellation);
                    return new(true);
                case "revokeDevice" when request.Id is { Length: > 0 and < 129 } deviceId &&
                    deviceId.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'):
                    await OwnerAsync(HttpMethod.Delete,
                        "devices/" + Uri.EscapeDataString(deviceId), null, cancellation);
                    return new(true);
                case "pairingApproval":
                    // Discovery-pairing approval toggle only — invite/QR
                    // pairing always auto-approves and never reads this.
                    var required = request.Args?["required"]?.GetValue<bool>() == true;
                    var approvalMarker = Path.Combine(LinkProtocol.Root, "pairing-approval");
                    if (required) LinkIdentity.SaveAtomic(approvalMarker, []);
                    await OwnerAsync(HttpMethod.Post, "pairing-approval", new { required }, cancellation);
                    if (!required) File.Delete(approvalMarker);
                    pairingApproval = required;
                    status = status with { PairingApprovalRequired = required };
                    return new(true);
                case "enable" or "disable":
                    var on = request.Operation == "enable";
                    var marker = Path.Combine(LinkProtocol.Root, "disabled");
                    if (!on) LinkIdentity.SaveAtomic(marker, []);
                    await OwnerAsync(HttpMethod.Post, "link-state", new { enabled = on }, cancellation);
                    if (on) File.Delete(marker);
                    enabled = on;
                    status = status with { Enabled = enabled, Message = enabled ? "后台已就绪" : "手机连接已关闭" };
                    return new(true);
                case "invite" when enabled:
                    // Same contract as Agent Link Mac: explicit availability-
                    // filtered launch scopes, LAUNCH iff the set is non-empty.
                    var inviteCap = await OwnerAsync(HttpMethod.Get, "capabilities", null, cancellation);
                    var scopes = LaunchScopes.FromCatalog(inviteCap?["localSource"]);
                    var actions = new List<string> { "OBSERVE", "CONTROL", "INTERACT", "APPROVE" };
                    if (scopes.Count > 0)
                    {
                        actions.AddRange(["LAUNCH", "COLLABORATE", "ADOPT"]);
                        if (inviteCap?["nativeLocalHandoffs"]?.GetValue<bool>() == true &&
                            scopes.Any(scope => scope.EngineId is "pi" or "sage-pi" or "codex"))
                            actions.Add("HANDOFF");
                    }
                    if (request.Args?["createAcs"]?.GetValue<bool>() == true)
                    {
                        if (inviteCap?["acsSessionCreate"]?.GetValue<bool>() != true)
                            return new(false, "当前网关未接入 ACS 会话创建");
                        foreach (var action in new[] { "CREATE", "ASSIGN", "POLICY", "COLLABORATE", "ADOPT", "HANDOFF" })
                            if (!actions.Contains(action)) actions.Add(action);
                    }
                    var invitation = await OwnerAsync(HttpMethod.Post, "pairing-invitations",
                        new { requestId = "win-link-" + Guid.NewGuid().ToString("N"),
                            resources = Array.Empty<string>(), launchScopes = scopes, actions }, cancellation);
                    if (invitation is JsonObject payload)
                    {
                        payload.Remove("certificatePem");
                        var member = connector.GetSnapshot();
                        if (member.Route is { } route)
                            RelayContract.TryInjectRelay(payload, route, inviteCap);
                    }
                    return new(true, Data: invitation);
                case "memberLogin":
                    if (!connector.PackagePresent) return new(false, "此安装不包含会员连接组件");
                    connector.RequestLogin();
                    var login = connector.GetSnapshot();
                    return new(true, Data: JsonSerializer.SerializeToNode(new
                    {
                        state = MemberStateName(login.Phase), userCode = login.UserCode,
                    }, LinkProtocol.Json));
                case "memberCancel":
                    connector.RequestCancel();
                    return new(true);
                case "memberLogout":
                    connector.RequestLogout();
                    return new(true);
                default:
                    return new(false, "操作当前不可用");
            }
        }
        finally { mutations.Release(); }
    }

    private async Task<LinkReply> PrepareUpdateAsync(string? operationId, CancellationToken cancellation)
    {
        if (operationId is null || !LinkUpdateTransition.ValidOperationId(operationId))
            return new(false, "INVALID_UPDATE_OPERATION");
        if (!LinkUpdateTransition.Matches(operationId)) return new(false, "UPDATE_LOCK_REQUIRED");
        if (ports is not { } active || status.GatewayPid is not int gatewayPid || gatewayPid <= 0)
            return new(false, "GATEWAY_UNCONFIRMED");
        var hold = updateActivity.Reserve();
        if (hold is null) return new(false, "UPDATE_LOCAL_ACTIVITY");
        var attempted = false;
        try
        {
            if (connector.LoginPending || managed.HasUnregisteredWorker)
                return new(false, "UPDATE_LOCAL_ACTIVITY");
            attempted = true;
            var reservation = await GatewayUpdateReservation.AcquireAsync(OwnerAsync, operationId, cancellation);
            if (reservation.Error is { } error) return new(false, error);
            if (!ReferenceEquals(active, ports) || gatewayPid != status.GatewayPid || !LinkUpdateTransition.Matches(operationId))
                return new(false, "GATEWAY_UNCONFIRMED");
            var receipt = new LinkUpdateHandoff(operationId, Environment.ProcessId, gatewayPid, reservation.BootId!,
                reservation.Identity!);
            var reply = new LinkReply(true, Data: JsonSerializer.SerializeToNode(receipt, LinkProtocol.Json));
            preparedUpdate = new(receipt, active, hold);
            return reply;
        }
        finally
        {
            if (preparedUpdate is null)
            {
                try { if (attempted) await ReleaseUpdateAsync(operationId, active); }
                finally { hold.Dispose(); }
            }
        }
    }

    private async Task ReleaseUpdateAsync(string operationId, Ports active)
    {
        if (!ReferenceEquals(active, ports)) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try { await OwnerAsync(HttpMethod.Post, "update-preparation/release", new { operationId }, deadline.Token); }
        catch (Exception error) when (error is IOException or HttpRequestException or JsonException or OperationCanceledException) { }
    }

    public void Dispose()
    {
        managed.Dispose();
        owner.Dispose();
        mutations.Dispose();
        stop.Dispose();
    }

    private sealed record WorkerCard(string ConnectionId, string Url, string Token, string? DisplayName);
    private sealed record PreparedUpdate(LinkUpdateHandoff Receipt, Ports Ports, IDisposable Activity);
}

internal sealed record Ports(int Phone, int Owner, int Relay);
