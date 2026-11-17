using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;

namespace AgentLink;

internal sealed class LinkFilesWindow : Window
{
    private sealed record Choice(string Label, JsonObject Data);
    private readonly ComboBox devices = new() { DisplayMemberPath = "Label", MinWidth = 230 };
    private readonly ListBox transfers = new() { DisplayMemberPath = "Label", MinHeight = 160 };
    private readonly TextBlock message = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) };
    private readonly Button send;
    private readonly Button receive;
    private readonly Button resume;
    private readonly Button retain;
    private readonly Button remove;
    private string? deviceId;
    private JsonObject? pending;
    private bool busy;

    internal LinkFilesWindow()
    {
        Title = "跨设备文件";
        Width = 530;
        Height = 450;
        MinWidth = 420;
        MinHeight = 380;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var root = new DockPanel { Margin = new Thickness(16) };
        var controls = new StackPanel();
        DockPanel.SetDock(controls, Dock.Top);
        controls.Children.Add(new TextBlock { Text = "收件设备", Margin = new Thickness(0, 0, 0, 4) });
        controls.Children.Add(devices);
        var actions = new WrapPanel { Margin = new Thickness(0, 8, 0, 10) };
        actions.Children.Add(send = Action("选择文件并发送", SendAsync));
        actions.Children.Add(Action("刷新", RefreshAsync));
        controls.Children.Add(actions);
        root.Children.Add(controls);

        var bottom = new StackPanel();
        DockPanel.SetDock(bottom, Dock.Bottom);
        var incoming = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
        incoming.Children.Add(receive = Action("另存为", ReceiveAsync));
        incoming.Children.Add(resume = Action("续传", () => TransferAsync("resume")));
        incoming.Children.Add(retain = Action("保留", () => TransferAsync("retain")));
        incoming.Children.Add(remove = Action("移除云端保留", () => TransferAsync("removeRetention")));
        bottom.Children.Add(incoming);
        bottom.Children.Add(message);
        root.Children.Add(bottom);
        root.Children.Add(transfers);
        Content = root;
        devices.SelectionChanged += (_, _) => UpdateButtons();
        transfers.SelectionChanged += (_, _) => UpdateButtons();
        Loaded += async (_, _) => await RunAsync(RefreshAsync);
    }

    private Button Action(string label, Func<Task> action)
    {
        var button = new Button
        {
            Content = label, Padding = new Thickness(10, 4, 10, 4), Margin = new Thickness(0, 0, 8, 3),
        };
        button.Click += async (_, _) => await RunAsync(action);
        return button;
    }

    private async Task RunAsync(Func<Task> action)
    {
        if (busy) return;
        busy = true;
        message.Text = "正在处理…";
        UpdateButtons();
        try
        {
            await action();
            if (message.Text == "正在处理…") message.Text = "";
        }
        catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException or JsonException)
        {
            message.Text = "文件服务暂不可用，请刷新后重试。";
        }
        finally { busy = false; UpdateButtons(); }
    }

    private void UpdateButtons()
    {
        var transfer = (transfers.SelectedItem as Choice)?.Data;
        var state = transfer?["state"]?.GetValue<string>();
        var incoming = transfer?["recipientId"]?.GetValue<string>() == deviceId && deviceId != null;
        send.IsEnabled = !busy && (pending != null || devices.SelectedItem != null);
        send.Content = pending is null ? "选择文件并发送" : "重试当前发送";
        receive.IsEnabled = !busy && incoming && state is "available" or "received";
        resume.IsEnabled = !busy && !incoming && state == "uploading";
        retain.IsEnabled = receive.IsEnabled && transfer?["retainedUntil"] is null && transfer?["campaignId"] is null;
        remove.IsEnabled = !busy && incoming && transfer?["retainedUntil"] is not null;
    }

    private async Task<JsonNode?> RequestAsync(string action, JsonObject? args = null)
    {
        var reply = await LinkProtocol.CallFilesAsync(new LinkRequest(action, Args: args));
        if (reply.Ok) return reply.Data;
        message.Text = reply.Error ?? "文件操作失败。";
        return null;
    }

    private async Task RefreshAsync()
    {
        if (await RequestAsync("overview") is not JsonObject view) return;
        deviceId = view["deviceId"]?.GetValue<string>();
        var rows = view["capabilities"]?["devices"] as JsonArray ?? new JsonArray();
        devices.ItemsSource = rows.OfType<JsonObject>().Where(row => row["id"]?.GetValue<string>() != deviceId)
            .Select(row => new Choice(row["name"]?.GetValue<string>() ?? "文件设备", row)).ToArray();
        if (devices.Items.Count > 0) devices.SelectedIndex = 0;
        var files = view["transfers"] as JsonArray ?? new JsonArray();
        transfers.ItemsSource = files.OfType<JsonObject>().Select(TransferChoice).ToArray();
    }

    private Choice TransferChoice(JsonObject row)
    {
        var incoming = row["recipientId"]?.GetValue<string>() == deviceId;
        var state = row["state"]?.GetValue<string>() switch
        {
            "uploading" => "待上传", "available" => "可接收", "received" => "已接收",
            "expired" => "已过期", "cancelled" => "已取消", _ => "待刷新",
        };
        var direction = incoming ? "收到" : "发出";
        var remote = row[incoming ? "senderId" : "recipientId"]?.GetValue<string>();
        var name = devices.Items.OfType<Choice>().FirstOrDefault(device => device.Data["id"]?.GetValue<string>() == remote)?.Label ?? "另一台设备";
        var keep = row["retainedUntil"] is null ? "" : " · 已保留";
        return new($"{direction} · {name} · {state} · {row["plainBytes"]} 字节{keep}", row);
    }

    private async Task SendAsync()
    {
        if (pending is null)
        {
            if (devices.SelectedItem is not Choice target) return;
            var dialog = new Microsoft.Win32.OpenFileDialog { Title = "选择要发送的文件", CheckFileExists = true };
            if (dialog.ShowDialog(this) != true) return;
            pending = new JsonObject {
                ["source"] = dialog.FileName,
                ["recipientId"] = target.Data["id"]?.GetValue<string>(),
                ["requestKey"] = Guid.NewGuid().ToString("N"),
            };
        }
        if (await RequestAsync("send", pending) is null) return;
        pending = null;
        await RefreshAsync();
    }

    private async Task ReceiveAsync()
    {
        if (transfers.SelectedItem is not Choice transfer) return;
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "保存已验证的文件", FileName = "收到的文件", OverwritePrompt = true,
        };
        if (dialog.ShowDialog(this) != true) return;
        var args = new JsonObject { ["transferId"] = transfer.Data["id"]?.GetValue<string>(), ["destination"] = dialog.FileName };
        if (await RequestAsync("receive", args) is not null) await RefreshAsync();
    }

    private async Task TransferAsync(string action)
    {
        if (transfers.SelectedItem is not Choice transfer) return;
        var args = new JsonObject { ["transferId"] = transfer.Data["id"]?.GetValue<string>() };
        if (await RequestAsync(action, args) is not null) await RefreshAsync();
    }
}
