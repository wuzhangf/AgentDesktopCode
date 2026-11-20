using System.Runtime.InteropServices;
using System.Text.Json;

namespace AgentLink;

public sealed record PayloadRelease(long BuildNumber, long ArchiveLength, string ArchiveSha256)
{
    internal void Validate()
    {
        if (BuildNumber is < 1 or > 9007199254740991 || ArchiveLength <= 0 ||
            ArchiveSha256 is null || ArchiveSha256.Length != 64 ||
            ArchiveSha256.Any(character => !char.IsAsciiHexDigitLower(character)))
            throw new InvalidDataException("Invalid Windows payload target.");
    }
}

public sealed record InstalledPayload(PayloadRelease Release, string Directory);

public enum ActivationStatus { Committed, Current, Busy, Rejected }

public sealed record PayloadActivationResult(ActivationStatus Status, InstalledPayload? Current);

/// <summary>Selects the runnable payload. The caller supplies trust evidence and an isolated health check.</summary>
public sealed class PayloadActivation(string root, Func<PayloadRelease, bool> isTrusted,
    Action<InstalledPayload>? verifyPublisher = null)
{
    private const int JournalLimit = 16 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string root = Path.GetFullPath(root);
    private string Slots => Path.Combine(root, "versions");
    private string Journal => Path.Combine(root, "activation.json");

    private sealed record State(int SchemaVersion, PayloadRelease? Current, PayloadRelease? Previous,
        PayloadRelease? Pending, PayloadRelease? Rejected);

    /// <summary>Revalidates the previous selection after an interrupted health check.</summary>
    public InstalledPayload? Recover()
    {
        using var locked = Lock();
        return Select(RecoverState());
    }

    /// <param name="quiesce">Returns a lease after blocking intake and stopping the old Host and its children.</param>
    /// <param name="probe">Uses only isolated state. The candidate must exit before the probe returns.</param>
    public async Task<PayloadActivationResult> ActivateAsync(PayloadRelease release, string archivePath,
        Func<CancellationToken, Task<IAsyncDisposable?>> quiesce,
        Func<InstalledPayload, CancellationToken, Task<bool>> probe, CancellationToken cancellation = default)
    {
        using var locked = Lock();
        var state = RecoverState();
        var current = Select(state);
        RequireTrusted(release);
        if (current is not null && release == current.Release)
            return new(ActivationStatus.Current, current);
        if (current is not null && release.BuildNumber <= current.Release.BuildNumber)
            throw new InvalidDataException("Windows payload activation cannot decrease the current build.");
        if (state.Rejected?.BuildNumber == release.BuildNumber)
            return new(ActivationStatus.Rejected, current);

        var candidate = Stage(release, archivePath);
        cancellation.ThrowIfCancellationRequested();
        await using var held = await quiesce(cancellation);
        if (held is null) return new(ActivationStatus.Busy, Select(state));

        RequireTrusted(release);
        if (state.Current is { } previous) RequireTrusted(previous);
        var pending = state with { Pending = release };
        Write(pending);
        if (!await probe(candidate, cancellation))
        {
            Write(pending with { Pending = null, Rejected = release });
            return new(ActivationStatus.Rejected, Select(state));
        }
        cancellation.ThrowIfCancellationRequested();
        // Recheck staged bytes and trust after the process exits, before opening business data.
        candidate = Open(release);
        Write(new(1, release, state.Current, null, null));
        return new(ActivationStatus.Committed, candidate);
    }

    private State RecoverState()
    {
        if (!File.Exists(Journal))
        {
            if (PathSafety.Exists(Journal)) throw new InvalidDataException("Invalid Windows activation journal.");
            return new(1, null, null, null, null);
        }
        PathSafety.RegularFile(Journal);
        State state;
        using (var stream = File.OpenRead(Journal))
        {
            if (stream.Length > JournalLimit) throw new InvalidDataException("Windows activation journal is oversized.");
            state = JsonSerializer.Deserialize<State>(stream, Json)
                ?? throw new InvalidDataException("Missing Windows activation journal.");
        }
        if (state.SchemaVersion != 1) throw new InvalidDataException("Unknown Windows activation journal schema.");
        state.Current?.Validate();
        state.Previous?.Validate();
        state.Pending?.Validate();
        state.Rejected?.Validate();
        if (state.Pending is null) return state;
        // Current remains untouched until the candidate has passed health and exited.
        var recovered = state with { Pending = null, Rejected = state.Pending };
        Write(recovered);
        return recovered;
    }

    private FileStream Lock()
    {
        PathSafety.DirectoryTree(root, create: true);
        PathSafety.DirectoryTree(Slots, create: true);
        var path = Path.Combine(root, "activation.lock");
        if (PathSafety.Exists(path)) PathSafety.RegularFile(path);
        return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }

    private void Write(State state)
    {
        if (PathSafety.Exists(Journal)) PathSafety.RegularFile(Journal);
        var temporary = Path.Combine(root, $".activation-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(file, state, Json);
                file.Flush(flushToDisk: true);
            }
            if (OperatingSystem.IsWindows())
            {
                const uint replaceExisting = 1;
                const uint writeThrough = 8;
                if (!MoveFileEx(temporary, Journal, replaceExisting | writeThrough))
                    throw new IOException("Unable to replace the Windows activation journal.",
                        new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
            }
            else File.Move(temporary, Journal, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }

    private string Slot(PayloadRelease release) => Path.Combine(Slots,
        release.BuildNumber.ToString(System.Globalization.CultureInfo.InvariantCulture));

    private void RequireTrusted(PayloadRelease release)
    {
        release.Validate();
        if (!isTrusted(release)) throw new InvalidDataException("Windows payload target is no longer trusted.");
    }

    private InstalledPayload Open(PayloadRelease release)
    {
        RequireTrusted(release);
        var slot = Slot(release);
        PathSafety.DirectoryTree(slot);
        var payload = Path.Combine(slot, "payload");
        PayloadArchive.Verify(Path.Combine(slot, "archive.zip"), payload, release);
        var selected = new InstalledPayload(release, payload);
        verifyPublisher?.Invoke(selected);
        return selected;
    }

    private InstalledPayload? Select(State state) => state.Current is { } release ? Open(release) : null;

    private InstalledPayload Stage(PayloadRelease release, string archivePath)
    {
        var slot = Slot(release);
        if (PathSafety.Exists(slot)) return Open(release);
        var staging = Path.Combine(Slots, $".staging-{Guid.NewGuid():N}");
        Directory.CreateDirectory(staging);
        try
        {
            PathSafety.RegularFile(archivePath);
            var saved = Path.Combine(staging, "archive.zip");
            using (var input = File.OpenRead(archivePath))
            {
                if (input.Length != release.ArchiveLength)
                    throw new InvalidDataException("Windows payload archive has the wrong length.");
                using var output = new FileStream(saved, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                input.CopyTo(output);
                output.Flush(flushToDisk: true);
            }
            PayloadArchive.Extract(saved, Path.Combine(staging, "payload"), release);
            verifyPublisher?.Invoke(new InstalledPayload(release, Path.Combine(staging, "payload")));
            Directory.Move(staging, slot);
            return new(release, Path.Combine(slot, "payload"));
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existing, string destination, uint flags);
}

internal static class PathSafety
{
    internal static bool Exists(string path) => Attributes(path) is not null;

    private static FileAttributes? Attributes(string path)
    {
        try { return File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    internal static void DirectoryTree(string path, bool create = false)
    {
        var current = new DirectoryInfo(Path.GetFullPath(path));
        var ancestors = new Stack<DirectoryInfo>();
        for (DirectoryInfo? ancestor = current; ancestor is not null; ancestor = ancestor.Parent)
            ancestors.Push(ancestor);
        foreach (var ancestor in ancestors)
        {
            if (Attributes(ancestor.FullName) is null && create)
                Directory.CreateDirectory(ancestor.FullName);
            if (Attributes(ancestor.FullName) is not { } attributes ||
                (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                throw new InvalidDataException("A Windows payload directory is absent or redirected.");
        }
    }

    internal static void RegularFile(string path)
    {
        if (Attributes(path) is not { } attributes ||
            (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint | FileAttributes.Device)) != 0)
            throw new InvalidDataException("A Windows payload file is absent or redirected.");
    }
}
