using System.Runtime.InteropServices;

namespace AgentLink;

internal sealed class AutomaticUpdatePolicy(WindowsUpdateSchedule schedule)
{
    internal string? Block(bool installation)
    {
        var preference = schedule.Preferences();
        if (!preference.Enabled) return "disabled";
        if (preference.PauseOnMetered && !UnrestrictedNetwork()) return "waiting-network";
        if (installation && !preference.AllowsInstallation(TimeOnly.FromDateTime(DateTime.Now))) return "waiting-window";
        return null;
    }

    private static bool UnrestrictedNetwork()
    {
        object? manager = null;
        try
        {
            var type = Type.GetTypeFromCLSID(new Guid("DCB00C01-570F-4A9B-8D69-199FDBA5723B"));
            manager = type is null ? null : Activator.CreateInstance(type);
            // GetCost with no destination reports the preferred Internet connection's cost.
            return manager is INetworkCostManager costManager &&
                costManager.GetCost(out var cost, IntPtr.Zero) == 0 && cost == 1;
        }
        catch (Exception error) when (error is COMException or InvalidCastException) { return false; }
        finally
        {
            if (manager is not null && Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
        }
    }

    [ComImport, Guid("DCB00008-570F-4A9B-8D69-199FDBA5723B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface INetworkCostManager
    {
        [PreserveSig]
        int GetCost(out uint cost, IntPtr destination);
    }
}

internal sealed class AutomaticUpdateDeferredException(string outcome) : IOException(outcome)
{
    internal string Outcome { get; } = outcome;
}
