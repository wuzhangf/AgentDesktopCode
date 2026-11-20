using Microsoft.Win32;

namespace AgentLink;

internal static class StartupEntry
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    private const string Name = "Steercrew.AgentLink";

    private static string Command => "\"" + (LauncherPath ?? Environment.ProcessPath) + "\" --background";

    internal static string? LauncherPath =>
        Environment.GetEnvironmentVariable("AGENT_LINK_WINDOWS_LAUNCHER") is { } launcher &&
        System.IO.Path.IsPathFullyQualified(launcher) && System.IO.File.Exists(launcher)
            ? launcher
            : null;

    internal static bool UpdatesAvailable => Environment.GetEnvironmentVariable("AGENT_LINK_WINDOWS_UPDATE_AVAILABLE") == "1" &&
        LauncherPath is not null;

    internal static bool ScheduledUpdatesAvailable => UpdatesAvailable &&
        Environment.GetEnvironmentVariable("AGENT_LINK_WINDOWS_SCHEDULE_AVAILABLE") == "1";

    internal static bool Registered()
    {
        using var key = Registry.CurrentUser.OpenSubKey(Key);
        return string.Equals(key?.GetValue(Name) as string, Command, StringComparison.OrdinalIgnoreCase);
    }

    internal static bool DisabledByWindows()
    {
        using var key = Registry.CurrentUser.OpenSubKey(ApprovedKey);
        return key?.GetValue(Name) is byte[] { Length: > 0 } state && state[0] is 3 or 7;
    }

    internal static void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(Key);
        if (!enabled)
        {
            if (Registered()) key.DeleteValue(Name, false);
            return;
        }
        if (Command.Length > 260) throw new InvalidOperationException("安装路径超过 Windows 登录项的长度限制。");
        key.SetValue(Name, Command);
    }
}
