using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

internal sealed class WindowsLinkFiles(string installRoot, string memberOrigin, UpdateActivity updateActivity)
{
    private readonly string worker = Path.Combine(installRoot, "components", "files", "agent-link-files.exe");

    internal async Task RunAsync(CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                await using var channel = new NamedPipeServerStream(LinkProtocol.FilePipe, PipeDirection.InOut,
                    1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await channel.WaitForConnectionAsync(cancellation);
                try
                {
                    using var framing = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    framing.CancelAfter(TimeSpan.FromSeconds(8));
                    var request = await LinkProtocol.ReadAsync<LinkRequest>(channel, framing.Token);
                    framing.CancelAfter(TimeSpan.FromMinutes(29));
                    LinkReply reply;
                    try
                    {
                        using var operation = updateActivity.Enter();
                        reply = operation is null
                            ? new(false, "UPDATE_IN_PROGRESS")
                            : await ExecuteAsync(request, framing.Token);
                    }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException
                        or InvalidOperationException or CryptographicException or System.ComponentModel.Win32Exception)
                    {
                        reply = new(false, "本机文件传输失败，请刷新后重试。");
                    }
                    await LinkProtocol.WriteAsync(channel, reply, framing.Token);
                }
                catch (Exception error) when (error is IOException or JsonException or OperationCanceledException) { }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private async Task<LinkReply> ExecuteAsync(LinkRequest request, CancellationToken cancellation)
    {
        if (!File.Exists(worker)) return new(false, "此安装不包含文件传输组件。");
        if (request.Operation is not ("overview" or "send" or "receive" or "resume" or "retain" or "removeRetention"
            or "grantAccess" or "receiveGrant" or "revokeGrant"))
            return new(false, "文件操作不可用。");
        var session = MemberCredentials.FileSession();
        if (session is null) return new(false, "请先在 Agent Link 登录会员。");

        var scope = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(memberOrigin + "\n" + session.Value.Scope)));
        var state = Path.Combine(LinkProtocol.Root, "files", scope);
        Directory.CreateDirectory(state);
        var input = new JsonObject
        {
            ["operation"] = request.Operation,
            ["origin"] = memberOrigin,
            ["state"] = state,
            ["identity"] = LoadIdentity(state),
            ["label"] = Environment.MachineName,
            ["bearer"] = session.Value.Bearer,
        };
        if (request.Args is JsonObject args)
        {
            foreach (var name in new[] { "source", "destination", "recipientId", "requestKey", "transferId", "granteeId", "grantId" })
            {
                if (args[name] is JsonValue value && value.TryGetValue<string>(out var text))
                    input[name] = text;
            }
        }
        var info = new ProcessStartInfo(worker)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
        };
        using var workerJob = new OwnedProcess(info, signalStart: false);
        var process = workerJob.Process;
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(cancellation);
            var diagnostics = process.StandardError.ReadToEndAsync(cancellation);
            await process.StandardInput.WriteAsync(input.ToJsonString(LinkProtocol.Json).AsMemory(), cancellation);
            process.StandardInput.Close();
            await process.WaitForExitAsync(cancellation);
            await diagnostics;
            var response = await output;
            if (response.Length > 100_000 || process.ExitCode != 0) throw new InvalidDataException();
            var result = JsonNode.Parse(response) as JsonObject ?? throw new InvalidDataException();
            if (MemberCredentials.FileSession()?.Scope != session.Value.Scope)
                return new(false, "会员会话已变化，请刷新后重试。");
            return result["ok"]?.GetValue<bool>() == true
                ? new(true, Data: result["data"]?.DeepClone())
                : new(false, result["code"]?.GetValue<string>() ?? "文件传输失败。");
        }
        finally
        {
            try { await workerJob.StopForUpdateAsync(requireCleanExit: false); }
            catch (Exception error) when (error is IOException or InvalidOperationException or
                System.ComponentModel.Win32Exception or OperationCanceledException)
            {
                updateActivity.MarkUnconfirmed();
                throw;
            }
        }
    }

    private static JsonObject LoadIdentity(string state)
    {
        var path = Path.Combine(state, "identity.dpapi");
        if (File.Exists(path))
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser);
            try { return JsonNode.Parse(plain) as JsonObject ?? throw new InvalidDataException(); }
            finally { CryptographicOperations.ZeroMemory(plain); }
        }
        var identity = new JsonObject
        {
            ["id"] = Guid.NewGuid().ToString("N"),
            ["secret"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
            ["agreement"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
            ["signing"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(identity, LinkProtocol.Json);
        try { LinkIdentity.SaveAtomic(path, ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser)); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
        return identity;
    }
}
