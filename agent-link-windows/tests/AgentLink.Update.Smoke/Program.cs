using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using AgentLink;

if (args is not [var node, var gateway, var preload])
    throw new ArgumentException("Specify the Node executable, bundled gateway and parent preload.");

var activity = new UpdateActivity();
using (var transfer = activity.Enter())
{
    Check(transfer is not null && activity.Reserve() is null, "file activity did not defer installation");
}
using (var reservation = activity.Reserve())
{
    Check(reservation is not null && activity.Held && activity.Enter() is null && activity.Reserve() is null,
        "reservation did not close local intake");
}
Check(!activity.Held, "releasing the hold did not restore intake");
activity.MarkUnconfirmed();
Check(activity.Reserve() is null, "an unconfirmed child stop did not block installation");
Console.WriteLine("PASS: local activity drains before a reservation and cannot enter while held.");

var scratch = Path.Combine(Path.GetTempPath(), "link-update-probe-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(scratch);
try
{
    if (OperatingSystem.IsWindows())
    {
        Environment.SetEnvironmentVariable("AGENT_LINK_WINDOWS_STATE", Path.Combine(scratch, "windows-state"));
        Check(!LinkUpdateTransition.IsHeld(), "inactive transition blocked startup");
        using (LinkUpdateTransition.Acquire("test-operation"))
        {
            Check(LinkUpdateTransition.IsHeld() && LinkUpdateTransition.Matches("test-operation") &&
                !LinkUpdateTransition.Matches("other-operation"), "operation lock did not bind the active update");
            try
            {
                using var unexpected = LinkUpdateTransition.Acquire("other-operation");
                throw new InvalidOperationException("A second updater took the installation lock.");
            }
            catch (IOException) { }
        }
        Check(!LinkUpdateTransition.IsHeld() && !LinkUpdateTransition.Matches("test-operation"),
            "the released lock still blocks startup");
        Console.WriteLine("PASS: Windows transition locking binds one active operation.");
    }
    var live = Path.Combine(scratch, "live");
    var snapshot = Path.Combine(scratch, "snapshot");
    Directory.CreateDirectory(live);
    Directory.CreateDirectory(snapshot);
    using var rsa = RSA.Create(2048);
    var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(1));
    var ownerToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    var clientToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    var storeKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    const string operation = "upgrade-fixture";
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));
    using var http = new HttpClient(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(2) };
    int ownerPort;
    LinkUpdateHandoff handoff;
    using (var prior = Start(live, null, out ownerPort))
    {
        try
        {
            for (;;)
            {
                Check(!prior.HasExited, "original gateway exited before readiness");
                try { await Call(HttpMethod.Get, "capabilities", null, deadline.Token); break; }
                catch (HttpRequestException) { await Task.Delay(100, deadline.Token); }
            }
            var other = await GatewayUpdateReservation.AcquireAsync(Call, "other-operation", deadline.Token);
            Check(other.Error is null && other.Identity is not null, "another operation could not reserve the gateway");
            try
            {
                await GatewayUpdateReservation.AcquireAsync(Call, operation, deadline.Token);
                throw new InvalidOperationException("A second operation took over the gateway reservation.");
            }
            catch (HttpRequestException error) when (error.StatusCode == HttpStatusCode.Conflict) { }
            var stillHeld = await Call(HttpMethod.Get, "update-preparation", null, deadline.Token);
            Check(stillHeld?["operationId"]?.GetValue<string>() == "other-operation", "other reservation was released");
            await Call(HttpMethod.Post, "update-preparation/release", new { operationId = "other-operation" }, deadline.Token);
            var held = await GatewayUpdateReservation.AcquireAsync(Call, operation, deadline.Token);
            Check(held is { Error: null, BootId.Length: > 0, Identity: not null }, "gateway did not confirm update reservation");
            handoff = new(operation, Environment.ProcessId, prior.Id, held.BootId!, held.Identity!);
            await Stop(prior);
        }
        finally { if (!prior.HasExited) prior.Kill(entireProcessTree: true); }
    }
    var before = HashDirectory(live);
    Check(before.ContainsKey("device-gateway.db"), "the original gateway did not produce SQLite state");
    foreach (var relative in before.Keys)
    {
        var copy = Path.Combine(snapshot, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
        File.Copy(Path.Combine(live, relative), copy);
    }
    var gate = Path.Combine(scratch, "startup-gate");
    File.WriteAllText(gate, operation);
    using (var candidate = Start(snapshot, gate, out ownerPort))
    {
        try
        {
            async Task<bool> CheckCandidate(LinkUpdateHandoff expected) =>
                await GatewayProbeClient.CheckAsync(http, ownerPort, ownerToken, clientToken, expected,
                    () => !candidate.HasExited, deadline.Token);
            Check(await CheckCandidate(handoff), "candidate did not preserve the fenced identity");
            Check(!await CheckCandidate(handoff with { OperationId = "other-operation" }), "stale operation was accepted");
            Check(!await CheckCandidate(handoff with { Identity = handoff.Identity with
                { DeviceCount = handoff.Identity.DeviceCount + 1 } }), "different device count was accepted");
            await Stop(candidate);
            Check(File.ReadAllText(gate) == operation, "candidate needed the startup gate released to exit");
        }
        finally { if (!candidate.HasExited) candidate.Kill(entireProcessTree: true); }
    }
    Check(before.OrderBy(pair => pair.Key).SequenceEqual(HashDirectory(live).OrderBy(pair => pair.Key)),
        "the probe changed the original gateway files");
    Console.WriteLine("PASS: actual gateway preserved the owner reservation, fenced candidate requests and exited cleanly over a snapshot.");

    async Task<JsonNode?> Call(HttpMethod method, string resource, object? body, CancellationToken cancellation)
    {
        using var req = new HttpRequestMessage(method, $"http://127.0.0.1:{ownerPort}/api/v2/personal-access/{resource}");
        req.Headers.Authorization = new("Bearer", ownerToken);
        req.Headers.Add("X-Client-Session", clientToken);
        if (body is not null) req.Content = JsonContent.Create(body);
        using var response = await http.SendAsync(req, cancellation);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonNode>(cancellation);
    }

    Process Start(string data, string? marker, out int owner)
    {
        int phone, relay;
        var listeners = Enumerable.Range(0, 3).Select(_ => new TcpListener(IPAddress.Loopback, 0)).ToArray();
        try
        {
            foreach (var listener in listeners) listener.Start();
            phone = ((IPEndPoint)listeners[0].LocalEndpoint).Port;
            owner = ((IPEndPoint)listeners[1].LocalEndpoint).Port;
            relay = ((IPEndPoint)listeners[2].LocalEndpoint).Port;
        }
        finally { foreach (var listener in listeners) listener.Stop(); }
        var start = new ProcessStartInfo(Path.GetFullPath(node)) { UseShellExecute = false, RedirectStandardInput = true };
        start.ArgumentList.Add("--import");
        start.ArgumentList.Add(new Uri(Path.GetFullPath(preload)).AbsoluteUri);
        start.ArgumentList.Add(Path.GetFullPath(gateway));
        var env = start.Environment;
        env.Clear();
        env["PATH"] = "/usr/bin:/bin";
        env["HOME"] = data;
        env["DEVICE_GATEWAY_PROFILE"] = "LOCAL_CLI";
        env["DEVICE_GATEWAY_DATA_DIR"] = data;
        env["DEVICE_GATEWAY_BIND"] = "127.0.0.1";
        env["DEVICE_GATEWAY_MDNS"] = "0";
        env["DEVICE_GATEWAY_STOP_ON_STDIN_END"] = "1";
        env["DEVICE_GATEWAY_PORT"] = phone.ToString();
        env["DEVICE_GATEWAY_OWNER_PORT"] = owner.ToString();
        env["DEVICE_GATEWAY_RELAY_PORT"] = relay.ToString();
        env["DEVICE_GATEWAY_OWNER_TOKEN"] = ownerToken;
        env["DEVICE_GATEWAY_OWNER_CLIENT_TOKEN"] = clientToken;
        env["DEVICE_GATEWAY_STORE_KEY"] = storeKey;
        env["DEVICE_GATEWAY_TLS_KEY"] = rsa.ExportPkcs8PrivateKeyPem();
        env["DEVICE_GATEWAY_TLS_CERT"] = certificate.ExportCertificatePem();
        if (marker is not null) env["DEVICE_GATEWAY_STARTUP_UPDATE_FILE"] = marker;
        var process = Process.Start(start) ?? throw new IOException("Failed to start the gateway.");
        process.StandardInput.WriteLine("start");
        process.StandardInput.Flush();
        return process;
    }

    async Task Stop(Process process)
    {
        process.StandardInput.Close();
        using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(6));
        await process.WaitForExitAsync(shutdown.Token);
        Check(process.ExitCode == 0, "gateway did not shut down cleanly");
    }
}
finally { Directory.Delete(scratch, recursive: true); }

static Dictionary<string, string> HashDirectory(string folder) => Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
    .ToDictionary(path => Path.GetRelativePath(folder, path), path =>
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    });

static void Check(bool value, string message)
{
    if (!value) throw new InvalidOperationException(message);
}
