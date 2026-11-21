using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace AgentLink;

internal sealed class ScheduleTransferWindow : Window
{
    private const string Schema = "link-schedule-ownership/1";
    private sealed record Rule(string RuleId, int Revision, string Title, string ProjectId, string EngineId, bool Paused);
    private sealed record Move(string RuleId, string RequestKey, int ExpectedRevision, string Destination, string Title);
    private sealed record DirectoryView(string SchemaVersion, string? Scope, Rule[] Local, Rule[] Cloud,
        Move[] Pending, string? CloudProblem);
    private sealed record Receipt(string SchemaVersion, string RuleId, string RequestKey, string Owner, int Epoch);

    private readonly Func<LinkRequest, Task<LinkReply>> call;
    private readonly StackPanel rows = new();
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new(0, 0, 0, 8) };
    private readonly Button refresh = new() { Content = "刷新", Padding = new(12, 5, 12, 5) };
    private DirectoryView? directory;
    private bool busy;

    internal ScheduleTransferWindow(Func<LinkRequest, Task<LinkReply>> call)
    {
        this.call = call;
        Title = "Agent Link · 迁移定时规则";
        Width = 580;
        Height = 450;
        MinWidth = 430;
        MinHeight = 315;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        LinkTheme.Apply(Resources);
        SetResourceReference(BackgroundProperty, "LinkSurface");
        SetResourceReference(ForegroundProperty, "LinkText");
        var body = new DockPanel { Margin = new(20) };
        var footer = new StackPanel { Margin = new(0, 12, 0, 0) };
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        footer.Children.Add(status);
        var actions = new StackPanel { Orientation = Orientation.Horizontal };
        actions.Children.Add(refresh);
        var close = new Button { Content = "关闭", IsCancel = true, Padding = new(12, 5, 12, 5), Margin = new(8, 0, 0, 0) };
        actions.Children.Add(close);
        footer.Children.Add(actions);
        DockPanel.SetDock(footer, Dock.Bottom);
        body.Children.Add(footer);
        body.Children.Add(new ScrollViewer { Content = rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Content = body;
        Loaded += async (_, _) => await RunAsync(() => LoadAsync());
        refresh.Click += async (_, _) => await RunAsync(() => LoadAsync());
    }

    private async Task RunAsync(Func<Task> action)
    {
        if (busy) return;
        busy = true;
        rows.IsEnabled = refresh.IsEnabled = false;
        status.Text = "正在核对规则…";
        try { await action(); }
        catch (Exception error) when (Unavailable(error))
        {
            directory = null;
            Render();
            status.Text = Message(null);
        }
        finally
        {
            busy = false;
            rows.IsEnabled = refresh.IsEnabled = true;
        }
    }

    private async Task LoadAsync(string? note = null)
    {
        var reply = await call(new("scheduleTransferDirectory"));
        var view = reply.Ok ? reply.Data?.Deserialize<DirectoryView>(LinkProtocol.Json) : null;
        directory = view is { SchemaVersion: Schema, Local: not null, Cloud: not null, Pending: not null } ? view : null;
        Render();
        status.Text = directory is null ? Message(reply.Error) : note ?? "";
    }

    private void Render()
    {
        rows.Children.Clear();
        if (directory is not { } view) return;
        if (view.CloudProblem is { } problem)
            rows.Children.Add(new TextBlock { Text = Message(problem), TextWrapping = TextWrapping.Wrap });
        if (view.Pending.Length > 0)
        {
            Heading("待核对");
            foreach (var move in view.Pending)
                AddRow(move.Title, DestinationLabel(move.Destination), "重试原请求", move.RuleId, view.Scope is not null,
                    () => move);
        }
        AddRules("本机执行", view.Local, "cloud", view);
        AddRules("云端执行", view.Cloud, "local", view);
        if (view.Pending.Length + view.Local.Length + view.Cloud.Length == 0)
            rows.Children.Add(new TextBlock { Text = "没有可迁移的规则。", Margin = new(0, 8, 0, 0) });
    }

    private void AddRules(string heading, Rule[] rules, string destination, DirectoryView view)
    {
        if (rules.Length == 0) return;
        Heading(heading);
        foreach (var rule in rules)
            AddRow(rule.Title, $"{rule.ProjectId} · {rule.EngineId}" + (rule.Paused ? " · 已暂停" : ""),
                DestinationLabel(destination), rule.RuleId, view.Scope is not null && view.CloudProblem is null,
                () => new(rule.RuleId, Guid.NewGuid().ToString("D"), rule.Revision, destination, rule.Title));
    }

    private void Heading(string title) => rows.Children.Add(new TextBlock
    {
        Text = title, FontWeight = FontWeights.SemiBold, Margin = new(0, 10, 0, 4),
    });

    private void AddRow(string title, string detail, string action, string id, bool enabled, Func<Move> move)
    {
        var row = new DockPanel { Margin = new(0, 3, 0, 7) };
        var button = new Button
        {
            Content = action, IsEnabled = enabled, Padding = new(10, 5, 10, 5),
            Margin = new(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center,
        };
        AutomationProperties.SetName(button, $"{action} {title}");
        button.Click += async (_, _) => await RunAsync(() => SubmitAsync(move()));
        DockPanel.SetDock(button, Dock.Right);
        row.Children.Add(button);
        var label = new StackPanel { ToolTip = id };
        label.Children.Add(new TextBlock { Text = title, TextTrimming = TextTrimming.CharacterEllipsis });
        var caption = new TextBlock { Text = detail, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 11 };
        caption.SetResourceReference(TextBlock.ForegroundProperty, "LinkSecondary");
        label.Children.Add(caption);
        row.Children.Add(label);
        rows.Children.Add(row);
    }

    private async Task SubmitAsync(Move move)
    {
        if (directory?.Scope is not { } scope) return;
        string result;
        try
        {
            var reply = await call(new("transferSchedule", move.RuleId, new JsonObject
            {
                ["expectedScope"] = scope, ["requestKey"] = move.RequestKey,
                ["expectedRevision"] = move.ExpectedRevision, ["destination"] = move.Destination,
            }));
            var receipt = reply.Ok ? reply.Data?.Deserialize<Receipt>(LinkProtocol.Json) : null;
            result = receipt is { SchemaVersion: Schema, Epoch: >= 2 } && receipt.RuleId == move.RuleId &&
                receipt.RequestKey == move.RequestKey && receipt.Owner == move.Destination
                ? (move.Destination == "cloud" ? "已由云端接管。" : "已由本机接管。")
                : Message(reply.Error);
        }
        catch (Exception error) when (Unavailable(error)) { result = Message(null); }
        await LoadAsync(result);
    }

    private static string DestinationLabel(string destination) => destination == "cloud" ? "迁至云端" : "迁至本机";

    private static bool Unavailable(Exception error) =>
        error is IOException or TimeoutException or OperationCanceledException or JsonException;

    private static string Message(string? code) => code switch
    {
        "NOT_FOUND" or "OPERATION_NOT_ALLOWED" or "操作当前不可用" => "当前网关或会员服务尚未提供规则迁移。",
        "CLOUD_SESSION_REQUIRED" => "连接会员账号后可以迁移定时规则。",
        "CLOUD_SESSION_CHANGED" => "会员连接已变化。请刷新后核对规则。",
        "REVISION_CONFLICT" or "SCHEDULE_OWNERSHIP_CONFLICT" => "规则已变化。请核对当前执行方后重试。",
        "SCHEDULE_WORK_IN_PROGRESS" => "规则还有未完成的触发。任务结束后可以重试。",
        "TARGET_UNAVAILABLE" or "CLOUD_GRANT_CHANGED" => "目标暂不可用。请核对工作区、引擎和云任务授权。",
        "ENTITLEMENT_REQUIRED" => "当前会员无法使用云端定时任务。",
        "SCHEDULE_TRANSFER_PENDING" or "OPERATION_IN_PROGRESS" => "已有迁移请求。请从待核对列表重试原请求。",
        "SCHEDULE_TRANSFER_UNSUPPORTED" => "这条规则含有本机调度暂不支持的配置。",
        _ => "暂时无法确认迁移状态。请刷新并核对当前执行方。",
    };
}
