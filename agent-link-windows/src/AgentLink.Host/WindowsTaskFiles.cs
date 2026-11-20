using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Text.Encodings.Web;

namespace AgentLink;

internal sealed class WindowsTaskFiles(WindowsLinkFiles files, UpdateActivity updateActivity)
{
    private const int MaxFileBytes = 32 * 1024 * 1024;
    private const int MaxFrame = (MaxFileBytes + 2) / 3 * 4 + 4096;
    private const int MaxMcpRequest = 16384;
    private static readonly Regex HexKey = new("^[a-f0-9]{64}$");
    private static readonly Regex EntityId = new("^[a-zA-Z0-9_-]{1,80}$");
    private static readonly string PipePrefix = @"\\.\pipe\";
    private static readonly string PipeName = LinkProtocol.Pipe + ".task-files";
    private static readonly string State = Path.Combine(LinkProtocol.Root, "task-files");
    private static readonly JsonSerializerOptions WireJson = new(LinkProtocol.Json)
        { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    internal string GatewayKey { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    internal string PipePath => PipePrefix + PipeName;

    private sealed record Scope(string Account, string SourceKey, string Capability, string Signature,
        string TransferId, string PhoneId, long SizeBytes, long ExpiresAt, JsonArray Results, JsonArray? Pending = null);

    internal async Task RunAsync(CancellationToken stop)
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(stop);
                try
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
                    deadline.CancelAfter(TimeSpan.FromSeconds(8));
                    var request = await ReadAsync(pipe, deadline.Token);
                    deadline.CancelAfter(TimeSpan.FromMinutes(7));
                    using var operation = updateActivity.Enter();
                    var reply = operation is null
                        ? new JsonObject { ["error"] = "UPDATE_IN_PROGRESS" }
                        : await DispatchAsync(request, deadline.Token);
                    await WriteAsync(pipe, reply, deadline.Token);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException
                    or CryptographicException or InvalidOperationException or FormatException or OperationCanceledException) { }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private async Task<JsonObject> DispatchAsync(JsonObject request, CancellationToken cancellation)
    {
        var method = request["method"]?.GetValue<string>();
        var key = request["key"]?.GetValue<string>() ?? "";
        var account = MemberCredentials.FileSession()?.Scope;
        if (!HexKey.IsMatch(key) || account is null) return Refused();
        if (FixedEquals(key, GatewayKey))
        {
            if (method == "device")
            {
                var device = await files.ExecuteAsync(new("device"), cancellation);
                return device.Ok && device.Data is JsonObject data ? data :
                    new() { ["error"] = device.Error ?? "taskFileDeviceUnavailable" };
            }
            var sourceKey = request["sourceKey"]?.GetValue<string>() ?? "";
            if (!EntityId.IsMatch(sourceKey)) return Refused();
            var slot = "source-" + Hash(account + "\n" + sourceKey);
            var index = ReadScope(slot);
            var existing = index is null ? null : ReadScope(index.Capability);
            if (method == "results")
            {
                if (existing?.Pending?.FirstOrDefault() is JsonObject pending)
                    await PublishAsync(existing, pending, cancellation);
                return new() { ["results"] = existing?.Results.DeepClone() ?? new JsonArray(),
                    ["pending"] = existing?.Pending?.Count ?? 0 };
            }
            if (method != "authorize" || request["attachment"] is not JsonObject attachment ||
                attachment["signature"]?.GetValue<string>() is not { Length: 88 } signature ||
                attachment["expiresAt"]?.GetValue<long>() is not { } expiry ||
                expiry <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()) return Refused();

            var grant = await files.ExecuteAsync(new("taskAuthorize", Args: new JsonObject
                { ["attachment"] = attachment.DeepClone() }), cancellation);
            if (!grant.Ok || grant.Data is not JsonObject verified || MemberCredentials.FileSession()?.Scope != account)
                return Refused();
            if (existing is not null &&
                (!FixedEquals(signature, existing.Signature) || existing.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()))
                return Refused();
            var capability = existing?.Capability ?? Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var scope = existing ?? new Scope(account, sourceKey, capability, signature,
                verified["id"]!.GetValue<string>(), verified["phoneId"]!.GetValue<string>(),
                verified["sizeBytes"]!.GetValue<long>(), Math.Min(expiry, DateTimeOffset.UtcNow.AddMinutes(30).ToUnixTimeSeconds()), new(), new());
            SaveScope(capability, scope);
            if (existing is null) SaveScope(slot, scope);
            return new() { ["key"] = capability };
        }

        var bound = ReadScope(key);
        if (bound is null || bound.Account != account || !FixedEquals(bound.Capability, key)
            || bound.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()) return Refused();
        var args = request["arguments"] as JsonObject ?? new();
        if (method == "list") return new() { ["transferId"] = bound.TransferId, ["sizeBytes"] = bound.SizeBytes };
        if (method == "receive")
        {
            if (args["transferId"]?.GetValue<string>() != bound.TransferId) return Refused();
            var destination = Path.Combine(State, $"receive-{Guid.NewGuid():N}.part");
            try
            {
                var reply = await files.ExecuteAsync(new("receive", Args: new JsonObject
                    { ["transferId"] = bound.TransferId, ["destination"] = destination }), cancellation);
                if (!reply.Ok || new FileInfo(destination).Length != bound.SizeBytes) return Refused();
                return new() { ["transferId"] = bound.TransferId,
                    ["contents"] = Convert.ToBase64String(await File.ReadAllBytesAsync(destination, cancellation)) };
            }
            finally { File.Delete(destination); }
        }
        if (method != "send" || args["name"]?.GetValue<string>() is not { } name ||
            args["contents"]?.GetValue<string>() is not { } contents) return Refused();
        return await StageResultAsync(bound, name, contents, cancellation);
    }

    private static string StagePath(Scope scope, string key) =>
        Path.Combine(State, $"result-{scope.Capability}-{key}.dpapi");

    private async Task<JsonObject> StageResultAsync(Scope scope, string name, string contents, CancellationToken cancellation)
    {
        if (name.Length is < 1 or > 180 || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return Refused();
        var bytes = Convert.FromBase64String(contents);
        if (bytes.Length > MaxFileBytes) return Refused();
        var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var requestKey = Hash(scope.SourceKey + "\n" + name + "\n" + digest);
        if (scope.Results.OfType<JsonObject>().FirstOrDefault(row =>
            row["requestKey"]?.GetValue<string>() == requestKey) is { } prior)
            return new() { ["transferId"] = prior["transferId"]?.DeepClone() };
        scope = scope.Pending is null ? scope with { Pending = new() } : scope;
        var pending = scope.Pending!;
        var entry = pending.OfType<JsonObject>().FirstOrDefault(row => row["requestKey"]?.GetValue<string>() == requestKey);
        if (entry is null)
        {
            if (scope.Results.Count + pending.Count >= 16) return Refused();
            LinkIdentity.SaveAtomic(StagePath(scope, requestKey),
                ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser));
            entry = new() { ["name"] = name, ["requestKey"] = requestKey, ["sha256"] = digest };
            pending.Add(entry);
            SaveScope(scope.Capability, scope);
        }
        return await PublishAsync(scope, entry, cancellation) ?? new() { ["publicationPending"] = true };
    }

    private async Task<JsonObject?> PublishAsync(Scope scope, JsonObject entry, CancellationToken cancellation)
    {
        if (MemberCredentials.FileSession()?.Scope != scope.Account) return null;
        var requestKey = entry["requestKey"]!.GetValue<string>();
        var digest = entry["sha256"]!.GetValue<string>();
        var encrypted = StagePath(scope, requestKey);
        var staged = Path.Combine(State, $"publish-{Guid.NewGuid():N}.part");
        try
        {
            var bytes = ProtectedData.Unprotect(await File.ReadAllBytesAsync(encrypted, cancellation),
                null, DataProtectionScope.CurrentUser);
            try { await File.WriteAllBytesAsync(staged, bytes, cancellation); }
            finally { CryptographicOperations.ZeroMemory(bytes); }
            var reply = await files.ExecuteAsync(new("send", Args: new JsonObject
            {
                ["source"] = staged, ["name"] = entry["name"]?.DeepClone(),
                ["recipientId"] = scope.PhoneId, ["requestKey"] = requestKey,
            }), cancellation);
            if (!reply.Ok || reply.Data is not JsonObject result || result["sha256"]?.GetValue<string>() != digest
                || result["id"]?.GetValue<string>() is not { } transfer || !EntityId.IsMatch(transfer)
                || MemberCredentials.FileSession()?.Scope != scope.Account) return null;
            if (!scope.Results.OfType<JsonObject>().Any(row => row["transferId"]?.GetValue<string>() == transfer))
            {
                scope.Results.Add(new JsonObject
                {
                    ["transferId"] = transfer, ["sha256"] = digest, ["sizeBytes"] = result["sizeBytes"]?.DeepClone(),
                    ["requestKey"] = requestKey,
                });
            }
            scope.Pending!.Remove(entry);
            SaveScope(scope.Capability, scope);
            File.Delete(encrypted);
            return new() { ["transferId"] = transfer };
        }
        finally { File.Delete(staged); }
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static bool FixedEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
    private static JsonObject Refused() => new() { ["error"] = "taskFileGrantUnavailable" };

    private static Scope? ReadScope(string id)
    {
        var path = Path.Combine(State, id + ".dpapi");
        if (!File.Exists(path)) return null;
        var data = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser);
        try { return JsonSerializer.Deserialize<Scope>(data, LinkProtocol.Json); }
        finally { CryptographicOperations.ZeroMemory(data); }
    }

    private static void SaveScope(string id, Scope scope)
    {
        Directory.CreateDirectory(State);
        var data = JsonSerializer.SerializeToUtf8Bytes(scope, LinkProtocol.Json);
        try { LinkIdentity.SaveAtomic(Path.Combine(State, id + ".dpapi"),
            ProtectedData.Protect(data, null, DataProtectionScope.CurrentUser)); }
        finally { CryptographicOperations.ZeroMemory(data); }
    }

    private static async Task<JsonObject> ReadAsync(Stream pipe, CancellationToken ct)
    {
        var frame = new byte[4];
        await pipe.ReadExactlyAsync(frame, ct);
        var bytes = BinaryPrimitives.ReadInt32BigEndian(frame);
        if (bytes is <= 0 or > MaxFrame) throw new InvalidDataException("Invalid task file frame");
        var body = new byte[bytes];
        await pipe.ReadExactlyAsync(body, ct);
        return JsonNode.Parse(body) as JsonObject ?? throw new InvalidDataException("Invalid task file request");
    }

    private static async Task WriteAsync(Stream pipe, JsonObject body, CancellationToken ct)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(body, WireJson);
        if (data.Length > MaxFrame) throw new InvalidDataException("Task file frame too large");
        var frame = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(frame, data.Length);
        await pipe.WriteAsync(frame, ct);
        await pipe.WriteAsync(data, ct);
        await pipe.FlushAsync(ct);
    }

