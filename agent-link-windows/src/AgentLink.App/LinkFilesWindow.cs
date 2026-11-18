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
    private readonly TextBlock deviceNumber = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly TextBlock message = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) };
    private readonly Button send;
    private readonly Button receive;
    private readonly Button resume;
    private readonly Button retain;
    private readonly Button remove;
    private readonly Button authorize;
    private readonly Button revoke;
    private Choice[] grantTargets = [];
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
        controls.Children.Add(deviceNumber);
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
        incoming.Children.Add(authorize = Action("授权恢复", GrantAsync));
        incoming.Children.Add(revoke = Action("撤回授权", RevokeGrantAsync));
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
        var grantRow = transfer?["grantId"] is not null;
        var incomingGrant = grantRow && transfer?["grantee"] is null;
        var available = state is "available" or "received";
        send.IsEnabled = !busy && (pending != null || devices.SelectedItem != null);
        send.Content = pending is null ? "选择文件并发送" : "重试当前发送";
        receive.IsEnabled = !busy && (incomingGrant || incoming && available);
        resume.IsEnabled = !busy && !grantRow && !incoming && state == "uploading";
        retain.IsEnabled = !busy && incoming && available && transfer?["retainedUntil"] is null && transfer?["campaignId"] is null;
        remove.IsEnabled = !busy && incoming && transfer?["retainedUntil"] is not null;
        authorize.IsEnabled = !busy && !grantRow && available && OtherDevices(transfer).Any();
        revoke.IsEnabled = !busy && grantRow && !incomingGrant && state == "pending";
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
        deviceNumber.Text = deviceId is { Length: >= 8 } ? $"本机文件设备编号 {deviceId[^8..]}" : "";
        var rows = view["capabilities"]?["devices"] as JsonArray ?? new JsonArray();
        devices.ItemsSource = rows.OfType<JsonObject>().Where(row => row["id"]?.GetValue<string>() != deviceId)
            .Select(row => new Choice(row["name"]?.GetValue<string>() ?? "文件设备", row)).ToArray();
        if (devices.Items.Count > 0) devices.SelectedIndex = 0;
        var files = view["transfers"] as JsonArray ?? new JsonArray();
        grantTargets = (view["grantTargets"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Select(row => new Choice(DeviceLabel(row), row)).ToArray();
        var incoming = (view["incomingGrants"] as JsonArray ?? new JsonArray()).OfType<JsonObject>();
        var issued = (view["issuedGrants"] as JsonArray ?? new JsonArray()).OfType<JsonObject>();
        transfers.ItemsSource = files.OfType<JsonObject>().Select(TransferChoice)
            .Concat(incoming.Select(row => new Choice($"文件恢复授权 · {row["name"]} · {row["plainBytes"]} 字节", row)))
            .Concat(issued.Select(row => new Choice($"已授权 · {DeviceLabel(row["grantee"] as JsonObject)} · {GrantStatus(row)}", row)))
            .ToArray();
        UpdateButtons();
    }

    private static string DeviceLabel(JsonObject? row)
    {
        var id = row?["id"]?.GetValue<string>() ?? "";
        var suffix = id.Length > 8 ? id[^8..] : id;
        return $"{row?["name"]?.GetValue<string>() ?? "文件设备"} · {suffix}";
    }

    private static string GrantStatus(JsonObject row) => row["state"]?.GetValue<string>() switch
    {
        "pending" => "等待领取", "consumed" => "已领取", "revoked" => "已撤回", _ => "请刷新",
    };

    private IEnumerable<Choice> OtherDevices(JsonObject? transfer) => grantTargets.Where(device =>
        device.Data["id"]?.GetValue<string>() != transfer?["senderId"]?.GetValue<string>() &&
        device.Data["id"]?.GetValue<string>() != transfer?["recipientId"]?.GetValue<string>());

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
        var grantId = transfer.Data["grantId"]?.GetValue<string>();
        var args = new JsonObject { ["destination"] = dialog.FileName };
        if (grantId is null) args["transferId"] = transfer.Data["id"]?.GetValue<string>();
        else args["grantId"] = grantId;
        if (await RequestAsync(grantId is null ? "receive" : "receiveGrant", args) is not null) await RefreshAsync();
    }

    private async Task GrantAsync()
    {
        if (transfers.SelectedItem is not Choice transfer) return;
        var candidates = OtherDevices(transfer.Data).ToArray();
        if (candidates.Length == 0) return;
        var select = new ComboBox { ItemsSource = candidates, DisplayMemberPath = "Label" };
        var confirm = new Button { Content = "授权选定设备解密", IsDefault = true, IsEnabled = false, Margin = new Thickness(0, 12, 0, 0) };
        var body = new StackPanel { Margin = new Thickness(16) };
        body.Children.Add(new TextBlock { Text = "核对新设备上的设备编号后选择。", Margin = new Thickness(0, 0, 0, 8) });
        body.Children.Add(select);
        body.Children.Add(confirm);
        var dialog = new Window { Title = "授权另一台设备解密", Owner = this, Width = 400,
            SizeToContent = SizeToContent.Height, WindowStartupLocation = WindowStartupLocation.CenterOwner, Content = body };
        select.SelectionChanged += (_, _) => confirm.IsEnabled = select.SelectedItem is Choice;
        confirm.Click += (_, _) => dialog.DialogResult = true;
        if (dialog.ShowDialog() != true || select.SelectedItem is not Choice target) return;
        var args = new JsonObject { ["transferId"] = transfer.Data["id"]?.GetValue<string>(),
            ["granteeId"] = target.Data["id"]?.GetValue<string>() };
        if (await RequestAsync("grantAccess", args) is not JsonObject receipt) return;
        await RefreshAsync();
        if (receipt["state"]?.GetValue<string>() == "revoked")
            message.Text = "上次授权已撤回。重新选择设备并确认可发起新授权。";
    }

    private async Task RevokeGrantAsync()
    {
        if (transfers.SelectedItem is not Choice grant ||
            MessageBox.Show(this, "撤回这项待领取的文件授权？", Title, MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
        if (await RequestAsync("revokeGrant", new JsonObject { ["grantId"] = grant.Data["grantId"]?.GetValue<string>() }) is not null)
            await RefreshAsync();
    }

    private async Task TransferAsync(string action)
    {
        if (transfers.SelectedItem is not Choice transfer) return;
        var args = new JsonObject { ["transferId"] = transfer.Data["id"]?.GetValue<string>() };
        if (await RequestAsync(action, args) is not null) await RefreshAsync();
    }
}
