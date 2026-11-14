using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Windows;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace AgentLink;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--autostart-on"] or ["--autostart-off"])
        {
            StartupEntry.Set(args[0] == "--autostart-on");
            return 0;
        }
        var background = args is ["--background"];
        if (background && StartupEntry.DisabledByWindows()) return 0;
        using var mutex = new Mutex(false, LinkProtocol.UiLock);
        var existing = false;
        try { existing = !mutex.WaitOne(0); }
        catch (AbandonedMutexException) { }
        if (existing)
        {
            if (!background)
            {
                try
                {
                    using var pipe = new NamedPipeClientStream(".", LinkProtocol.UiPipe, PipeDirection.Out,
                        PipeOptions.CurrentUserOnly);
                    pipe.Connect(2000);
                    pipe.WriteByte(1);
                }
                catch (IOException) { }
                catch (TimeoutException) { }
            }
            return 0;
        }

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(app.Dispatcher));
        using var stopping = new CancellationTokenSource();
        var panel = new LinkWindow();
        using var menu = new Forms.ContextMenuStrip();
        using var icon = new Forms.NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "Agent Link",
            ContextMenuStrip = menu,
            Visible = true,
        };
        void ShowPanel()
        {
            if (panel.WindowState == WindowState.Minimized) panel.WindowState = WindowState.Normal;
            if (!panel.IsVisible)
            {
                var area = SystemParameters.WorkArea;
                panel.Left = Math.Max(area.Left, area.Right - panel.Width - 12);
                panel.Top = Math.Max(area.Top, area.Bottom - panel.Height - 12);
                panel.Show();
            }
            panel.Activate();
            _ = panel.RefreshAsync();
        }
        icon.MouseClick += (_, e) =>
        {
            if (e.Button != Forms.MouseButtons.Left) return;
            if (panel.IsVisible) panel.Hide();
            else ShowPanel();
        };
        menu.Items.Add("打开 Agent Link", null, (_, _) => ShowPanel());
        menu.Items.Add("设置", null, (_, _) => { ShowPanel(); panel.OpenSettings(); });
        menu.Items.Add("退出 Agent Link…", null, async (_, _) =>
        {
            if (MessageBox.Show("退出后，手机将暂时无法连接这台电脑。", "Agent Link",
                MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            try { await LinkProtocol.CallAsync(new("exit")); }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
            app.Shutdown();
        });
        var health = new DispatcherTimer { Interval = TimeSpan.FromSeconds(10) };
        var checking = false;
        var misses = 0;
        DateTimeOffset retryAt = default;
        health.Tick += async (_, _) =>
        {
            if (checking) return;
            checking = true;
            try
            {
                var reply = await LinkProtocol.CallAsync(new("status"));
                if (reply.Ok) misses = 0;
            }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException)
            {
                if (++misses >= 2 && DateTimeOffset.UtcNow >= retryAt)
                {
                    StartHost();
                    retryAt = DateTimeOffset.UtcNow.AddSeconds(30);
                }
            }
            finally { checking = false; }
        };
        StartHost();
        _ = ListenForActivationAsync(app.Dispatcher, ShowPanel, stopping.Token);
        if (!background) ShowPanel();
        health.Start();
        app.Run();
        health.Stop();
        stopping.Cancel();
        mutex.ReleaseMutex();
        return 0;
    }

    private static async Task ListenForActivationAsync(Dispatcher dispatcher, Action show, CancellationToken cancellation)
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                await using var pipe = new NamedPipeServerStream(LinkProtocol.UiPipe, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(cancellation);
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                deadline.CancelAfter(TimeSpan.FromSeconds(2));
                var signal = new byte[1];
                try
                {
                    if (await pipe.ReadAsync(signal, deadline.Token) == 1 && signal[0] == 1)
                        await dispatcher.InvokeAsync(show);
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private static void StartHost()
    {
        using var child = Process.Start(new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "host", "AgentLink.Host.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true,
        });
    }
}
