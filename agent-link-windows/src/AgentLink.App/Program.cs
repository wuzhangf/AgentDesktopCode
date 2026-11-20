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
        if (background && Environment.GetEnvironmentVariable("AGENT_LINK_WINDOWS_RESUMING_UPDATE") != "1" &&
            StartupEntry.DisabledByWindows()) return 0;
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
        ConfigurationWindow? configuration = null;
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
        void ShowPhone()
        {
            panel.OpenConnectionTab();
            ShowPanel();
        }
        async Task ShowMainAsync(string? key = null, bool register = false)
        {
            menu?.Hide();
            panel.Hide();
            configuration ??= new ConfigurationWindow(request => LinkProtocol.CallAsync(request), ShowPhone);
            await configuration.OpenAsync(key, register);
        }
        icon.ToggleRequested += () =>
        {
            menu?.Hide();
            if (panel.IsVisible) panel.Hide();
            else if (!panel.JustDismissed) ShowPhone();
        };
        var menuSnapshot = new TraySnapshot(false, null, null, null, [], []);
        var menuLoading = false;
        icon.MenuRequested += async _ =>
        {
            panel.Hide();
            if (menu?.IsVisible == true) { menu.Hide(); return; }
            if (menu is null)
            {
                menu = new TrayMenuWindow(BuildQuickEntries(), DispatchAsync);
                menu.SizeChanged += (_, _) => icon.PositionPanel(menu);
            }
            menu.OpenRoot();
            icon.ShowPanel(menu);
            await RefreshMenuAsync();
        };

        IReadOnlyList<TrayMenuEntry> BuildQuickEntries() =>
        [
            .. TrayMenuModel.BuildConfiguration(menuSnapshot),
            new(TrayMenuEntryKind.Separator, ""),
            new(TrayMenuEntryKind.Submenu, "连接选项", Icon: "phone",
                Children:
                [
                    new(TrayMenuEntryKind.Item, "打开手机连接面板", Action: "open", Icon: "open"),
                    .. TrayMenuModel.Build(menuSnapshot).Where(entry => entry.Icon is "phone" or "member" or "pair"),
                    new(TrayMenuEntryKind.Item, "登录自启设置", Action: "openSettings", Icon: "settings"),
                    .. StartupEntry.UpdatesAvailable
                        ? new TrayMenuEntry[] { new(TrayMenuEntryKind.Item, "检查 Agent Link 更新", Action: "linkUpdate") }
                        : [],
                ]),
        ];

        async Task RefreshMenuAsync(bool resetNavigation = false)
        {
            if (menu is not { IsVisible: true } || menuLoading) return;
            menuLoading = true;
            try
            {
                var latest = await FetchSnapshotAsync();
                menuSnapshot = latest with { Managed = latest.Managed ?? menuSnapshot.Managed };
                if (menu.IsVisible) menu.ShowConfiguration(BuildQuickEntries(), resetNavigation);
            }
            finally { menuLoading = false; }
        }

        async Task DispatchAsync(TrayMenuEntry entry)
        {
            switch (entry.Action)
            {
                case "open": ShowPhone(); break;
                case "openMain": await ShowMainAsync(entry.Id); break;
                case "openAgents": await ShowMainAsync(); break;
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
                case "agentAdd": await ShowMainAsync(register: true); break;
                case "agentEnable" or "agentDisable" when entry.Id is { } key:
                    await ApplyQuickAsync(key, new JsonObject { ["enabled"] = entry.Action == "agentEnable" });
                    break;
                case "agentProvider" or "agentModel" when entry.Id is { } key && !entry.Checked:
                    var field = entry.Action == "agentProvider" ? "provider" : "model";
                    await ApplyQuickAsync(key, new JsonObject { [field] = entry.Value });
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
                case "refresh": await RefreshMenuAsync(resetNavigation: true); break;
                case "linkUpdate" when StartupEntry.UpdatesAvailable && StartupEntry.LauncherPath is { } bootstrap:
                    try
                    {
                        menu?.SetFeedback("正在检查 Agent Link 更新");
                        var start = new ProcessStartInfo(bootstrap) { UseShellExecute = false };
                        start.ArgumentList.Add("--check-update");
                        using var update = Process.Start(start) ?? throw new IOException("Launcher did not start.");
                        await update.WaitForExitAsync();
                        menu?.SetFeedback(update.ExitCode == 0 ? "更新检查已结束" : "更新检查暂未完成");
                    }
                    catch (Exception error) when (error is IOException or System.ComponentModel.Win32Exception)
                    { menu?.SetFeedback("无法启动更新检查"); }
                    break;
                case "usage":
                    try
                    {
                        var reply = await LinkProtocol.CallAsync(new("localUsage", entry.Id));
                        var usage = reply.Ok ? reply.Data?.Deserialize<UsageSnapshot>(LinkProtocol.Json) : null;
                        menu?.ShowUsage(usage ?? new("unavailable", []), entry.Id);
                    }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException or JsonException)
                    {
                        menu?.ShowUsage(new("unavailable", []), entry.Id);
                    }
                    break;
                case "exit":
                    if (MessageBox.Show("退出后，手机将暂时无法连接这台电脑。", "Agent Link",
                        MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                    try { await LinkProtocol.CallAsync(new("exit")); }
                    catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException) { }
                    app.Shutdown();
                    break;
            }
        }

        async Task ApplyQuickAsync(string key, JsonObject changes)
        {
            try
            {
                var reply = await LinkProtocol.CallAsync(new("agentSet", key, changes));
                if (!reply.Ok) { menu?.SetFeedback(reply.Error ?? "配置未应用。"); return; }
                await RefreshMenuAsync(resetNavigation: true);
                menu?.SetFeedback("配置已保存");
            }
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException or JsonException)
            { menu?.SetFeedback("暂时无法确认保存结果，请刷新后核对。"); }
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
            catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException or JsonException)
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
        _ = ListenForActivationAsync(app.Dispatcher, () => _ = ShowMainAsync(), app.Shutdown, stopping.Token);
        if (!background) _ = ShowMainAsync();
        health.Start();
        var updates = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
        if (StartupEntry.ScheduledUpdatesAvailable && StartupEntry.LauncherPath is { } updateLauncher)
        {
            var schedule = new WindowsUpdateSchedule(LinkProtocol.Root);
            updates.Tick += (_, _) =>
            {
                if (!schedule.CanStart(DateTimeOffset.UtcNow)) return;
                try
                {
                    var start = new ProcessStartInfo(updateLauncher) { UseShellExecute = false };
                    start.ArgumentList.Add("--check-update-background");
                    using var update = Process.Start(start);
                }
                catch (Exception error) when (error is IOException or System.ComponentModel.Win32Exception) { }
            };
            updates.Start();
        }
        app.Run();
        updates.Stop();
        health.Stop();
        stopping.Cancel();
        mutex.ReleaseMutex();
        return 0;
    }

    private static async Task ListenForActivationAsync(Dispatcher dispatcher, Action show, Action close,
        CancellationToken cancellation)
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
                    if (await pipe.ReadAsync(signal, deadline.Token) != 1) continue;
                    if (signal[0] == 1) await dispatcher.InvokeAsync(show);
                    if (signal[0] == 2)
                    {
                        var operationId = await LinkProtocol.ReadAsync<string>(pipe, deadline.Token);
                        if (LinkUpdateTransition.Matches(operationId)) await dispatcher.InvokeAsync(close);
                    }
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
                catch (JsonException) { }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private static void StartHost()
    {
        if (LinkUpdateTransition.IsHeld()) return;
        using var child = Process.Start(new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "host", "AgentLink.Host.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true,
        });
    }
}
