using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using QRCoder;

namespace AgentLink;

public partial class LinkWindow : Window
{
    private readonly DispatcherTimer refresh = new() { Interval = TimeSpan.FromSeconds(2) };
    private readonly DispatcherTimer dismiss = new() { Interval = TimeSpan.FromMilliseconds(160) };
    private readonly Dictionary<string, (bool Ok, string? Detail, DateTime At)> probeCache = new();
    private readonly HashSet<string> expanded = new(StringComparer.OrdinalIgnoreCase);
    private bool working;
    private bool choosingWorker;
    private bool agentProbing;
    private long inviteExpires;
    private long dismissedAt = long.MinValue / 2;
    private string memberPhase = "NONE";

    internal bool JustDismissed => Environment.TickCount64 - dismissedAt < System.Windows.Forms.SystemInformation.DoubleClickTime;

    public LinkWindow()
    {
        InitializeComponent();
        ApplyTheme();
        Closing += (_, e) => { e.Cancel = true; Hide(); };
        Activated += (_, _) => { CancelDismissal(); ApplyTheme(); };
        Deactivated += (_, _) => { if (!choosingWorker) dismiss.Start(); };
        dismiss.Tick += (_, _) =>
        {
            CancelDismissal();
            if (!IsActive && !choosingWorker)
            {
                dismissedAt = Environment.TickCount64;
                Hide();
            }
        };
        IsVisibleChanged += (_, _) =>
        {
            if (IsVisible) refresh.Start();
            else { refresh.Stop(); CancelDismissal(); ClearInvite(); }
        };
        PreviewKeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) Hide(); };
        refresh.Tick += async (_, _) => await RefreshAsync();
        UpdateAutostart();
    }

    internal void OpenSettings()
    {
        UpdateAutostart();
        Tabs.SelectedItem = Settings;
    }

    internal void OpenAgentTab() => Tabs.SelectedIndex = 1;

    internal void BeginInvite()
    {
        Tabs.SelectedIndex = 0;
        Invite_Click(Invite, new RoutedEventArgs());
    }

    internal void BeginWorkerPick()
    {
        Tabs.SelectedIndex = 1;
        ConnectWorker_Click(this, new RoutedEventArgs());
    }

    /// <summary>Shows a one-off result line on the Agent tab (e.g. an engine test outcome).</summary>
    internal void ShowWorkerNotice(string text)
    {
        Tabs.SelectedIndex = 1;
        WorkerNotice.Text = text;
    }

    internal void CancelDismissal() => dismiss.Stop();

    private void ApplyTheme() => LinkTheme.Apply(Resources);

    internal async Task RefreshAsync()
    {
        if (working) return;
        working = true;
        try
        {
            var reply = await LinkProtocol.CallAsync(new("status"));
            var state = reply.Data?.Deserialize<LinkStatus>(LinkProtocol.Json);
            if (!reply.Ok || state is null) return;
            Summary.Text = state.Message == "后台已就绪" ? "手机连接已开启" : state.Message;
            Computer.Text = state.Computer;
            MachineAddress.Text = state.Ready ? AddressText(state.Origin) : "未连接";
            StatusDot.SetResourceReference(ShapeFill, state.Ready && state.Enabled ? "LinkReady" : "LinkSecondary");
            Address.Text = state.Ready ? "局域网连接" : "";
            Address.ToolTip = state.Origin;
            PhoneEnabled.IsEnabled = state.Ready;
            PhoneEnabled.IsChecked = state.Enabled;
            Invite.IsEnabled = state.Ready && state.Enabled;
            memberPhase = state.MemberState ?? "NONE";
            var memberDetail = state.MemberInfo;
            MemberInfo.Text = memberPhase switch
            {
                "LINKED" => "会员连接可用",
                "LINKING" => memberDetail is { Length: > 0 } code ? $"请在浏览器中确认 {code}" : "等待浏览器确认",
                "CONNECTING" => "会员连接中",
                "ERROR" => memberDetail ?? "会员连接需要处理",
                _ => memberDetail ?? "未登录",
            };
            MemberButton.Content = memberPhase switch
            {
                "LINKED" => "退出登录",
                "LINKING" => "取消",
                "ERROR" => "重试",
                _ => "登录会员",
            };
            MemberButton.IsEnabled = state.Ready && memberPhase is not "CONNECTING";
            if (inviteExpires <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && Qr.Source is not null)
                ClearInvite();
            if (!state.Enabled) ClearInvite();
            if (Tabs.SelectedIndex == 1 && state.Ready) await BuildAgentListAsync();
            if (Tabs.SelectedIndex == 0 && state.Ready)
            {
                ShowDevices((await LinkProtocol.CallAsync(new("devices"))).Data as JsonArray);
                if (state.PendingCount > 0)
                    ShowRequests((await LinkProtocol.CallAsync(new("requests"))).Data as JsonArray);
                else PairingRequests.Children.Clear();
            }
            else if (Tabs.SelectedIndex == 0) { DeviceList.Children.Clear(); PairingRequests.Children.Clear(); }
        }
        catch (Exception error) when (IsUnavailable(error))
        {
            Summary.Text = "正在连接后台";
            StatusDot.SetResourceReference(ShapeFill, "LinkSecondary");
            PhoneEnabled.IsEnabled = false;
            Invite.IsEnabled = false;
        }
        finally { working = false; }
    }

    private static string AddressText(string? origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? $"{uri.Host}:{uri.Port}" : "局域网连接";

    private void ShowDevices(JsonArray? devices)
    {
        DeviceList.Children.Clear();
        var list = devices?.OfType<JsonObject>().ToArray() ?? [];
        if (list.Length == 0)
        {
            DeviceList.Children.Add(new TextBlock
            {
                Text = "尚未配对手机", Style = (Style)Resources["SecondaryText"],
                Margin = new Thickness(0, 8, 0, 0),
            });
            return;
        }
        foreach (var device in list)
        {
            var active = Text(device, "state") == "ACTIVE";
            var label = Text(device, "label") ?? Text(device, "deviceGrantId")?[..8] ?? "手机";
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var icon = new Viewbox
            {
                Width = 16, Height = 16, Margin = new Thickness(0, 0, 10, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Child = new System.Windows.Shapes.Path
                {
                    Data = Geometry.Parse("M8,3 L16,3 L16,21 L8,21 Z M10.5,18.5 L13.5,18.5"),
                    Stroke = (Brush)Resources["LinkSecondary"], StrokeThickness = 1.5,
                    StrokeLineJoin = PenLineJoin.Round,
                    StrokeStartLineCap = PenLineCap.Round,
                    StrokeEndLineCap = PenLineCap.Round,
                },
            };
            var name = new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center };
            var state = new TextBlock
            {
                Text = active ? "在线" : "不可用", FontSize = 11,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Resources[active ? "LinkAccent" : "LinkSecondary"],
            };
            Grid.SetColumn(icon, 0); Grid.SetColumn(name, 1); Grid.SetColumn(state, 2);
            grid.Children.Add(icon); grid.Children.Add(name); grid.Children.Add(state);
            DeviceList.Children.Add(new Border
            {
                Padding = new Thickness(11, 8, 11, 8), Margin = new Thickness(0, 6, 0, 0),
                Background = (Brush)Resources["LinkSubtle"], CornerRadius = new CornerRadius(8),
                Child = grid,
            });
        }
    }

    private async Task BuildAgentListAsync()
    {
        var availability = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var reply = await LinkProtocol.CallAsync(new("agents"));
            var source = reply.Data;
            var backends = (source?["backends"] as JsonArray)?.OfType<JsonObject>().ToArray();
            if (backends is null || backends.Length == 0)
                backends = source is JsonObject primary ? [primary] : [];
            foreach (var backend in backends ?? [])
                foreach (var engine in (backend["engines"] as JsonArray)?.OfType<JsonObject>() ?? [])
                    if (Text(engine, "engineId") is { } id)
                        availability[id] = Text(engine, "availability") ?? "";
        }
        catch (Exception error) when (IsUnavailable(error)) { }

        var cards = WorkerCards.Enumerate();
        var current = WorkerCards.CurrentPath();
        if (current is not null
            && cards.All(c => !string.Equals(c.Path, current, StringComparison.OrdinalIgnoreCase))
            && WorkerCards.TryRead(current) is { } attached)
            cards.Add(attached);

        AgentList.Children.Clear();
        if (cards.Count == 0)
        {
            AgentList.Children.Add(new Border
            {
                Padding = new Thickness(11), Background = (Brush)Resources["LinkSubtle"],
                CornerRadius = new CornerRadius(8),
                Child = new TextBlock
                {
                    Text = "尚未发现运行中的 Agent。Worker 启动后会自动出现在这里；也可以手动选择它的注册卡。",
                    Style = (Style)Resources["SecondaryText"],
                },
            });
        }
        foreach (var card in cards)
            AgentList.Children.Add(AgentRow(card, current, availability));
        if (!agentProbing) _ = ProbeAgentsAsync(cards);
    }

    private FrameworkElement AgentRow(TrayWorkerCard card, string? current, Dictionary<string, string> availability)
    {
        var attached = string.Equals(card.Path, current, StringComparison.OrdinalIgnoreCase);
        var tint = TintBrush(card.Engine);
        var stack = new StackPanel();
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var badge = EngineBadge.Tile(card.Engine, tint);
        badge.Margin = new Thickness(0, 0, 10, 0);
        badge.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(badge, 0);

        var texts = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        texts.Children.Add(new TextBlock { Text = card.Name, FontWeight = FontWeights.SemiBold });
        var sub = card.Engine ?? "Worker";
        if (card.ProjectId is { Length: > 0 } project) sub += " · " + project;
        if (attached) sub += " · 接入中";
        else if (probeCache.TryGetValue(card.Path, out var probe))
            sub += probe.Ok ? " · 可达" : " · 不可达";
        texts.Children.Add(new TextBlock
        {
            Text = sub, FontSize = 11,
            Foreground = (Brush)Resources["LinkSecondary"],
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        Grid.SetColumn(texts, 1);

        var chevron = new TextBlock
        {
            Text = expanded.Contains(card.Path) ? "▾" : "▸", FontSize = 11,
            Foreground = (Brush)Resources["LinkSecondary"],
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(chevron, 2);

        var toggle = new CheckBox
        {
            Style = (Style)Resources["Switch"], IsChecked = attached,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 0, 0),
        };
        AutomationProperties.SetName(toggle, attached ? $"断开 {card.Name}" : $"接入 {card.Name}");
        Grid.SetColumn(toggle, 3);
        toggle.Click += async (_, _) =>
        {
            toggle.IsEnabled = false;
            try { await ActAsync(new(attached ? "detachWorker" : "worker", attached ? null : card.Path)); }
            finally { toggle.IsEnabled = true; }
        };

        head.Children.Add(badge);
        head.Children.Add(texts);
        head.Children.Add(chevron);
        head.Children.Add(toggle);

        var detail = AgentDetail(card);
        detail.Visibility = expanded.Contains(card.Path) ? Visibility.Visible : Visibility.Collapsed;
        head.MouseLeftButtonUp += (_, e) =>
        {
            if (Inside(e.OriginalSource as DependencyObject, toggle)) return;
            if (!expanded.Remove(card.Path)) expanded.Add(card.Path);
            detail.Visibility = expanded.Contains(card.Path) ? Visibility.Visible : Visibility.Collapsed;
            chevron.Text = expanded.Contains(card.Path) ? "▾" : "▸";
        };
        stack.Children.Add(head);
        stack.Children.Add(detail);
        return new Border
        {
            Padding = new Thickness(11), Margin = new Thickness(0, 0, 0, 8),
            Background = (Brush)Resources["LinkSubtle"], CornerRadius = new CornerRadius(8),
            Child = stack,
        };
    }

    private FrameworkElement AgentDetail(TrayWorkerCard card)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
        panel.Children.Add(new Border
        {
            Height = 1, Margin = new Thickness(0, 0, 0, 10),
            Background = (Brush)Resources["LinkLine"],
        });
        var actions = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
        var test = new Button
        {
            Content = "测试引擎", Padding = new Thickness(12, 4, 12, 4),
            MinHeight = 30, HorizontalAlignment = HorizontalAlignment.Left,
        };
        DockPanel.SetDock(test, Dock.Left);
        test.Click += async (_, _) =>
        {
            test.IsEnabled = false;
            try
            {
                var reply = await LinkProtocol.CallAsync(new("testWorker", card.Path));
                probeCache[card.Path] = (reply.Ok, reply.Ok
                    ? reply.Data?.GetValue<string>() : reply.Error, DateTime.UtcNow);
            }
            catch (Exception error) when (IsUnavailable(error))
            {
                probeCache[card.Path] = (false, "后台暂不可用", DateTime.UtcNow);
            }
            finally { test.IsEnabled = true; }
            await RefreshAsync();
        };
        var probeText = new TextBlock
        {
            Style = (Style)Resources["SecondaryText"], FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        if (probeCache.TryGetValue(card.Path, out var probe))
            probeText.Text = probe.Ok ? "引擎可达" : "引擎不可达";
        else probeText.Text = "等待探测";
        actions.Children.Add(test);
        actions.Children.Add(probeText);
        panel.Children.Add(actions);

        if (card.ProjectDir is { Length: > 0 } dir)
        {
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
            var open = new Button
            {
                Content = "打开", Padding = new Thickness(10, 2, 10, 2), MinHeight = 26,
                HorizontalAlignment = HorizontalAlignment.Right,
            };
            open.Click += (_, _) => OpenDirectory(dir);
            var pathText = new TextBlock
            {
                Text = dir, FontSize = 11, VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Resources["LinkSecondary"],
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            DockPanel.SetDock(open, Dock.Right);
            row.Children.Add(open);
            row.Children.Add(new TextBlock
            {
                Text = "工作区  ", FontWeight = FontWeights.SemiBold, FontSize = 11,
                VerticalAlignment = VerticalAlignment.Center,
            });
            row.Children.Add(pathText);
            panel.Children.Add(row);
        }

        var config = new List<string>();
        if (card.Engine is { } engine) config.Add("引擎  " + engine);
        if (card.ProjectId is { } pid) config.Add("项目  " + pid);
        if (card.ConnectionId is { } cid) config.Add("连接  " + cid);
        config.Add("注册卡  " + card.Path);
        panel.Children.Add(new TextBlock
        {
            Text = string.Join("\n", config), FontSize = 11,
            Foreground = (Brush)Resources["LinkSecondary"],
            TextWrapping = TextWrapping.Wrap,
        });
        return panel;
    }

    private async Task ProbeAgentsAsync(List<TrayWorkerCard> cards)
    {
        agentProbing = true;
        try
        {
            var stale = DateTime.UtcNow.AddSeconds(-30);
            foreach (var card in cards)
            {
                if (probeCache.TryGetValue(card.Path, out var cached) && cached.At > stale) continue;
                try
                {
                    var reply = await LinkProtocol.CallAsync(new("testWorker", card.Path));
                    probeCache[card.Path] = (reply.Ok,
                        reply.Ok ? reply.Data?.GetValue<string>() : reply.Error, DateTime.UtcNow);
                }
                catch (Exception error) when (IsUnavailable(error))
                {
                    probeCache[card.Path] = (false, "后台暂不可用", DateTime.UtcNow);
                }
            }
        }
        finally { agentProbing = false; }
        if (IsVisible && Tabs.SelectedIndex == 1) await BuildAgentListAsync();
    }

    private static bool Inside(DependencyObject? node, DependencyObject root)
    {
        while (node is not null)
        {
            if (ReferenceEquals(node, root)) return true;
            node = node is FrameworkElement element ? element.Parent : null;
        }
        return false;
    }

    private Brush TintBrush(string? engine)
    {
        if (TrayMenuModel.EngineTint(engine) is { } hex)
        {
            try { return new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); }
            catch (FormatException) { }
        }
        return (Brush)Resources["LinkSecondary"];
    }

    private static void OpenDirectory(string dir)
    {
        try
        {
            if (Path.IsPathFullyQualified(dir) && Directory.Exists(dir))
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
                    "explorer.exe", $"\"{dir}\"") { UseShellExecute = true });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException
            or System.ComponentModel.Win32Exception) { }
    }

    private void ShowRequests(JsonArray? requests)
    {
        PairingRequests.Children.Clear();
        foreach (var request in requests?.OfType<JsonObject>() ?? [])
        {
            var id = Text(request, "pairingRequestId");
            if (id is null || Text(request, "state") != "PENDING") continue;
            PairingRequests.Children.Add(new TextBlock
            {
                Text = (Text(request, "label") ?? "手机") + "  ·  " + Text(request, "checkWords"),
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0),
            });
            var approve = new Button { Content = "批准配对" };
            approve.Click += async (_, _) => await ActAsync(new("approve", id));
            var reject = new Button { Content = "拒绝" };
            reject.Click += async (_, _) => await ActAsync(new("reject", id));
            PairingRequests.Children.Add(approve);
            PairingRequests.Children.Add(reject);
        }
    }

    private async void Invite_Click(object sender, RoutedEventArgs e)
    {
        if (working) return;
        working = true;
        Invite.IsEnabled = false;
        try
        {
            var reply = await LinkProtocol.CallAsync(new("invite"));
            if (!reply.Ok || reply.Data is not JsonObject payload)
            {
                InviteHelp.Text = reply.Error ?? "邀请创建失败";
                return;
            }
            inviteExpires = payload["expiresAt"]?.GetValue<long>() ?? 0;
            using var generator = new QRCodeGenerator();
            using var data = generator.CreateQrCode(payload.ToJsonString(LinkProtocol.Json), QRCodeGenerator.ECCLevel.L);
            using var renderer = new PngByteQRCode(data);
            using var png = new MemoryStream(renderer.GetGraphic(6));
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.StreamSource = png;
            bitmap.EndInit();
            bitmap.Freeze();
            if (!IsVisible) return;
            Qr.Source = bitmap;
            QrCard.Visibility = Visibility.Visible;
            InviteHelp.Text = memberPhase == "LINKED"
                ? "在 Android 或 iPhone 的 Control 中扫码。会员连接可用时支持任意网络。"
                : "在 Android 或 iPhone 的 Control 中扫码。请连接同一个局域网。";
        }
        catch (Exception error) when (IsUnavailable(error))
        {
            InviteHelp.Text = "后台暂不可用，请稍后重试。";
        }
        finally { working = false; Invite.IsEnabled = true; }
    }

    private async void MemberButton_Click(object sender, RoutedEventArgs e)
    {
        if (working) return;
        var operation = memberPhase switch
        {
            "LINKED" => "memberLogout",
            "LINKING" => "memberCancel",
            _ => "memberLogin",
        };
        try
        {
            var reply = await LinkProtocol.CallAsync(new(operation));
            if (!reply.Ok) MemberInfo.Text = reply.Error ?? "操作失败";
        }
        catch (Exception error) when (IsUnavailable(error)) { MemberInfo.Text = "后台暂不可用。"; }
        await RefreshAsync();
    }

    private async void ConnectionSwitch_Click(object sender, RoutedEventArgs e)
    {
        if (working) return;
        await ActAsync(new(PhoneEnabled.IsChecked == true ? "enable" : "disable"));
    }

    private async Task ActAsync(LinkRequest request)
    {
        if (working) return;
        working = true;
        try
        {
            var reply = await LinkProtocol.CallAsync(request);
            if (!reply.Ok) InviteHelp.Text = reply.Error;
        }
        catch (Exception error) when (IsUnavailable(error)) { InviteHelp.Text = "后台暂不可用。"; }
        finally { working = false; }
        await RefreshAsync();
    }

    private void ClearInvite()
    {
        if (Qr.Source is not null) InviteHelp.Text = "";
        Qr.Source = null;
        QrCard.Visibility = Visibility.Collapsed;
        inviteExpires = 0;
    }

    private static DependencyProperty ShapeFill => System.Windows.Shapes.Shape.FillProperty;

    private void Settings_Click(object sender, RoutedEventArgs e) => OpenSettings();

    private async void Tabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (IsVisible && ReferenceEquals(e.Source, Tabs)) await RefreshAsync();
    }

    private async void ConnectWorker_Click(object sender, RoutedEventArgs e)
    {
        var chooser = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择 Worker 注册卡", Filter = "Worker 注册卡 (*.json)|*.json",
            CheckFileExists = true,
        };
        var cards = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agent-gateway", "workers.d");
        if (Directory.Exists(cards)) chooser.InitialDirectory = cards;
        choosingWorker = true;
        CancelDismissal();
        bool selected;
        try { selected = chooser.ShowDialog(this) == true; }
        finally { choosingWorker = false; }
        if (!selected) return;
        try
        {
            var reply = await LinkProtocol.CallAsync(new("worker", chooser.FileName));
            WorkerNotice.Text = reply.Ok ? "Worker 已接入。" : reply.Error;
        }
        catch (Exception error) when (IsUnavailable(error)) { WorkerNotice.Text = "后台暂不可用。"; }
        await RefreshAsync();
    }

    private void Autostart_Click(object sender, RoutedEventArgs e)
    {
        try { StartupEntry.Set(Autostart.IsChecked == true); UpdateAutostart(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            StartupNotice.Text = error.Message;
        }
    }

    private void UpdateAutostart()
    {
        Autostart.IsChecked = StartupEntry.Registered();
        StartupNotice.Text = StartupEntry.DisabledByWindows()
            ? "请在 Windows 的「启动应用」设置中启用 Agent Link。"
            : "登录后在托盘运行，关闭面板时后台继续连接。";
    }

    private static string? Text(JsonNode? node, string name) => node?[name]?.GetValue<string>();

    private static bool IsUnavailable(Exception error) =>
        error is TimeoutException or IOException or OperationCanceledException or JsonException;
}
