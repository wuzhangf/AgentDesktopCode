using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;

namespace AgentLink;

internal sealed class HandoffPeersWindow : Window
{
    internal HandoffPeersWindow(Func<LinkRequest, Task<LinkReply>> call, JsonObject identity, JsonObject directory)
    {
        Title = "跨电脑交接";
        Width = 570;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var own = new JsonObject();
        foreach (var field in new[] { "peerHostRef", "kid", "publicKey" })
            own[field] = identity[field]?.DeepClone();

        var layout = new StackPanel { Margin = new Thickness(18) };
        layout.Children.Add(new TextBlock { Text = "在两台电脑分别导入对方核对过的公钥。", Margin = new Thickness(0, 0, 0, 8) });
        var export = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, Text = own.ToJsonString() };
        layout.Children.Add(export);
        var copy = new Button { Content = "复制本机公钥", Margin = new Thickness(0, 8, 0, 12), HorizontalAlignment = HorizontalAlignment.Left };
        copy.Click += (_, _) => { export.Focus(); export.SelectAll(); export.Copy(); };
        layout.Children.Add(copy);
        var peers = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) };
        void ShowPeers(JsonObject data)
        {
            var names = (data["items"] as JsonArray ?? []).OfType<JsonObject>()
                .Select(row => $"{row["peerHostRef"]} · {row["kid"]}");
            peers.Text = string.Join(Environment.NewLine, names);
            if (peers.Text.Length == 0) peers.Text = "暂无受信任的对端";
        }
        ShowPeers(directory);
        layout.Children.Add(peers);
        layout.Children.Add(new TextBlock { Text = "对端公钥" });
        var input = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 78, MaxLength = 8192 };
        layout.Children.Add(input);
        var save = new Button { Content = "信任此对端", Margin = new Thickness(0, 8, 0, 0), HorizontalAlignment = HorizontalAlignment.Left };
        var notice = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
        layout.Children.Add(save);
        layout.Children.Add(notice);
        save.Click += async (_, _) =>
        {
            save.IsEnabled = false;
            try
            {
                if (JsonNode.Parse(input.Text) is not JsonObject peer
                    || peer["peerHostRef"] is not JsonValue || peer["kid"] is not JsonValue || peer["publicKey"] is not JsonValue)
                {
                    notice.Text = "请粘贴完整的对端公钥。";
                    return;
                }
                var reply = await call(new("setHandoffPeer", Args: peer));
                notice.Text = reply.Ok ? "已保存对端公钥。" : reply.Error ?? "无法保存对端公钥。";
                if (reply.Ok && (await call(new("handoffPeers"))).Data is JsonObject view) ShowPeers(view);
            }
            catch (Exception error) when (error is IOException or JsonException or TimeoutException or OperationCanceledException)
            {
                notice.Text = "无法读取对端公钥或连接网关。";
            }
            finally { save.IsEnabled = true; }
        };
        Content = layout;
    }
}
