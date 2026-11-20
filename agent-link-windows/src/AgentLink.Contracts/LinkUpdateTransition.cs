using System.Text;

namespace AgentLink;

public sealed record LinkUpdateIdentity(string PersonalHostId, string StoreId, int DeviceCount);
public sealed record LinkUpdateHandoff(string OperationId, int HostPid, int GatewayPid, string GatewayBootId,
    LinkUpdateIdentity Identity);

/// <summary>The launcher holds this handle through selection, shutdown and recovery.</summary>
public static class LinkUpdateTransition
{
    private static string LockPath => Path.Combine(LinkProtocol.Root, "update-transition.lock");
    public static string StoppedReceipt => Path.Combine(LinkProtocol.Root, "update-stopped.json");

    public static bool ValidOperationId(string? operationId) =>
        operationId is { Length: > 0 and <= 128 } &&
        operationId.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-');

    public static string SnapshotPath(string operationId)
    {
        if (!ValidOperationId(operationId)) throw new ArgumentException("Invalid update operation ID.", nameof(operationId));
        return Path.Combine(LinkProtocol.Root, "update-probes", "operation-" + operationId);
    }

    public static FileStream Acquire(string operationId)
    {
        if (!ValidOperationId(operationId)) throw new ArgumentException("Invalid update operation ID.", nameof(operationId));
        Directory.CreateDirectory(LinkProtocol.Root);
        // Allow the Host to read the operation ID. Other writers still conflict
        // while this handle remains open.
        var file = new FileStream(LockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
        try
        {
            file.SetLength(0);
            file.Write(Encoding.ASCII.GetBytes(operationId));
            file.Flush(flushToDisk: true);
            return file;
        }
        catch
        {
            file.Dispose();
            throw;
        }
    }

    public static bool Matches(string operationId)
    {
        if (!ValidOperationId(operationId) || !IsHeld()) return false;
        using var file = new FileStream(LockPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (file.Length != operationId.Length) return false;
        Span<byte> bytes = stackalloc byte[operationId.Length];
        file.ReadExactly(bytes);
        return Encoding.ASCII.GetString(bytes) == operationId && IsHeld();
    }

    public static bool IsHeld()
    {
        try
        {
            using var unlocked = new FileStream(LockPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
            return false;
        }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33) { return true; }
    }
}
