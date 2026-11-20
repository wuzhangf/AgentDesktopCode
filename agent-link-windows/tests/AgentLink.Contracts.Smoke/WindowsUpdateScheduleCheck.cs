using AgentLink;

internal static class WindowsUpdateScheduleCheck
{
    internal static void Run()
    {
        var root = Directory.CreateTempSubdirectory("agent-link-update-schedule");
        try
        {
            var schedule = new WindowsUpdateSchedule(root.FullName);
            var now = new DateTimeOffset(2026, 11, 21, 12, 0, 0, TimeSpan.Zero);
            Check(schedule.Preferences() is { Enabled: true, PauseOnMetered: true }, "first run enables daily checks with network protection");
            Check(!schedule.CanStart(now), "the launcher must initialize the schedule");
            schedule.Initialize(now, 23);
            schedule.Initialize(now, 1);
            Check(!schedule.CanStart(now.AddMinutes(22)) && schedule.CanStart(now.AddMinutes(23)),
                "first check waits for persisted jitter");

            var night = new WindowsUpdatePreferences(true, true, new(23, 30), new(2, 0));
            Check(night.AllowsInstallation(new(23, 30)) && night.AllowsInstallation(new(0, 30)) &&
                !night.AllowsInstallation(new(2, 0)), "the window crosses midnight and excludes its end");
            schedule.Save(night);
            Check(schedule.Preferences() == night, "window and network setting round trip");
            schedule.Record(now, now, "waiting-window", 0);
            var localNoon = new DateTimeOffset(TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local).Date.AddDays(1).AddHours(12),
                TimeZoneInfo.Local.GetUtcOffset(now.AddDays(1)));
            Check(!schedule.CanStart(localNoon) && schedule.CanStart(localNoon.AddHours(12)), "retry waits for the window");
            schedule.Save(night with { Enabled = false });
            Check(!schedule.CanStart(localNoon.AddHours(12)), "disabling automatic checks takes effect immediately");
            schedule.Save(night with { WindowStart = null, WindowEnd = null });
            schedule.Record(now, now, "checking", 0);
            Check(!schedule.CanStart(now.AddMinutes(14)) && schedule.CanStart(now.AddMinutes(15)),
                "an interrupted verifier has a bounded retry");
            schedule.Record(now, now, "deferred", -11);
            Check(!schedule.CanStart(now.AddMinutes(1428)) && schedule.CanStart(now.AddMinutes(1429)),
                "normal checks use a day plus jitter");
            File.WriteAllText(Path.Combine(root.FullName, "windows-update-preferences.json"), "{\"enabled\":true}");
            Check(!schedule.Preferences().Enabled, "incomplete settings pause the schedule");
        }
        finally { root.Delete(recursive: true); }
    }

    private static void Check(bool passed, string description)
    {
        if (!passed) throw new InvalidOperationException(description);
    }
}
