using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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

public sealed record PayloadSelection(PayloadRelease? Committed, InstalledPayload? Runnable);

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

    /// <summary>Retains the committed build as a repair floor even when its files cannot safely run.</summary>
    public PayloadSelection Inspect()
    {
        using var locked = Lock();
        var state = RecoverState();
        Prune(state);
        return new(state.Current, SelectForRepair(state));
    }

    /// <param name="quiesce">Returns a lease after blocking intake and stopping the old Host and its children.</param>
    /// <param name="probe">Uses only isolated state. The candidate must exit before the probe returns.</param>
    public async Task<PayloadActivationResult> ActivateAsync(PayloadRelease release, string archivePath,
        Func<CancellationToken, Task<IAsyncDisposable?>> quiesce,
        Func<InstalledPayload, CancellationToken, Task<bool>> probe, CancellationToken cancellation = default,
        Func<CancellationToken, Task>? confirmCommit = null, bool repair = false)
    {
        using var locked = Lock();
        var state = RecoverState();
        var current = repair ? SelectForRepair(state) : Select(state);
        if (repair && (state.Current is null || confirmCommit is null))
            throw new InvalidDataException("Windows repair requires a committed build and a fresh trust check.");
        RequireTrusted(release);
        if (current is not null && release == current.Release)
            return new(ActivationStatus.Current, current);
        if (state.Current is { } committed && release.BuildNumber <= committed.BuildNumber)
            throw new InvalidDataException("Windows payload activation cannot decrease the current build.");
        if (state.Rejected?.BuildNumber == release.BuildNumber)
            return new(ActivationStatus.Rejected, current);

        Prune(state, retainCandidate: release);
        try
        {
            var candidate = Stage(release, archivePath);
            cancellation.ThrowIfCancellationRequested();
            await using var held = await quiesce(cancellation);
            if (held is null) return new(ActivationStatus.Busy, repair ? SelectForRepair(state) : Select(state));

            RequireTrusted(release);
            if (current is not null) RequireTrusted(current.Release);
            var original = state;
            Persist(state with { Pending = release });
            if (!await probe(candidate, cancellation))
            {
                Persist(state with { Pending = null, Rejected = release });
                return new(ActivationStatus.Rejected, repair ? SelectForRepair(state) : Select(state));
            }
            try
            {
                if (confirmCommit is not null) await confirmCommit(cancellation);
            }
            catch
            {
                Persist(original);
                throw;
            }
            cancellation.ThrowIfCancellationRequested();
            // Recheck staged bytes and trust after the process exits, before opening business data.
            candidate = Open(release);
            var previous = current is not null && isTrusted(current.Release) ? current.Release : null;
            Persist(new(1, release, previous, null, null));
            return new(ActivationStatus.Committed, candidate);
        }
        finally { Prune(state); }

        void Persist(State next)
        {
            Write(next);
            state = next;
        }
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
            PathSafety.ReplaceFile(temporary, Journal);
        }
        finally { File.Delete(temporary); }
    }

    private static string SlotName(PayloadRelease release) => release.BuildNumber.ToString(CultureInfo.InvariantCulture);

    private string Slot(PayloadRelease release) => Path.Combine(Slots, SlotName(release));

    private void Prune(State state, PayloadRelease? retainCandidate = null)
    {
        var keep = new HashSet<string>(StringComparer.Ordinal);
        if (state.Current is { } current) keep.Add(SlotName(current));
        if (state.Previous is { } previous && isTrusted(previous)) keep.Add(SlotName(previous));
        if (state.Pending is { } pending) keep.Add(SlotName(pending));
        if (retainCandidate is not null) keep.Add(SlotName(retainCandidate));
        try
        {
            foreach (var directory in Directory.EnumerateDirectories(Slots))
            {
                var name = Path.GetFileName(directory);
                if (keep.Contains(name)) continue;
                var version = long.TryParse(name, NumberStyles.None, CultureInfo.InvariantCulture, out var build) &&
                    build is > 0 and <= 9007199254740991 && name == build.ToString(CultureInfo.InvariantCulture);
                if (version || PathSafety.IsOperationDirectory(name, ".staging-"))
                    PathSafety.TryDeleteDirectory(directory);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

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

    private InstalledPayload? SelectForRepair(State state)
    {
        try { return Select(state); }
        catch (Exception error) when (error is InvalidDataException or IOException or UnauthorizedAccessException or
            CryptographicException or JsonException) { return null; }
    }

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

}

internal static class PathSafety
{
    internal static bool Exists(string path) => Attributes(path) is not null;

    internal static bool IsOperationDirectory(string name, string prefix) =>
        name.StartsWith(prefix, StringComparison.Ordinal) && Guid.TryParseExact(name.AsSpan(prefix.Length), "N", out _);

    internal static void TryDeleteDirectory(string path)
    {
        // Directory.Delete removes reparse points without descending into their targets.
        try { Directory.Delete(path, recursive: true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    internal static void ReplaceFile(string temporary, string destination)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.Move(temporary, destination, overwrite: true);
            return;
        }
        const uint replaceExisting = 1;
        const uint writeThrough = 8;
        if (!MoveFileEx(temporary, destination, replaceExisting | writeThrough))
            throw new IOException("Unable to replace Windows update state.",
                new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
    }

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existing, string destination, uint flags);

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
