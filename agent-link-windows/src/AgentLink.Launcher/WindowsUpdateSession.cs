using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;

namespace AgentLink;

internal sealed class WindowsUpdateSession(string operationId, bool seed) : IAsyncDisposable
{
    private readonly string snapshot = LinkUpdateTransition.SnapshotPath(operationId);
    private FileStream? transition;
    private bool ownsSnapshot;
    internal bool ShutdownAccepted { get; private set; }

    internal async Task<IAsyncDisposable?> PrepareAsync(CancellationToken cancellation)
    {
        transition = LinkUpdateTransition.Acquire(operationId);
        try
        {
            if (seed)
            {
                if (!Idle(LinkProtocol.HostLock) || !Idle(LinkProtocol.UiLock)) return null;
            }
            else
            {
                LinkReply reply;
                try { reply = await LinkProtocol.CallAsync(new("prepare-update", operationId), cancellation); }
                catch (Exception error) when (error is IOException or TimeoutException) { return null; }
                if (!reply.Ok) return null;
                ShutdownAccepted = true;
                var handedOff = reply.Data?.Deserialize<LinkUpdateHandoff>(LinkProtocol.Json);
                if (handedOff?.OperationId != operationId || handedOff.HostPid <= 0 || handedOff.GatewayPid <= 0)
                    throw new InvalidDataException("Invalid Windows Host shutdown reply.");
                await WaitForStoppedAsync(handedOff, cancellation);
                await CloseTrayAsync(cancellation);
            }

            if (!LinkUpdateTransition.Matches(operationId) || !Idle(LinkProtocol.HostLock) || !Idle(LinkProtocol.UiLock))
                return null;
            CopySnapshot();
            return this;
        }
        finally
        {
            if (!ownsSnapshot) await DisposeAsync();
        }
    }

    private static async Task WaitForStoppedAsync(LinkUpdateHandoff expected, CancellationToken cancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        while (true)
        {
            if (Idle(LinkProtocol.HostLock) && File.Exists(LinkUpdateTransition.StoppedReceipt))
            {
                using var file = File.OpenRead(LinkUpdateTransition.StoppedReceipt);
                if (file.Length > 16 * 1024) throw new InvalidDataException("Windows shutdown receipt is oversized.");
                var receipt = JsonSerializer.Deserialize<LinkUpdateHandoff>(file, LinkProtocol.Json);
                if (receipt == expected) return;
            }
            await Task.Delay(100, timeout.Token);
        }
    }

    private async Task CloseTrayAsync(CancellationToken cancellation)
    {
        if (Idle(LinkProtocol.UiLock)) return;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(6));
        await using (var pipe = new NamedPipeClientStream(".", LinkProtocol.UiPipe, PipeDirection.Out,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly))
        {
            await pipe.ConnectAsync(timeout.Token);
            await pipe.WriteAsync(new byte[] { 2 }, timeout.Token);
            await LinkProtocol.WriteAsync(pipe, operationId, timeout.Token);
        }
        while (!Idle(LinkProtocol.UiLock)) await Task.Delay(100, timeout.Token);
    }

    private void CopySnapshot()
    {
        var parent = Path.GetDirectoryName(snapshot)!;
        PathSafety.DirectoryTree(parent, create: true);
        if (Directory.Exists(snapshot) || File.Exists(snapshot))
            throw new IOException("The Windows update snapshot already exists.");
        Directory.CreateDirectory(snapshot);
        ownsSnapshot = true;
        var identity = Path.Combine(LinkProtocol.Root, "identity.dpapi");
        var store = Path.Combine(LinkProtocol.Root, "gateway");
        if (Directory.Exists(store) && !File.Exists(identity))
            throw new InvalidDataException("The original gateway is missing its identity.");
        if (File.Exists(identity)) CopyFile(identity, Path.Combine(snapshot, "identity.dpapi"));
        if (Directory.Exists(store)) CopyDirectory(store, Path.Combine(snapshot, "gateway"));
        if (!Idle(LinkProtocol.HostLock)) throw new IOException("The original Windows Host restarted during the snapshot.");
    }

    private static void CopyDirectory(string source, string destination)
    {
        CheckPath(source, directory: true);
        Directory.CreateDirectory(destination);
        foreach (var path in Directory.EnumerateFileSystemEntries(source))
        {
            var to = Path.Combine(destination, Path.GetFileName(path));
            if (Directory.Exists(path)) CopyDirectory(path, to);
            else CopyFile(path, to);
        }
    }

    private static void CopyFile(string source, string destination)
    {
        CheckPath(source, directory: false);
        using var original = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var copy = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        original.CopyTo(copy);
    }

    private static void CheckPath(string path, bool directory)
    {
        var flags = File.GetAttributes(path);
        if ((flags & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0 ||
            flags.HasFlag(FileAttributes.Directory) != directory)
            throw new InvalidDataException("The Windows update snapshot traverses a redirected path.");
    }

    private static bool Idle(string name)
    {
        if (!Mutex.TryOpenExisting(name, out var mutex)) return true;
        using (mutex)
        {
            try { if (!mutex.WaitOne(0)) return false; }
            catch (AbandonedMutexException) { }
            mutex.ReleaseMutex();
            return true;
        }
    }

    internal async Task<bool> ProbeAsync(InstalledPayload candidate, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo(Path.Combine(candidate.Directory, "host", "AgentLink.Host.exe"))
            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = candidate.Directory };
        start.ArgumentList.Add(seed ? "--probe-seed" : "--probe-update");
        start.ArgumentList.Add(operationId);
        using var process = Process.Start(start) ?? throw new IOException("Windows candidate probe did not start.");
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(68));
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode == 0;
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        try
        {
            if (ownsSnapshot)
            {
                ownsSnapshot = false;
                Program.DeletePrivateDirectory(snapshot);
            }
        }
        finally
        {
            transition?.Dispose();
            transition = null;
        }
        return ValueTask.CompletedTask;
    }
}
