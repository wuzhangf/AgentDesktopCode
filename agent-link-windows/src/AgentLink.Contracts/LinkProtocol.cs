using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

public sealed record LinkRequest(string Operation, string? Id = null);
public sealed record LinkReply(bool Ok, string? Error = null, JsonNode? Data = null);
public sealed record LinkStatus(bool Ready, string Message, string Computer, string? Origin, int DeviceCount,
    int PendingCount, string? PersonalHostId, string? StoreId, int? GatewayPid, bool Enabled);

public static class LinkProtocol
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static string Root { get; } = StateRoot();

    public static string Instance { get; } = InstanceId();
    public static string Pipe => "Steercrew.AgentLink." + Instance;
    public static string HostLock => @"Global\Steercrew.AgentLink.Host." + Instance;
    public static string UiLock => @"Local\Steercrew.AgentLink.Tray." + Instance;
    public static string UiPipe => Pipe + ".tray." + System.Diagnostics.Process.GetCurrentProcess().SessionId;

    private static string StateRoot()
    {
        var configured = Environment.GetEnvironmentVariable("AGENT_LINK_WINDOWS_STATE");
        return Path.GetFullPath(string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Steercrew", "AgentLink")
            : configured);
    }

    private static string InstanceId()
    {
        using var user = WindowsIdentity.GetCurrent();
        var bytes = Encoding.UTF8.GetBytes(user.User!.Value + "\n" + Root.ToUpperInvariant().TrimEnd('\\'));
        return Convert.ToHexString(SHA256.HashData(bytes))[..24];
    }

    public static async Task<LinkReply> CallAsync(LinkRequest request, CancellationToken cancellation = default)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        await using var pipe = new NamedPipeClientStream(".", Pipe, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(750, deadline.Token);
        await WriteAsync(pipe, request, deadline.Token);
        return await ReadAsync<LinkReply>(pipe, deadline.Token);
    }

    public static async Task WriteAsync<T>(Stream stream, T value, CancellationToken cancellation)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        if (body.Length > 131072) throw new InvalidDataException("IPC response limit exceeded.");
        await stream.WriteAsync(BitConverter.GetBytes(body.Length), cancellation);
        await stream.WriteAsync(body, cancellation);
        await stream.FlushAsync(cancellation);
    }

    public static async Task<T> ReadAsync<T>(Stream stream, CancellationToken cancellation)
    {
        var prefix = new byte[sizeof(int)];
        await stream.ReadExactlyAsync(prefix, cancellation);
        var length = BitConverter.ToInt32(prefix);
        if (length is < 1 or > 131072) throw new InvalidDataException("Invalid IPC frame length.");
        var body = new byte[length];
        await stream.ReadExactlyAsync(body, cancellation);
        return JsonSerializer.Deserialize<T>(body, Json) ?? throw new InvalidDataException("Invalid IPC frame.");
    }
}
