using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace AgentLink;

internal sealed class LocalScheduleGrantWindow : Window
{
    private readonly string deviceId;
    private readonly StackPanel choices = new();
    private readonly List<(LaunchScope Scope, CheckBox Box)> options = [];
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, MinHeight = 24 };
    private readonly Button save = new() { Content = "保存授权", Padding = new(12, 5, 12, 5), IsEnabled = false };
    private readonly Button clear = new()
    {
        Content = "清空选择", Padding = new(12, 5, 12, 5), Margin = new(8, 0, 0, 0), IsEnabled = false,
    };
    private readonly Button refresh = new()
    {
        Content = "刷新", Padding = new(12, 5, 12, 5), Margin = new(8, 0, 0, 0),
    };
    private long? revision;
    private bool canSave;
    private bool busy;

    internal LocalScheduleGrantWindow(string deviceId, string label)
    {
        this.deviceId = deviceId;
        Title = "Agent Link · 本地定时授权";
        Width = 550;
        Height = 425;
        MinWidth = 395;
        MinHeight = 305;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        LinkTheme.Apply(Resources);
        SetResourceReference(BackgroundProperty, "LinkSurface");
        SetResourceReference(ForegroundProperty, "LinkText");
        var body = new DockPanel { Margin = new(20) };
        var header = new StackPanel { Margin = new(0, 0, 0, 12) };
        header.Children.Add(new TextBlock
        {
            Text = label, ToolTip = label, TextTrimming = TextTrimming.CharacterEllipsis,
            FontSize = 20, FontWeight = FontWeights.SemiBold,
        });
        var help = new TextBlock
        {
            Text = "选择允许这部手机创建定时任务的工作区和引擎。清空并保存可撤回定时授权，普通派活权限保留。",
            TextWrapping = TextWrapping.Wrap, Margin = new(0, 6, 0, 0),
        };
        help.SetResourceReference(TextBlock.ForegroundProperty, "LinkSecondary");
        header.Children.Add(help);
        DockPanel.SetDock(header, Dock.Top);
        body.Children.Add(header);
        var footer = new StackPanel { Margin = new(0, 12, 0, 0) };
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        footer.Children.Add(status);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        buttons.Children.Add(save);
        buttons.Children.Add(clear);
        buttons.Children.Add(refresh);
        footer.Children.Add(buttons);
        DockPanel.SetDock(footer, Dock.Bottom);
        body.Children.Add(footer);
        body.Children.Add(new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = choices,
        });
        Content = body;
        Loaded += async (_, _) => await RunAsync(() => ReadAsync());
        refresh.Click += async (_, _) => await RunAsync(() => ReadAsync());
        save.Click += async (_, _) => await RunAsync(SaveAsync);
        clear.Click += (_, _) =>
        {
            foreach (var (_, box) in options) box.IsChecked = false;
        };
    }

    private async Task RunAsync(Func<Task> action)
    {
        if (busy) return;
        busy = true;
        save.IsEnabled = clear.IsEnabled = refresh.IsEnabled = choices.IsEnabled = false;
        status.Text = "正在核对授权…";
        try { await action(); }
        catch (Exception error) when (Unavailable(error))
        {
            ResetView();
            status.Text = "暂时无法读取本地定时授权，请刷新。";
        }
        finally
        {
            busy = false;
            refresh.IsEnabled = choices.IsEnabled = true;
            save.IsEnabled = revision.HasValue && canSave;
            clear.IsEnabled = save.IsEnabled && options.Count > 0;
        }
    }

    private void ResetView()
    {
        revision = null;
        canSave = false;
        options.Clear();
        choices.Children.Clear();
    }

    private async Task ReadAsync(string? notice = null)
    {
        ResetView();
        var reply = await LinkProtocol.CallAsync(new("localScheduleGrant", deviceId));
        if (!reply.Ok || reply.Data is not JsonObject grant ||
            grant["revision"] is not JsonValue value || !value.TryGetValue<long>(out var version) ||
            version < 0 || grant["allowedLaunchScopes"] is not JsonArray allowed || grant["launchScopes"] is not JsonArray selected)
        {
            status.Text = reply.Error == "DEVICE_UNAVAILABLE"
                ? "这部手机的配对已不可用。"
                : "暂时无法读取本地定时授权，请刷新。";
            return;
        }
        var targets = allowed.Deserialize<LaunchScope[]>(LinkProtocol.Json) ?? [];
        var existing = selected.Deserialize<LaunchScope[]>(LinkProtocol.Json) ?? [];
        foreach (var scope in targets.Distinct())
        {
            var label = $"{scope.ProjectId} · {scope.EngineId} · {scope.BackendStoreId}";
            var box = new CheckBox
            {
                Content = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap },
                IsChecked = existing.Contains(scope), Margin = new(0, 5, 12, 5),
            };
            AutomationProperties.SetName(box, label);
            choices.Children.Add(box);
            options.Add((scope, box));
        }
        revision = version;
        canSave = options.Count > 0 || existing.Length > 0;
        status.Text = notice ?? (options.Count == 0 ? "这部手机当前没有可授权的工作区和引擎。" : "");
    }

    private async Task SaveAsync()
    {
        if (revision is not { } version || !canSave) return;
        var body = JsonSerializer.SerializeToNode(new
        {
            expectedRevision = version,
            launchScopes = options.Where(option => option.Box.IsChecked == true).Select(option => option.Scope).ToArray(),
        }, LinkProtocol.Json);
        LinkReply reply;
        try { reply = await LinkProtocol.CallAsync(new("setLocalScheduleGrant", deviceId, body)); }
        catch (Exception error) when (Unavailable(error))
        {
            await ReadAsync("保存回执未收到，已重新读取当前授权。");
            return;
        }
        if (reply.Ok) { Close(); return; }
        if (reply.Error is "DEVICE_REVOKED" or "DEVICE_EXPIRED" or "NOT_FOUND")
        {
            ResetView();
            status.Text = "该手机的配对已失效。请重新配对。";
            return;
        }
        var notice = reply.Error switch
        {
            "REVISION_CONFLICT" => "授权已被更新，已载入最新选择。请核对后再保存。",
            "DEVICE_SCOPE_DENIED" => "手机的派活范围已变化，已载入当前范围。",
            _ => "本次保存未确认，已重新读取当前授权。",
        };
        await ReadAsync(notice);
    }

    private static bool Unavailable(Exception error) =>
        error is IOException or TimeoutException or OperationCanceledException or JsonException;
}
