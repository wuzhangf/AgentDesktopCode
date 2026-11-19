using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;

namespace AgentLink;

internal sealed class HandoffRecoveryWindow : Window
{
    private sealed record Option(string Id, string Label);

    internal HandoffRecoveryWindow(Func<LinkRequest, Task<LinkReply>> call, JsonObject view)
    {
        Title = "换机交接恢复";
        Width = 640;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var layout = new StackPanel { Margin = new Thickness(18) };
        layout.Children.Add(new TextBlock
        {
            Text = "授权有效期为 30 分钟。跨电脑交接需在源电脑授权原交接，并在目标电脑授权原导入。新手机须分别配对，并持有相应权限。",
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 12),
        });
        var handoffs = new ComboBox { DisplayMemberPath = nameof(Option.Label), Margin = new Thickness(0, 4, 0, 12) };
        var devices = new ComboBox { DisplayMemberPath = nameof(Option.Label), Margin = new Thickness(0, 4, 0, 12) };
        layout.Children.Add(new TextBlock { Text = "原交接或原导入" });
        layout.Children.Add(handoffs);
        layout.Children.Add(new TextBlock { Text = "新手机" });
        layout.Children.Add(devices);
        var actions = new StackPanel { Orientation = Orientation.Horizontal };
        var grant = new Button { Content = "授权恢复", Margin = new Thickness(0, 0, 8, 0) };
        var revoke = new Button { Content = "撤回授权" };
        actions.Children.Add(grant);
        actions.Children.Add(revoke);
        layout.Children.Add(actions);
        var notice = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0) };
        layout.Children.Add(notice);

        handoffs.ItemsSource = (view["items"] as JsonArray ?? []).OfType<JsonObject>().Select(row =>
        {
            var label = row["recordKind"]?.GetValue<string>() == "IMPORT" ? "目标导入" : "源交接";
            return new Option(row["handoffId"]?.GetValue<string>() ?? "",
                $"{label} · {row["sourceTaskId"]} → {row["target"]} · {row["phase"]}");
        }).ToArray();
        devices.ItemsSource = (view["devices"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(row => row["state"]?.GetValue<string>() == "ACTIVE").Select(row => new Option(
                row["deviceGrantId"]?.GetValue<string>() ?? "", $"{row["label"]} · {row["deviceGrantId"]}")).ToArray();
        if (handoffs.Items.Count == 0) notice.Text = "暂无可恢复的冻结交接。";

        async Task Apply(bool withdraw)
        {
            if (handoffs.SelectedItem is not Option record || devices.SelectedItem is not Option device)
            {
                notice.Text = "请选择恢复记录和新手机。";
                return;
            }
            grant.IsEnabled = revoke.IsEnabled = false;
            try
            {
                var reply = await call(new("setHandoffRecovery", Args: new JsonObject
                {
                    ["handoffId"] = record.Id, ["deviceId"] = device.Id, ["revoke"] = withdraw,
                }));
                notice.Text = reply.Ok ? (withdraw ? "已撤回恢复授权。" : "已授权，新手机可查回原交接。")
                    : reply.Error ?? "请检查新手机的目标权限。";
            }
            catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException)
            {
                notice.Text = "暂时无法连接网关。";
            }
            finally { grant.IsEnabled = revoke.IsEnabled = true; }
        }

        grant.Click += async (_, _) => await Apply(false);
        revoke.Click += async (_, _) => await Apply(true);
        Content = layout;
    }
}
