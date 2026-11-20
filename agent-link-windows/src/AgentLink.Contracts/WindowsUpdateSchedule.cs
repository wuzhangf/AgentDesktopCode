using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentLink;

public sealed record WindowsUpdatePreferences(
    [property: JsonRequired] bool Enabled,
    [property: JsonRequired] bool PauseOnMetered,
    TimeOnly? WindowStart,
    TimeOnly? WindowEnd)
{
    internal static readonly WindowsUpdatePreferences Default = new(true, true, null, null);
    internal bool Valid => WindowStart is null ? WindowEnd is null : WindowEnd is not null && WindowStart != WindowEnd;

    public bool AllowsInstallation(TimeOnly localTime)
    {
        if (!Valid) return false;
        if (WindowStart is not { } start || WindowEnd is not { } end) return true;
        return start < end ? localTime >= start && localTime < end : localTime >= start || localTime < end;
    }
}

public sealed record WindowsUpdateState(DateTimeOffset NextCheckUtc, DateTimeOffset? LastCheckUtc, string Outcome);

public sealed class WindowsUpdateSchedule(string directory)
{
    private static readonly JsonSerializerOptions Json = JsonSerializerOptions.Web;
    private string PreferencesPath => Path.Combine(directory, "windows-update-preferences.json");
    private string StatePath => Path.Combine(directory, "windows-update-schedule.json");

    public WindowsUpdatePreferences Preferences()
    {
        try
        {
            if (Read<WindowsUpdatePreferences>(PreferencesPath) is { Valid: true } preferences) return preferences;
        }
        catch (FileNotFoundException) { return WindowsUpdatePreferences.Default; }
        catch (DirectoryNotFoundException) { return WindowsUpdatePreferences.Default; }
        catch (Exception error) when (SettingsError(error)) { }
        return WindowsUpdatePreferences.Default with { Enabled = false };
    }

    public void Save(WindowsUpdatePreferences preferences)
    {
        if (!preferences.Valid) throw new InvalidDataException("Invalid Windows update maintenance window.");
        Write(PreferencesPath, preferences);
    }

    public WindowsUpdateState? State()
    {
        try
        {
            return Read<WindowsUpdateState>(StatePath) is { NextCheckUtc: var next, Outcome.Length: > 0 } state
                && next != default ? state : null;
        }
        catch (Exception error) when (SettingsError(error)) { return null; }
    }

    public bool CanStart(DateTimeOffset now)
    {
        var preferences = Preferences();
        return preferences.Enabled && State() is { } state && now >= state.NextCheckUtc &&
            (state.Outcome != "waiting-window" || preferences.AllowsInstallation(TimeOnly.FromDateTime(now.LocalDateTime)));
    }

    public void Initialize(DateTimeOffset now, int jitterMinutes)
    {
        if (State() is null) Write(StatePath, new WindowsUpdateState(now.AddMinutes(jitterMinutes), null, "scheduled"));
    }

    public void Record(DateTimeOffset checkedAt, DateTimeOffset finishedAt, string outcome, int jitterMinutes)
    {
        var delay = outcome is "checking" or "busy" or "waiting-window" or "waiting-network" or "recovered" or "download-deferred"
            ? TimeSpan.FromMinutes(15)
            : TimeSpan.FromDays(1) + TimeSpan.FromMinutes(jitterMinutes);
        Write(StatePath, new WindowsUpdateState(finishedAt + delay, checkedAt, outcome));
    }

    private static T? Read<T>(string path)
    {
        CheckPath(path);
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        if (stream.Length > 4096) throw new InvalidDataException("Windows update settings are oversized.");
        return JsonSerializer.Deserialize<T>(stream, Json);
    }

    private void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(directory);
        try { CheckPath(path); }
        catch (FileNotFoundException) { }
        var temporary = Path.Combine(directory, $".windows-update-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, value, Json);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }

    private static void CheckPath(string path)
    {
        if ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint | FileAttributes.Device)) != 0)
            throw new InvalidDataException("Invalid Windows update settings path.");
    }

    private static bool SettingsError(Exception error) =>
        error is IOException or UnauthorizedAccessException or InvalidDataException or JsonException;
}
