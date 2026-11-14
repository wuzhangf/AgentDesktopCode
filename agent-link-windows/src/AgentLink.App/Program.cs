using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Threading;

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
        TrayMenuWindow? menu = null;
        using var icon = new TrayIcon();
        panel.SizeChanged += (_, _) => icon.PositionPanel(panel);
        void ShowPanel()
        {
            menu?.Hide();
            panel.CancelDismissal();
            if (panel.IsVisible) panel.Activate();
            else icon.ShowPanel(panel);
            _ = panel.RefreshAsync();
        }
        icon.ToggleRequested += () =>
        {
            menu?.Hide();
            if (panel.IsVisible) panel.Hide();
            else if (!panel.JustDismissed) ShowPanel();
        };
        var menuBuilding = false;
        icon.MenuRequested += async _ =>
        {
            panel.Hide();
            if (menuBuilding) return;
            menuBuilding = true;
            try
            {
                var snapshot = await FetchSnapshotAsync();
                if (menu is null)
                    menu = new TrayMenuWindow(TrayMenuModel.Build(snapshot), DispatchAsync);
                else
                    menu.Show(TrayMenuModel.Build(snapshot));
                icon.ShowPanel(menu);
            }
            finally { menuBuilding = false; }
        };

        async Task RefreshMenuAsync()
        {
            if (menu is { IsVisible: true })
                menu.Show(TrayMenuModel.Build(await FetchSnapshotAsync()));
        }

        async Task DispatchAsync(TrayMenuEntry entry)
        {
            switch (entry.Action)
            {
                case "open": ShowPanel(); break;
                case "openAgents": ShowPanel(); panel.OpenAgentTab(); break;
                case "openSettings": ShowPanel(); panel.OpenSettings(); break;
                case "inviteQr": ShowPanel(); panel.BeginInvite(); break;
                case "inviteCopy": await CopyInviteAsync(); break;
                case "togglePhone":
                    await CallQuietAsync(new(entry.Checked ? "disable" : "enable"));
                    await RefreshMenuAsync();
                    break;
                case "approve" or "reject" when entry.Id is { } id:
                    await CallQuietAsync(new(entry.Action, id));
                    await RefreshMenuAsync();
                    break;
                case "attachWorker" when entry.Id is { } path:
                    await CallQuietAsync(new("worker", path), showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "workerPick": ShowPanel(); panel.BeginWorkerPick(); break;
                case "member" when entry.Id is { } op:
                    await CallQuietAsync(new(op));
                    await RefreshMenuAsync();
                    break;
                case "refresh": await RefreshMenuAsync(); break;
                case "exit":
                    if (MessageBox.Show("退出后，手机将暂时无法连接这台电脑。", "Agent Link",
                        MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                    try { await LinkProtocol.CallAsync(new("exit")); }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                    app.Shutdown();
                    break;
            }
        }

        async Task CallQuietAsync(LinkRequest request, bool showPanelOnError = false)
        {
            try
            {
                var reply = await LinkProtocol.CallAsync(request);
                if (!reply.Ok && showPanelOnError) ShowPanel();
            }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
            if (panel.IsVisible) await panel.RefreshAsync();
        }

        static async Task<TraySnapshot> FetchSnapshotAsync()
        {
            var workers = EnumerateWorkerCards();
            var current = ReadCurrentWorkerPath();
            try
            {
                var reply = await LinkProtocol.CallAsync(new("status"));
                var status = reply.Data?.Deserialize<LinkStatus>(LinkProtocol.Json);
                if (!reply.Ok || status is null) return new(false, null, null, null, workers, current);
                JsonArray? devices = null;
                JsonArray? requests = null;
                if (status.Ready)
                {
                    try { devices = (await LinkProtocol.CallAsync(new("devices"))).Data as JsonArray; }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                }
                if (status.PendingCount > 0)
                {
                    try { requests = (await LinkProtocol.CallAsync(new("requests"))).Data as JsonArray; }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                }
                return new(true, status, devices, requests, workers, current);
            }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException)
            {
                return new(false, null, null, null, workers, current);
            }
        }

        static string? ReadCurrentWorkerPath()
        {
            try
            {
                var file = Path.Combine(LinkProtocol.Root, "worker-card.path");
                var text = File.Exists(file) ? File.ReadAllText(file).Trim() : null;
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
        }

        static List<TrayWorkerCard> EnumerateWorkerCards()
        {
            var cards = new List<TrayWorkerCard>();
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".agent-gateway", "workers.d");
            if (!Directory.Exists(dir)) return cards;
            foreach (var file in Directory.EnumerateFiles(dir, "*.json").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(file));
                    var name =
                        doc.RootElement.TryGetProperty("displayName", out var display) && display.GetString() is { Length: > 0 } shown ? shown :
                        doc.RootElement.TryGetProperty("connectionId", out var connection) && connection.GetString() is { Length: > 0 } id ? id :
                        Path.GetFileNameWithoutExtension(file);
                    cards.Add(new(Path.GetFullPath(file), name));
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
            }
            return cards;
        }

        async Task CopyInviteAsync()
        {
            try
            {
                var reply = await LinkProtocol.CallAsync(new("invite"));
                if (reply.Ok && reply.Data is { } payload)
                    Clipboard.SetText(payload.ToJsonString(LinkProtocol.Json));
                else
                    ShowPanel();
            }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
        }
        var health = new DispatcherTimer { Interval = TimeSpan.FromSeconds(10) };
        var checking = false;
        var misses = 0;
        DateTimeOffset retryAt = default;
        health.Tick += async (_, _) =>
        {
            icon.EnsureRegistered();
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
