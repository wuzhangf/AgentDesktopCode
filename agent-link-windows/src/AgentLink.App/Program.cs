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
                case "revokeDevice" when entry.Id is { } deviceId:
                    await CallQuietAsync(new("revokeDevice", deviceId), showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "attachWorker" when entry.Id is { } path:
                    await CallQuietAsync(new("worker", path), showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "detachWorker":
                    await CallQuietAsync(new("detachWorker", entry.Id), showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "testWorker" when entry.Id is { } testPath:
                    try
                    {
                        var reply = await LinkProtocol.CallAsync(new("testWorker", testPath));
                        var name = WorkerNameFor(testPath);
                        ShowPanel();
                        panel.ShowWorkerNotice(reply.Ok
                            ? $"✓ {name} · 引擎可用"
                            : $"✗ {name} · {reply.Error ?? "测试失败"}");
                    }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException)
                    {
                        ShowPanel();
                        panel.ShowWorkerNotice("后台暂不可用，无法测试。");
                    }
                    break;
                case "browseWorker" when entry.Id is { } dir:
                    try
                    {
                        if (Path.IsPathFullyQualified(dir) && Directory.Exists(dir))
                            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{dir}\"") { UseShellExecute = true });
                    }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception) { }
                    break;
                case "workerPick": ShowPanel(); panel.BeginWorkerPick(); break;
                case "agentAdd": ShowPanel(); panel.BeginAgentRegister(); break;
                case "agentEnable" or "agentDisable" when entry.Id is { } key:
                    await CallQuietAsync(new("agentSet", key,
                        new JsonObject { ["enabled"] = entry.Action == "agentEnable" }),
                        showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "agentSkip" when entry.Id is { } skipKey:
                    await CallQuietAsync(new("agentSet", skipKey,
                        new JsonObject { ["skipPermissions"] = !entry.Checked }),
                        showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "agentRemove" when entry.Id is { } removeKey:
                    if (MessageBox.Show("移除后此工作区注册将从列表中删除（目录文件不受影响）。",
                        "Agent Link", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                    await CallQuietAsync(new("agentRemove", removeKey), showPanelOnError: true);
                    await RefreshMenuAsync();
                    break;
                case "agentTest" when entry.Id is { } testKey:
                    try
                    {
                        var reply = await LinkProtocol.CallAsync(new("agentTest", testKey));
                        ShowPanel();
                        panel.ShowWorkerNotice(reply.Ok ? "✓ 引擎可用" : $"✗ {reply.Error ?? "测试失败"}");
                    }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException)
                    {
                        ShowPanel();
                        panel.ShowWorkerNotice("后台暂不可用，无法测试。");
                    }
                    break;
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
            var workers = WorkerCards.Enumerate();
            var current = WorkerCards.CurrentPaths();
            foreach (var path in current.Where(p => workers.All(c =>
                !string.Equals(c.Path, p, StringComparison.OrdinalIgnoreCase))))
                if (WorkerCards.TryRead(path) is { } attached) workers.Add(attached);
            try
            {
                var reply = await LinkProtocol.CallAsync(new("status"));
                var status = reply.Data?.Deserialize<LinkStatus>(LinkProtocol.Json);
                if (!reply.Ok || status is null) return new(false, null, null, null, workers, current);
                JsonArray? devices = null;
                JsonArray? requests = null;
                List<ManagedAgent>? managed = null;
                if (status.Ready)
                {
                    try { devices = (await LinkProtocol.CallAsync(new("devices"))).Data as JsonArray; }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                    try
                    {
                        managed = (await LinkProtocol.CallAsync(new("managedAgents"))).Data
                            ?.Deserialize<List<ManagedAgent>>(LinkProtocol.Json);
                    }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                }
                if (status.PendingCount > 0)
                {
                    try { requests = (await LinkProtocol.CallAsync(new("requests"))).Data as JsonArray; }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                }
                return new(true, status, devices, requests, workers, current, managed);
            }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException)
            {
                return new(false, null, null, null, workers, current);
            }
        }

        string? WorkerNameFor(string path) =>
            WorkerCards.Enumerate().FirstOrDefault(c =>
                string.Equals(c.Path, path, StringComparison.OrdinalIgnoreCase))?.Name
            ?? Path.GetFileNameWithoutExtension(path);

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
        var cardRefresh = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        cardRefresh.Tick += async (_, _) =>
        {
            cardRefresh.Stop();
            await RefreshMenuAsync();
            if (panel.IsVisible) _ = panel.RefreshAsync();
        };
        var cardWatchers = new List<FileSystemWatcher>();
        void EnsureCardWatchers()
        {
            foreach (var dir in WorkerCards.Dirs())
            {
                if (!Directory.Exists(dir) || cardWatchers.Any(w =>
                    string.Equals(w.Path, dir, StringComparison.OrdinalIgnoreCase))) continue;
                var watcher = new FileSystemWatcher(dir) { Filter = "*.json", EnableRaisingEvents = true };
                void Queue(object _, FileSystemEventArgs e) { cardRefresh.Stop(); cardRefresh.Start(); }
                watcher.Created += Queue;
                watcher.Deleted += Queue;
                watcher.Changed += Queue;
                watcher.Renamed += (_, _) => { cardRefresh.Stop(); cardRefresh.Start(); };
                cardWatchers.Add(watcher);
            }
        }
        EnsureCardWatchers();
        var health = new DispatcherTimer { Interval = TimeSpan.FromSeconds(10) };
        var checking = false;
        var misses = 0;
        DateTimeOffset retryAt = default;
        health.Tick += async (_, _) =>
        {
            icon.EnsureRegistered();
            EnsureCardWatchers();
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