    internal static async Task<int> RunMcpAsync(string pipePath, string key)
    {
        if (!pipePath.StartsWith(PipePrefix + "Steercrew.AgentLink.", StringComparison.Ordinal)
            || !pipePath.EndsWith(".task-files", StringComparison.Ordinal) || !HexKey.IsMatch(key)) return 2;
        var pipeName = pipePath[PipePrefix.Length..];
        using var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        await using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        while (await input.ReadLineAsync() is { } line)
        {
            if (line.Length > MaxMcpRequest) return 2;
            JsonNode? id = null;
            try
            {
                var request = JsonNode.Parse(line) as JsonObject;
                if (request?["id"] is not { } rpcId) continue;
                id = rpcId.DeepClone();
                var method = request["method"]?.GetValue<string>();
                JsonNode result = method switch
                {
                    "initialize" => JsonSerializer.SerializeToNode(new
                    {
                        protocolVersion = "2024-11-05",
                        capabilities = new { tools = new { } },
                        serverInfo = new { name = "sage-link", version = "1.0" },
                    })!,
                    "ping" => new JsonObject(),
                    "tools/list" => new JsonObject { ["tools"] = ToolList() },
                    "tools/call" => await CallToolAsync(pipeName, key, request["params"] as JsonObject ?? new()),
                    _ => throw new InvalidDataException("Unknown MCP request"),
                };
                await output.WriteLineAsync(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result }.ToJsonString());
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException
                or InvalidOperationException or OperationCanceledException or ArgumentException)
            {
                await output.WriteLineAsync(JsonSerializer.Serialize(new
                    { jsonrpc = "2.0", id, error = new { code = -32602, message = "Scoped file operation unavailable" } }));
            }
        }
        return 0;
    }

    private static JsonArray ToolList() => new(
        Tool("list", "List the encrypted file attached to this task"),
        Tool("receive", "Save the original attachment to a new path inside the task workspace", "transferId", "path"),
        Tool("send", "Encrypt and publish a workspace file to the task's original phone", "path"));

    private static JsonObject Tool(string name, string description, params string[] fields) => new()
    {
        ["name"] = name, ["description"] = description,
        ["inputSchema"] = JsonSerializer.SerializeToNode(new
        {
            type = "object", properties = fields.ToDictionary(field => field, _ => new { type = "string" }),
            required = fields, additionalProperties = false,
        }),
    };

    private static async Task<JsonNode> CallToolAsync(string name, string key, JsonObject parameters)
    {
        var tool = parameters["name"]?.GetValue<string>();
        var args = parameters["arguments"] as JsonObject ?? new();
        if (tool is not ("list" or "receive" or "send")) throw new InvalidDataException("Invalid tool");
        var safe = new JsonObject();
        var path = tool is "receive" or "send" ? WorkspacePath(args["path"]?.GetValue<string>(), tool == "receive") : null;
        if (tool == "send")
        {
            if (new FileInfo(path!).Length > MaxFileBytes) throw new InvalidDataException("File exceeds the task limit");
            safe["name"] = Path.GetFileName(path);
            safe["contents"] = Convert.ToBase64String(await File.ReadAllBytesAsync(path!));
        }
        if (tool == "receive") safe["transferId"] = args["transferId"]?.DeepClone();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(7));
        await using var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(1000, timeout.Token);
        await WriteAsync(pipe, new JsonObject
            { ["key"] = key, ["method"] = tool, ["arguments"] = safe }, timeout.Token);
        var result = await ReadAsync(pipe, timeout.Token);
        if (tool == "receive" && result["contents"] is JsonValue contents)
        {
            var bytes = Convert.FromBase64String(contents.GetValue<string>());
            var destination = WorkspacePath(path, true);
            await using var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            await file.WriteAsync(bytes, timeout.Token);
            await file.FlushAsync(timeout.Token);
            result.Remove("contents");
        }
        return JsonSerializer.SerializeToNode(new
        {
            isError = result["error"] is not null,
            content = new[] { new { type = "text", text = result.ToJsonString() } },
        })!;
    }

    private static string WorkspacePath(string? value, bool destination)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException("Workspace file required");
        var workingDirectory = Path.GetFullPath(Directory.GetCurrentDirectory());
        var full = Path.GetFullPath(value, workingDirectory);
        var relative = Path.GetRelativePath(workingDirectory, full);
        var parts = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (Path.IsPathRooted(relative) || parts.Any(part => part is "." or ".." || part.EndsWith('.') ||
            part.EndsWith(' ') || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
            throw new InvalidDataException("Path is outside the task workspace");
        var current = workingDirectory;
        foreach (var part in parts)
        {
            current = Path.Combine(current, part);
            if (File.Exists(current) || Directory.Exists(current))
                if (File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint))
                    throw new InvalidDataException("Reparse points are unavailable");
        }
        if (destination ? File.Exists(full) || Directory.Exists(full) || !Directory.Exists(Path.GetDirectoryName(full))
            : !File.Exists(full))
            throw new InvalidDataException("Workspace file unavailable");
        return full;
    }
}
