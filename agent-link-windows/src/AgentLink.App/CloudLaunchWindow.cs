using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;

namespace AgentLink;

internal sealed class CloudLaunchWindow : Window
{
    private sealed record LaunchScope(string BackendStoreId, string ProjectId, string EngineId);
    private sealed record Target(string BackendId, string ProjectId, string EngineId)
    {
        public string Label => $"{ProjectId} · {EngineId} · {BackendId}";
        public LaunchScope Scope => new(BackendId, ProjectId, EngineId);
    }

    private readonly Func<LinkRequest, Task<LinkReply>> call;
    private readonly ListBox targets = new() { SelectionMode = SelectionMode.Multiple, DisplayMemberPath = "Label" };
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new(0, 0, 0, 12) };
    private readonly Button save = new() { Content = "保存授权", MinWidth = 110, Padding = new(12, 6, 12, 6) };
    private readonly CheckBox controls = new() { Content = "允许追加消息和请求停止", Margin = new(0, 8, 0, 0) };
    private readonly CheckBox approvals = new() { Content = "允许在云端确认当前 Pi 审批请求", Margin = new(0, 8, 0, 0) };
    private readonly long revision;
    private readonly string scope;

    internal CloudLaunchWindow(Func<LinkRequest, Task<LinkReply>> call, JsonObject directory)
    {
        this.call = call;
        Title = "Agent Link · 云任务授权";
        Width = 580;
        Height = 430;
        MinWidth = 430;
        MinHeight = 280;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var body = new DockPanel { Margin = new(20) };
        DockPanel.SetDock(status, Dock.Top);
        body.Children.Add(status);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new(0, 12, 0, 0) };
        var clear = new Button { Content = "取消全选", Margin = new(8, 0, 0, 0), Padding = new(12, 6, 12, 6) };
        clear.Click += (_, _) => targets.UnselectAll();
        buttons.Children.Add(save);
        buttons.Children.Add(clear);
        DockPanel.SetDock(buttons, Dock.Bottom);
        body.Children.Add(buttons);
        DockPanel.SetDock(controls, Dock.Bottom);
        body.Children.Add(controls);
        DockPanel.SetDock(approvals, Dock.Bottom);
        body.Children.Add(approvals);
        body.Children.Add(targets);
        Content = body;
        var options = (directory["targets"] as JsonArray ?? []).Deserialize<Target[]>(LinkProtocol.Json) ?? [];
        targets.ItemsSource = options;
        var selected = (directory["launchScopes"] as JsonArray ?? []).Deserialize<LaunchScope[]>(LinkProtocol.Json) ?? [];
        foreach (var target in options.Where(item => selected.Contains(item.Scope))) targets.SelectedItems.Add(target);
        revision = directory["revision"]?.GetValue<long>() ?? 0;
        scope = directory["scope"]?.GetValue<string>() ?? "";
        controls.IsChecked = directory["controls"]?.GetValue<bool>() ?? false;
        approvals.IsChecked = directory["approvals"]?.GetValue<bool>() ?? false;
        status.Text = "勾选允许当前会员从云端启动任务的本机工作区和引擎。清空后保存即可撤回。";
        save.Click += async (_, _) => await SaveAsync();
    }

    private async Task SaveAsync()
    {
        var args = JsonSerializer.SerializeToNode(new
        {
            expectedRevision = revision,
            expectedScope = scope,
            launchScopes = targets.SelectedItems.Cast<Target>().Select(item => item.Scope).ToArray(),
            controls = controls.IsChecked == true,
            approvals = approvals.IsChecked == true,
        }, LinkProtocol.Json);
        save.IsEnabled = targets.IsEnabled = false;
        try
        {
            var reply = await call(new("setCloudLaunch", Args: args));
            if (reply.Ok) Close();
            else status.Text = reply.Error ?? "授权保存失败";
        }
        catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException or JsonException)
        {
            status.Text = "暂时无法连接 Windows Link，请重新打开并核对授权。";
        }
        finally { save.IsEnabled = targets.IsEnabled = true; }
    }
}
