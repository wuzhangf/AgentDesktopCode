using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace AgentLink;

/// <summary>Starts only the bundled gateway, over the stopped Host's private snapshot.</summary>
internal static class WindowsGatewayProbe
{
    internal static async Task<bool> RunAsync(string operationId, bool seed)
    {
        if (!LinkUpdateTransition.Matches(operationId)) return false;
        var snapshot = LinkUpdateTransition.SnapshotPath(operationId);
        CheckSnapshot(snapshot);
        var gatewayData = Path.Combine(snapshot, "gateway");
        LinkUpdateHandoff? receipt = null;
        if (!seed)
        {
            if (!File.Exists(Path.Combine(gatewayData, "device-gateway.db"))) return false;
            using var receiptFile = File.OpenRead(LinkUpdateTransition.StoppedReceipt);
            if (receiptFile.Length > 16 * 1024) return false;
            receipt = JsonSerializer.Deserialize<LinkUpdateHandoff>(receiptFile, LinkProtocol.Json);
            if (receipt is null || receipt.OperationId != operationId || receipt.GatewayBootId is not { Length: > 0 } ||
                receipt.Identity is not { PersonalHostId.Length: > 0, StoreId.Length: > 0, DeviceCount: >= 0 })
                return false;
        }
        var identity = LinkIdentity.Load(snapshot, requireExisting: !seed);
        Directory.CreateDirectory(gatewayData);
        var installRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
        var node = LinkHost.ProcessInfo(Path.Combine(installRoot, "runtime", "gateway-node.exe"), gatewayData);
        node.ArgumentList.Add("--import");
        node.ArgumentList.Add(new Uri(Path.Combine(installRoot, "runtime", "await-parent.mjs")).AbsoluteUri);
        node.ArgumentList.Add(Path.Combine(installRoot, "components", "gateway", "device-gateway.mjs"));
        var ports = LinkHost.AllocatePorts();
        var gate = Path.Combine(snapshot, "startup-gate");
        using (var file = new FileStream(gate, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        using (var writer = new StreamWriter(file)) writer.Write(operationId);
        using var certificate = identity.Certificate();
        using var key = certificate.GetRSAPrivateKey() ?? throw new InvalidDataException("Missing probe TLS key.");
        var env = node.Environment;
        foreach (var folder in new[] { "HOME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP" })
            env[folder] = snapshot;
        env["DEVICE_GATEWAY_PROFILE"] = "LOCAL_CLI";
        env["DEVICE_GATEWAY_DATA_DIR"] = gatewayData;
        env["DEVICE_GATEWAY_STARTUP_UPDATE_FILE"] = gate;
        env["DEVICE_GATEWAY_STOP_ON_STDIN_END"] = "1";
        env["DEVICE_GATEWAY_MDNS"] = "0";
        env["DEVICE_GATEWAY_BIND"] = "127.0.0.1";
        env["DEVICE_GATEWAY_PORT"] = ports.Phone.ToString();
        env["DEVICE_GATEWAY_OWNER_PORT"] = ports.Owner.ToString();
        env["DEVICE_GATEWAY_RELAY_PORT"] = ports.Relay.ToString();
        env["DEVICE_GATEWAY_OWNER_TOKEN"] = identity.OwnerToken;
        env["DEVICE_GATEWAY_OWNER_CLIENT_TOKEN"] = identity.ClientToken;
        env["DEVICE_GATEWAY_STORE_KEY"] = identity.StoreKey;
        env["DEVICE_GATEWAY_TLS_KEY"] = key.ExportPkcs8PrivateKeyPem();
        env["DEVICE_GATEWAY_TLS_CERT"] = certificate.ExportCertificatePem();

        using var job = new OwnedProcess(node);
        var stdout = job.Process.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
        var stderr = job.Process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        using var http = new HttpClient(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false })
            { Timeout = TimeSpan.FromSeconds(2) };
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(50));
        bool ready;
        try
        {
            ready = await GatewayProbeClient.CheckAsync(http, ports.Owner, identity.OwnerToken, identity.ClientToken,
                operationId, receipt, () => !job.Process.HasExited, deadline.Token);
        }
        finally
        {
            await job.StopForUpdateAsync(requireCleanExit: true);
            await Task.WhenAll(stdout, stderr);
        }
        return ready && LinkUpdateTransition.Matches(operationId) && File.ReadAllText(gate) == operationId;
    }

    private static void CheckSnapshot(string directory)
    {
        for (var ancestor = new DirectoryInfo(directory); ancestor is not null; ancestor = ancestor.Parent)
        {
            if (!ancestor.Exists || (ancestor.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("The Windows probe snapshot is missing or redirected.");
        }
        var pending = new Stack<string>();
        pending.Push(directory);
        while (pending.TryPop(out var folder))
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(folder))
            {
                var attributes = File.GetAttributes(path);
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0)
                    throw new InvalidDataException("The Windows probe snapshot contains a redirected file.");
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(path);
            }
        }
    }
}
