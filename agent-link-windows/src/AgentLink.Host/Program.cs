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
    private readonly CancellationTokenSource stop = new();
    private readonly HttpClient owner = new(new SocketsHttpHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(2),
    }) { Timeout = TimeSpan.FromSeconds(5) };
    private readonly string computer = Environment.MachineName;
    private readonly SemaphoreSlim mutations = new(1, 1);
    private volatile LinkStatus status;
    private LinkIdentity? identity;
    private volatile bool enabled;
    private volatile Ports? ports;
    private string WorkerPathFile => Path.Combine(LinkProtocol.Root, "worker-card.path");
    private WorkerCard? registered;

    internal LinkHost() => status = NewStatus("正在启动");

    private LinkStatus NewStatus(string message) => new(false, message, computer, null, 0, 0, null, null, null, enabled);

    internal async Task RunAsync()
    {
        var local = ServeAsync(stop.Token);
        try
        {
            try
            {
                identity = LinkIdentity.Load();
                enabled = !File.Exists(Path.Combine(LinkProtocol.Root, "disabled"));
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
        var firstStart = !File.Exists(portsFile);
        var chosen = firstStart ? AllocatePorts() :
            JsonSerializer.Deserialize<Ports>(File.ReadAllBytes(portsFile), LinkProtocol.Json)
                ?? throw new InvalidDataException("Missing saved ports.");
        if (chosen.Phone is < 1024 or > 65535 || chosen.Owner is < 1024 or > 65535 || chosen.Phone == chosen.Owner)
            throw new InvalidDataException("Invalid saved ports.");

        var launch = ProcessInfo(Path.Combine(InstallRoot, "runtime", "gateway-node.exe"), data);
        launch.ArgumentList.Add("--import");
        launch.ArgumentList.Add(new Uri(Path.Combine(InstallRoot, "runtime", "await-parent.mjs")).AbsoluteUri);
        launch.ArgumentList.Add(Path.Combine(InstallRoot, "components", "gateway", "device-gateway.mjs"));
        using var certificate = identity!.Certificate();
        using var key = certificate.GetRSAPrivateKey() ?? throw new InvalidDataException("Missing TLS private key.");
        var origin = $"https://{computer}.local:{chosen.Phone}";
        var variables = launch.Environment;
        variables["DEVICE_GATEWAY_PROFILE"] = "LOCAL_CLI";
        variables["DEVICE_GATEWAY_DATA_DIR"] = data;
        variables["DEVICE_GATEWAY_BIND"] = "::";
        variables["DEVICE_GATEWAY_PORT"] = chosen.Phone.ToString();
        variables["DEVICE_GATEWAY_OWNER_PORT"] = chosen.Owner.ToString();
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
            registered = null;
            await mutations.WaitAsync(cancellation);
            try
            {
                await RefreshAsync(gateway.Process.Id, cancellation);
                if (firstStart) LinkIdentity.SaveAtomic(portsFile, JsonSerializer.SerializeToUtf8Bytes(chosen, LinkProtocol.Json));
            }
            finally { mutations.Release(); }
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
            var exited = gateway.Process.WaitForExitAsync(cancellation);
            while (!exited.IsCompleted)
            {
                var tick = timer.WaitForNextTickAsync(cancellation).AsTask();
                if (await Task.WhenAny(tick, exited) == exited) break;
                await tick;
                await mutations.WaitAsync(cancellation);
                try { await RefreshAsync(gateway.Process.Id, cancellation); }
                finally { mutations.Release(); }
            }
            await exited;
            status = NewStatus($"后台网关已退出（{gateway.Process.ExitCode}），正在恢复");
        }
        finally
        {
            ports = null;
            await gateway.StopAsync();
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
                item?["owner"]?["port"]?.GetValue<int>() == chosen.Owner) return;
        }
        throw new IOException("Gateway exited before opening its listeners.");
    }

    private static async Task DrainAsync(StreamReader reader)
    {
        var buffer = new char[4096];
        while (await reader.ReadAsync(buffer) != 0) { }
    }

    private static ProcessStartInfo ProcessInfo(string file, string work)
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

    private static Ports AllocatePorts()
    {
        using var phone = new TcpListener(IPAddress.IPv6Any, 0);
        using var owner = new TcpListener(IPAddress.Loopback, 0);
        phone.Server.DualMode = true;
        phone.Start();
        owner.Start();
        return new(((IPEndPoint)phone.LocalEndpoint).Port, ((IPEndPoint)owner.LocalEndpoint).Port);
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

    private async Task RefreshAsync(int gatewayPid, CancellationToken cancellation)
    {
        await RefreshWorkerAsync(cancellation);
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
        var message = !enabled ? "手机连接已关闭" : scopesSynced ? "后台已就绪" : "手机授权同步暂未完成";
        status = new(true, message, computer,
            LanAddress() is { } ip ? $"https://{ip}:{ports!.Phone}" : cap?["origin"]?.GetValue<string>(),
            devices?.Count(d => d?["state"]?.GetValue<string>() == "ACTIVE") ?? 0,
            requests?.Count(d => d?["state"]?.GetValue<string>() == "PENDING") ?? 0,
            cap?["personalHostId"]?.GetValue<string>(), cap?["storeId"]?.GetValue<string>(), gatewayPid, enabled);
    }

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

    private async Task RegisterWorkerAsync(WorkerCard? card, CancellationToken cancellation)
    {
        if (registered == card) return;
        if (card is not null)
        {
            using var probe = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(card.Url), "/local/v1/identity"));
            probe.Headers.Authorization = new("Bearer", card.Token);
            using var response = await owner.SendAsync(probe, cancellation);
            response.EnsureSuccessStatusCode();
            await OwnerAsync(HttpMethod.Post, "worker-registrations", new
            {
                card.ConnectionId, card.Url, card.Token,
                displayName = card.DisplayName ?? card.ConnectionId,
            }, cancellation);
        }
        if (registered is { } old && old.ConnectionId != card?.ConnectionId)
            await OwnerAsync(HttpMethod.Delete, "worker-registrations/" + old.ConnectionId, null, cancellation);
        registered = card;
    }

    private async Task RefreshWorkerAsync(CancellationToken cancellation)
    {
        WorkerCard? card = null;
        try
        {
            if (File.Exists(WorkerPathFile))
                card = await LoadWorkerAsync(await File.ReadAllTextAsync(WorkerPathFile, cancellation), cancellation);
            await RegisterWorkerAsync(card, cancellation);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or HttpRequestException
            || error is OperationCanceledException && !cancellation.IsCancellationRequested)
        {
            if (card is null && registered is not null)
                await RegisterWorkerAsync(null, cancellation);
        }
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
                try
                {
                    var request = await LinkProtocol.ReadAsync<LinkRequest>(channel, deadline.Token);
                    LinkReply reply;
                    try { reply = await HandleAsync(request, deadline.Token); }
                    catch (HttpRequestException error) { reply = new(false, error.Message); }
                    catch (IOException error) { reply = new(false, error.Message); }
                    catch (UnauthorizedAccessException) { reply = new(false, "无法访问本机配置"); }
                    await LinkProtocol.WriteAsync(channel, reply, deadline.Token);
                    if (request.Operation == "exit" && reply.Ok) stop.Cancel();
                }
                catch (Exception error) when (error is IOException or OperationCanceledException or JsonException) { }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private async Task<LinkReply> HandleAsync(LinkRequest request, CancellationToken cancellation)
    {
        if (request.Operation == "status") return new(true, Data: JsonSerializer.SerializeToNode(status, LinkProtocol.Json));
        if (request.Operation == "exit") return new(true);
        await mutations.WaitAsync(cancellation);
        try
        {
            if (!status.Ready || ports is null) return new(false, "后台网关暂未就绪");
            switch (request.Operation)
            {
                case "agents":
                    var cap = await OwnerAsync(HttpMethod.Get, "capabilities", null, cancellation);
                    return new(true, Data: cap?["localSource"]?.DeepClone());
                case "worker" when request.Id is { } path:
                    var card = await LoadWorkerAsync(path, cancellation);
                    await RegisterWorkerAsync(card, cancellation);
                    LinkIdentity.SaveAtomic(WorkerPathFile, System.Text.Encoding.UTF8.GetBytes(path));
                    return new(true);
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
                    var actions = new[] { "OBSERVE", "CONTROL", "INTERACT", "APPROVE", "LAUNCH" };
                    var invitation = await OwnerAsync(HttpMethod.Post, "pairing-invitations",
                        new { requestId = "win-link-" + Guid.NewGuid().ToString("N"), resources = Array.Empty<string>(),
                            launchScopes = "detected", actions }, cancellation);
                    if (invitation is JsonObject payload) payload.Remove("certificatePem");
                    return new(true, Data: invitation);
                default:
                    return new(false, "操作当前不可用");
            }
        }
        finally { mutations.Release(); }
    }

    public void Dispose()
    {
        owner.Dispose();
        mutations.Dispose();
        stop.Dispose();
    }

    private sealed record Ports(int Phone, int Owner);
    private sealed record WorkerCard(string ConnectionId, string Url, string Token, string? DisplayName);
}
