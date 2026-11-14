using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AgentLink;

internal sealed class OwnedProcess : IDisposable
{
    private readonly SafeFileHandle job;
    internal Process Process { get; }

    internal OwnedProcess(ProcessStartInfo start)
    {
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try
        {
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<ExtendedLimits>()))
                throw new Win32Exception();
            Process = Process.Start(start) ?? throw new InvalidOperationException("Gateway did not start.");
            try
            {
                // The bundled Node preload waits for this line before loading the gateway.
                if (!AssignProcessToJobObject(job, Process.Handle)) throw new Win32Exception();
                Process.StandardInput.WriteLine("start");
                Process.StandardInput.Flush();
            }
            catch
            {
                if (!Process.HasExited) Process.Kill();
                Process.Dispose();
                throw;
            }
        }
        catch
        {
            job.Dispose();
            throw;
        }
    }

    internal async Task StopAsync()
    {
        if (Process.HasExited) return;
        Process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(7));
        try { await Process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            job.Dispose();
            using var forced = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await Process.WaitForExitAsync(forced.Token);
        }
    }

    public void Dispose()
    {
        job.Dispose();
        Process.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits value, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
