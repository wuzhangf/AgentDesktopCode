using System.Globalization;
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
    private readonly Dictionary<string, (bool? Ok, DateTime At)> probeCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> expanded = new(StringComparer.OrdinalIgnoreCase);
    private bool working;
    private bool choosingWorker;
    private bool agentProbing;
    private int statusMisses;
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
        UpdateSettings.Visibility = StartupEntry.ScheduledUpdatesAvailable ? Visibility.Visible : Visibility.Collapsed;
        if (StartupEntry.ScheduledUpdatesAvailable)
        {
            var preferences = new WindowsUpdateSchedule(LinkProtocol.Root).Preferences();
            AutoUpdate.IsChecked = preferences.Enabled;
            PauseMetered.IsChecked = preferences.PauseOnMetered;
            UpdateWindowStart.Text = preferences.WindowStart?.ToString("HH:mm", CultureInfo.InvariantCulture) ?? "";
            UpdateWindowEnd.Text = preferences.WindowEnd?.ToString("HH:mm", CultureInfo.InvariantCulture) ?? "";
            UpdateNotice.Text = "";
            RefreshUpdateStatus();
        }
        Tabs.SelectedItem = Settings;
    }

    internal void OpenAgentTab() => Tabs.SelectedIndex = 1;
    internal void OpenConnectionTab() => Tabs.SelectedIndex = 0;

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
        if (Tabs.SelectedItem == Settings && StartupEntry.ScheduledUpdatesAvailable) RefreshUpdateStatus();
        working = true;
        try
        {
            if (inviteExpires <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && Qr.Source is not null)
                ClearInvite();
            var reply = await LinkProtocol.CallAsync(new("status"));
            var state = reply.Ok ? reply.Data?.Deserialize<LinkStatus>(LinkProtocol.Json) : null;
            if (state is null)
            {
                ShowStatusMiss();
                return;
            }
            statusMisses = 0;
            Summary.Text = state.Message == "后台已就绪" ? "手机连接已开启" : state.Message;
            Computer.Text = state.Computer;
            MachineAddress.Text = state.Ready ? AddressText(state.Origin) : "未连接";
            StatusDot.SetResourceReference(ShapeFill, state.Ready && state.Enabled ? "LinkReady" : "LinkSecondary");
            Address.Text = state.Ready ? "局域网连接" : "";
            Address.ToolTip = state.Origin;
            PhoneEnabled.IsEnabled = state.Ready;
            PhoneEnabled.IsChecked = state.Enabled;
            PairingApproval.IsEnabled = state.Ready;
            PairingApproval.IsChecked = state.PairingApprovalRequired;
            Invite.IsEnabled = state.Ready && state.Enabled;
            InviteAcs.Visibility = state.AcsSessionCreate ? Visibility.Visible : Visibility.Collapsed;
            InviteAcs.IsEnabled = state.Ready && state.Enabled;
            if (!state.AcsSessionCreate) InviteAcs.IsChecked = false;
            memberPhase = state.MemberState ?? "NONE";
            MemberFiles.IsEnabled = memberPhase == "LINKED";
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
            if (state.Ready && !state.Enabled) ClearInvite();
            AgentList.IsEnabled = state.Ready;
            DeviceList.IsEnabled = state.Ready;
            PairingRequests.IsEnabled = state.Ready;
            if (!state.Ready) return;

            if (Tabs.SelectedIndex == 1) await BuildAgentListAsync();
            else if (Tabs.SelectedIndex == 0)
            {
                if (await ReadListAsync("devices") is { } devices) ShowDevices(devices);
                if (state.PendingCount == 0) ShowRequests(new JsonArray());
                else if (await ReadListAsync("requests") is { } requests) ShowRequests(requests);
            }
        }
        catch (Exception error) when (IsUnavailable(error))
        {
            ShowStatusMiss();
        }
        finally { working = false; }
    }

    private void ShowStatusMiss()
    {
        // One missed poll can be caused by another caller using the same pipe.
        if (statusMisses < 3) statusMisses++;
        if (statusMisses < 3) return;
        Summary.Text = "正在重连后台";
        StatusDot.SetResourceReference(ShapeFill, "LinkSecondary");
        PhoneEnabled.IsEnabled = false;
        PairingApproval.IsEnabled = false;
        Invite.IsEnabled = false;
        InviteAcs.IsEnabled = false;
        MemberButton.IsEnabled = false;
        MemberFiles.IsEnabled = false;
        AgentList.IsEnabled = false;
        DeviceList.IsEnabled = false;
        PairingRequests.IsEnabled = false;
    }

    private static async Task<JsonArray?> ReadListAsync(string operation)
    {
        try
        {
            var reply = await LinkProtocol.CallAsync(new(operation));
            return reply.Ok ? reply.Data as JsonArray : null;
        }
        catch (Exception error) when (IsUnavailable(error)) { return null; }
    }

    private static string AddressText(string? origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? $"{uri.Host}:{uri.Port}" : "局域网连接";

    private string? deviceListSig;
    private string? agentListSig;

    private void ShowDevices(JsonArray devices)
    {
        var list = devices.OfType<JsonObject>()
            .Where(d => Text(d, "state") != "REVOKED").ToArray();
        var sig = JsonSerializer.Serialize(list.Select(d =>
            new { Id = Text(d, "deviceGrantId"), Label = Text(d, "label"), State = Text(d, "state") }), LinkProtocol.Json);
        if (sig == deviceListSig) return;
        deviceListSig = sig;
        DeviceList.Children.Clear();
        DeviceList.Children.Add(new Border
        {
            Height = 1, Margin = new Thickness(0, 12, 0, 0),
            Background = (Brush)Resources["LinkLine"],
        });
        DeviceList.Children.Add(new TextBlock
        {
            Text = "手机", FontWeight = FontWeights.SemiBold, FontSize = 12,
            Margin = new Thickness(2, 8, 0, 0),
        });
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
            var grant = Text(device, "deviceGrantId");
            var label = Text(device, "label") ?? grant?[..8] ?? "手机";
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
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
            if (grant is { Length: > 0 })
            {
                var unpair = new Button
                {
                    Content = "解除", FontSize = 11, MinHeight = 24,
                    Padding = new Thickness(8, 1, 8, 1), Margin = new Thickness(8, 0, 0, 0),
                    Background = Brushes.Transparent,
                    VerticalAlignment = VerticalAlignment.Center,
                };
                AutomationProperties.SetName(unpair, $"解除配对 {label}");
                var confirming = false;
                var reset = new System.Windows.Threading.DispatcherTimer
                {
                    Interval = TimeSpan.FromSeconds(3),
                };
                reset.Tick += (_, _) =>
                {
                    confirming = false;
                    unpair.Content = "解除";
                    unpair.ClearValue(ForegroundProperty);
                    reset.Stop();
                };
                unpair.Click += async (_, _) =>
                {
                    if (!confirming)
                    {
                        confirming = true;
                        unpair.Content = "确认解除？";
                        unpair.Foreground = new SolidColorBrush(Color.FromRgb(0xDC, 0x26, 0x26));
                        reset.Start();
                        return;
                    }
                    reset.Stop();
                    await ActAsync(new("revokeDevice", grant));
                };
                Grid.SetColumn(unpair, 3);
                grid.Children.Add(unpair);
            }
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
        List<ManagedAgent>? managed;
        try
        {
            var reply = await LinkProtocol.CallAsync(new("managedAgents"));
            managed = reply.Ok && reply.Data is JsonArray rows
                ? rows.Deserialize<List<ManagedAgent>>(LinkProtocol.Json) : null;
        }
        catch (Exception error) when (IsUnavailable(error)) { return; }
        if (managed is null) return;

        var cards = WorkerCards.Enumerate();
        var current = WorkerCards.CurrentPaths();
        foreach (var path in current.Where(p => cards.All(c =>
            !string.Equals(c.Path, p, StringComparison.OrdinalIgnoreCase))))
            if (WorkerCards.TryRead(path) is { } attached) cards.Add(attached);

        RenderAgentList(managed, cards, current);
        if (agentProbing || !IsVisible || Tabs.SelectedIndex != 1) return;
        var stale = DateTime.UtcNow.AddSeconds(-30);
        var due = cards.FirstOrDefault(card =>
            !probeCache.TryGetValue(card.Path, out var cached) || cached.At <= stale);
        if (due is not null) _ = ProbeAgentAsync(due.Path);
    }

    private void RenderAgentList(List<ManagedAgent> managed, List<TrayWorkerCard> cards, IReadOnlyList<string> current)
    {
        var sig = JsonSerializer.Serialize(new
        {
            Managed = managed,
            External = cards.Select(card => new
            {
                Card = card,
                Attached = current.Contains(card.Path, StringComparer.OrdinalIgnoreCase),
                Reachable = probeCache.TryGetValue(card.Path, out var result) ? result.Ok : null,
            }),
        }, LinkProtocol.Json);
        if (sig == agentListSig) return;
        agentListSig = sig;

        AgentList.Children.Clear();
        foreach (var agent in managed)
            AgentList.Children.Add(ManagedRow(agent));
        if (managed.Count == 0 && cards.Count == 0)
        {
            AgentList.Children.Add(new Border
            {
                Padding = new Thickness(11), Background = (Brush)Resources["LinkSubtle"],
                CornerRadius = new CornerRadius(8),
                Child = new TextBlock
                {
                    Text = "尚未接入 Agent。点「注册工作区」选择引擎和目录即可接入；运行中的外部 Worker 也会自动出现在这里。",
                    Style = (Style)Resources["SecondaryText"],
                },
            });
        }
        foreach (var card in cards)
            AgentList.Children.Add(AgentRow(card, current));
    }

    private static string ManagedTitle(ManagedAgent agent)
    {
        var name = Path.GetFileName(agent.Project.TrimEnd(Path.DirectorySeparatorChar));
        var engine = agent.Engine switch
        {
            "claude" => "Claude",
            "codex" => "Codex",
            "pi" => "Sage Pi",
            "devin" => "Devin",
            _ => agent.Engine,
        };
        return engine + " · " + (name is { Length: > 0 } ? name : "workspace");
    }

    private FrameworkElement ManagedRow(ManagedAgent agent)
    {
        var tint = TintBrush(agent.Engine);
        var expandKey = "m:" + agent.Key;
        var stack = new StackPanel();
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var badge = EngineBadge.Tile(agent.Engine, tint);
        badge.Margin = new Thickness(0, 0, 10, 0);
        badge.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(badge, 0);

        var texts = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        texts.Children.Add(new TextBlock { Text = ManagedTitle(agent), FontWeight = FontWeights.SemiBold });
        var sub = agent.Engine + (agent.SkipPermissions ? " · 免审批" : " · 需审批")
            + (agent.Running ? " · 运行中" : agent.Enabled ? " · 启动中" : " · 已停用");
        if (agent.Detail is { Length: > 0 }) sub += " · " + agent.Detail;
        texts.Children.Add(new TextBlock
        {
            Text = sub, FontSize = 11,
            Foreground = (Brush)Resources["LinkSecondary"],
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        Grid.SetColumn(texts, 1);

        var chevron = new TextBlock
        {
            Text = expanded.Contains(expandKey) ? "▾" : "▸", FontSize = 11,
            Foreground = (Brush)Resources["LinkSecondary"],
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(chevron, 2);

        var toggle = new CheckBox
        {
            Style = (Style)Resources["Switch"], IsChecked = agent.Enabled,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 0, 0),
        };
        AutomationProperties.SetName(toggle, agent.Enabled ? $"停用 {ManagedTitle(agent)}" : $"启用 {ManagedTitle(agent)}");
        Grid.SetColumn(toggle, 3);
        toggle.Click += async (_, _) =>
        {
            toggle.IsEnabled = false;
            try
            {
                await ActAsync(new("agentSet", agent.Key,
                    new JsonObject { ["enabled"] = !agent.Enabled }));
            }
            finally { toggle.IsEnabled = true; }
        };

        head.Children.Add(badge);
        head.Children.Add(texts);
        head.Children.Add(chevron);
        head.Children.Add(toggle);

        var detail = ManagedDetail(agent);
        detail.Visibility = expanded.Contains(expandKey) ? Visibility.Visible : Visibility.Collapsed;
        head.MouseLeftButtonUp += (_, e) =>
        {
            if (Inside(e.OriginalSource as DependencyObject, toggle)) return;
            if (!expanded.Remove(expandKey)) expanded.Add(expandKey);
            detail.Visibility = expanded.Contains(expandKey) ? Visibility.Visible : Visibility.Collapsed;
            chevron.Text = expanded.Contains(expandKey) ? "▾" : "▸";
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

    private FrameworkElement ManagedDetail(ManagedAgent agent)
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
            IsEnabled = agent.Running,
        };
        DockPanel.SetDock(test, Dock.Left);
        test.Click += async (_, _) =>
        {
            test.IsEnabled = false;
            try
            {
                var reply = await LinkProtocol.CallAsync(new("agentTest", agent.Key));
                WorkerNotice.Text = reply.Ok ? "✓ " + ManagedTitle(agent) + " · 引擎可用"
                    : "✗ " + ManagedTitle(agent) + " · " + (reply.Error ?? "测试失败");
            }
            catch (Exception error) when (IsUnavailable(error)) { WorkerNotice.Text = "后台暂不可用。"; }
            finally { test.IsEnabled = true; }
        };
        var remove = new Button
        {
            Content = "删除注册", Padding = new Thickness(12, 4, 12, 4),
            MinHeight = 30, HorizontalAlignment = HorizontalAlignment.Right,
        };
        DockPanel.SetDock(remove, Dock.Right);
        remove.Click += async (_, _) =>
        {
            if (MessageBox.Show("删除后此工作区注册将从列表中移除（目录文件不受影响）。", "Agent Link",
                MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            await ActAsync(new("agentRemove", agent.Key));
        };
        actions.Children.Add(test);
        actions.Children.Add(remove);
        panel.Children.Add(actions);

        // Store engines are read-only (store listing + adopt + questions) —
        // no spawned CLI exists for skip-permissions or a route to act on.
        if (agent.Executable is not null)
        {
        var skip = new CheckBox
        {
            Content = "免审批执行（跳过工具确认；关闭后按各家 CLI 默认规则，可能被拒）",
            IsChecked = agent.SkipPermissions, Margin = new Thickness(0, 0, 0, 8),
        };
        skip.Click += async (_, _) =>
        {
            skip.IsEnabled = false;
            try
            {
                await ActAsync(new("agentSet", agent.Key,
                    new JsonObject { ["skipPermissions"] = skip.IsChecked == true }));
            }
            finally { skip.IsEnabled = true; }
        };
        panel.Children.Add(skip);
        }

        var row = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
        var pick = new Button
        {
            Content = "切换…", Padding = new Thickness(10, 2, 10, 2), MinHeight = 26,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        pick.Click += async (_, _) =>
        {
            var chooser = new Microsoft.Win32.OpenFolderDialog { Title = "选择工作区目录" };
            if (chooser.ShowDialog(this) != true) return;
            await ActAsync(new("agentSet", agent.Key,
                new JsonObject { ["project"] = chooser.FolderName }));
        };
        var open = new Button
        {
            Content = "打开", Padding = new Thickness(10, 2, 10, 2), MinHeight = 26,
            HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(6, 0, 0, 0),
        };
        open.Click += (_, _) => OpenDirectory(agent.Project);
        var pathText = new TextBlock
        {
            Text = agent.Project, FontSize = 11, VerticalAlignment = VerticalAlignment.Center,
            Foreground = (Brush)Resources["LinkSecondary"],
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        DockPanel.SetDock(open, Dock.Right);
        DockPanel.SetDock(pick, Dock.Right);
        row.Children.Add(open);
        row.Children.Add(pick);
        row.Children.Add(new TextBlock
        {
            Text = "工作区  ", FontWeight = FontWeights.SemiBold, FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center,
        });
        row.Children.Add(pathText);
        panel.Children.Add(row);

        if (agent.Engine is "codex" or "claude")
        {
            var historyPanel = new StackPanel { Margin = new Thickness(0, 0, 0, 8) };
            var histRow = new DockPanel { Margin = new Thickness(0, 0, 0, 6) };
            var histButton = new Button
            {
                Content = "查看…", Padding = new Thickness(10, 2, 10, 2), MinHeight = 26,
                HorizontalAlignment = HorizontalAlignment.Right,
            };
            DockPanel.SetDock(histButton, Dock.Right);
            histRow.Children.Add(histButton);
            histRow.Children.Add(new TextBlock
            {
                Text = "历史会话  ", FontWeight = FontWeights.SemiBold, FontSize = 11,
                VerticalAlignment = VerticalAlignment.Center,
            });
            histButton.Click += async (_, _) =>
            {
                histButton.IsEnabled = false;
                try { await LoadHistoryAsync(agent, historyPanel); }
                finally { histButton.IsEnabled = true; }
            };
            panel.Children.Add(histRow);
            panel.Children.Add(historyPanel);
        }

        // Provider choice: official login vs cc-switch route — the same
        // decision the desktop model picker encodes, as a plain either/or.
        // Read-only store engines get no picker: nothing here could route.
        if (agent.Executable is not null)
        {
            var provRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };
            provRow.Children.Add(new TextBlock
            {
                Text = "模型来源", FontSize = 11, VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Resources["LinkSecondary"], Margin = new Thickness(0, 0, 8, 0),
            });
            var prov = new ComboBox { MinWidth = 220, FontSize = 12 };
            prov.Items.Add("自动");
            prov.Items.Add(agent.Engine == "codex" ? "OpenAI 官方" : agent.Engine == "claude" ? "Claude 官方" : "官方");
            prov.Items.Add(agent.CcRoute is { } r ? "CC 路由 · " + r : "CC 路由");
            prov.SelectedIndex = agent.Provider switch { "official" => 1, "cc" => 2, _ => 0 };
            var provApplying = false;
            prov.SelectionChanged += async (_, _) =>
            {
                if (provApplying) return;
                var value = prov.SelectedIndex switch { 1 => "official", 2 => "cc", _ => null };
                if (value == agent.Provider) return;
                prov.IsEnabled = false;
                try { await ActAsync(new("agentSet", agent.Key, new JsonObject { ["provider"] = value })); }
                finally { prov.IsEnabled = true; }
            };
            provRow.Children.Add(prov);
            panel.Children.Add(provRow);
        }

        if (agent.Provider != "official" && agent.Models is { Count: > 0 } models)
        {
            // cc-switch route model menu — same choice Claude Desktop's picker
            // makes, sent to the upstream verbatim.
            var modelRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };
            modelRow.Children.Add(new TextBlock
            {
                Text = "模型", FontSize = 11, VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)Resources["LinkSecondary"], Margin = new Thickness(0, 0, 8, 0),
            });
            var picker = new ComboBox { MinWidth = 180, FontSize = 12 };
            foreach (var id in models) picker.Items.Add(id);
            picker.SelectedItem = agent.Model is { } m && models.Contains(m) ? m : models[0];
            var applying = false;
            picker.SelectionChanged += async (_, _) =>
            {
                if (applying || picker.SelectedItem is not string next || next == agent.Model) return;
                picker.IsEnabled = false;
                try { await ActAsync(new("agentSet", agent.Key, new JsonObject { ["model"] = next })); }
                finally { picker.IsEnabled = true; }
            };
            modelRow.Children.Add(picker);
            panel.Children.Add(modelRow);
        }

        var config = new List<string> { "引擎  " + agent.Engine };
        if (agent.Model is { } model) config.Add("模型  " + model);
        if (agent.CcRoute is { } route) config.Add("cc 路由  " + route);
        if (agent.Executable is { } exe) config.Add("可执行文件  " + exe);
        if (agent.ConnectionId is { } cid) config.Add("连接  " + cid);
        panel.Children.Add(new TextBlock
        {
            Text = string.Join("\n", config), FontSize = 11,
            Foreground = (Brush)Resources["LinkSecondary"],
            TextWrapping = TextWrapping.Wrap,
        });
        return panel;
    }

    /// <summary>Reads this engine's local vendor-CLI session files (read-only,
    /// via the Host's cli-bridge history subcommand) and lists them inline.</summary>
    private async Task LoadHistoryAsync(ManagedAgent agent, StackPanel target)
    {
        target.Children.Clear();
        target.Children.Add(new TextBlock { Text = "读取中…", Style = (Style)Resources["SecondaryText"] });
        try
        {
            var reply = await LinkProtocol.CallAsync(new("agentHistory",
                Args: new JsonObject { ["engine"] = agent.Engine }));
            var sessions = (reply.Data?["sessions"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
            target.Children.Clear();
            if (sessions.Length == 0)
            {
                target.Children.Add(new TextBlock
                {
                    Text = "本机没有此引擎的会话记录",
                    Style = (Style)Resources["SecondaryText"],
                });
            }
            foreach (var session in sessions)
            {
                var at = DateTimeOffset.TryParse(Text(session, "at"), out var t)
                    ? t.ToLocalTime().ToString("MM-dd HH:mm") : "";
                var title = Text(session, "title") is { Length: > 0 } tt
                    ? tt : Text(session, "id")?[..Math.Min(8, Text(session, "id")!.Length)] ?? "会话";
                var file = Text(session, "file");
                var rowPanel = new DockPanel { Margin = new Thickness(0, 0, 0, 3) };
                var adopt = new Button
                {
                    Content = "接管", FontSize = 10, Padding = new Thickness(8, 1, 8, 1),
                    MinHeight = 24, HorizontalAlignment = HorizontalAlignment.Right,
                    IsEnabled = agent.Enabled,
                    ToolTip = agent.Enabled
                        ? "把此会话接入此工作区：历史导入账本，下一条消息续跑原会话"
                        : "先启用此工作区",
                };
                adopt.Click += async (_, _) =>
                {
                    adopt.IsEnabled = false;
                    try
                    {
                        var reply = await LinkProtocol.CallAsync(new("agentAdopt", agent.Key,
                            new JsonObject { ["file"] = file, ["title"] = title }));
                        WorkerNotice.Text = reply.Ok
                            ? "已接管——手机端此工作区下出现对应任务，继续对话会续跑原会话"
                            : reply.Error;
                    }
                    catch (Exception error) when (IsUnavailable(error)) { WorkerNotice.Text = "后台暂不可用。"; }
                    finally { adopt.IsEnabled = true; }
                };
                var row = new Button
                {
                    Content = $"{at}  {title}", FontSize = 11, MinHeight = 26,
                    HorizontalContentAlignment = HorizontalAlignment.Left,
                    Padding = new Thickness(8, 2, 8, 2),
                };
                row.Click += async (_, _) => await ShowHistoryAsync(agent, file!, title);
                DockPanel.SetDock(adopt, Dock.Right);
                rowPanel.Children.Add(adopt);
                rowPanel.Children.Add(row);
                target.Children.Add(rowPanel);
            }
        }
        catch (Exception error) when (IsUnavailable(error))
        {
            target.Children.Clear();
            target.Children.Add(new TextBlock
            {
                Text = "后台暂不可用", Style = (Style)Resources["SecondaryText"],
            });
        }
    }

    /// <summary>Fetches one session file's messages and shows them in a
    /// read-only window (last 60, vendor-injected context rows filtered).</summary>
    private async Task ShowHistoryAsync(ManagedAgent agent, string file, string title)
    {
        try
        {
            var reply = await LinkProtocol.CallAsync(new("agentHistoryRead",
                Args: new JsonObject { ["engine"] = agent.Engine, ["file"] = file }));
            var messages = (reply.Data?["messages"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
            var view = new Window
            {
                Owner = this, Title = title, Width = 560, Height = 640,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
            };
            LinkTheme.Apply(view.Resources);
            var list = new StackPanel { Margin = new Thickness(16) };
            if (reply.Data?["truncated"]?.GetValue<bool>() == true)
                list.Children.Add(new TextBlock
                {
                    Text = "仅显示最近 60 条", Margin = new Thickness(0, 0, 0, 10),
                    Style = (Style)view.Resources["SecondaryText"],
                });
            foreach (var m in messages)
            {
                var role = Text(m, "role");
                list.Children.Add(new TextBlock
                {
                    Text = role == "user" ? "你" : role == "assistant" ? "助手" : role ?? "?",
                    FontWeight = FontWeights.SemiBold, FontSize = 11,
                    Margin = new Thickness(0, 10, 0, 2),
                });
                list.Children.Add(new TextBlock
                {
                    Text = Text(m, "text"), TextWrapping = TextWrapping.Wrap, FontSize = 12,
                });
            }
            if (messages.Length == 0)
                list.Children.Add(new TextBlock { Text = "此会话没有可显示的消息。" });
            view.Content = new ScrollViewer
            {
                Content = list,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            };
            view.Show();
        }
        catch (Exception error) when (IsUnavailable(error)) { WorkerNotice.Text = "后台暂不可用。"; }
    }

    internal void BeginAgentRegister()
    {
        Tabs.SelectedIndex = 1;
        RegisterForm.Visibility = Visibility.Visible;
        RegisterProject.Focus();
    }

    private void RegisterAgent_Click(object sender, RoutedEventArgs e) =>
        RegisterForm.Visibility = RegisterForm.Visibility == Visibility.Visible
            ? Visibility.Collapsed : Visibility.Visible;

    private void RegisterCancel_Click(object sender, RoutedEventArgs e) =>
        RegisterForm.Visibility = Visibility.Collapsed;

    private void RegisterProjectPick_Click(object sender, RoutedEventArgs e)
    {
        var chooser = new Microsoft.Win32.OpenFolderDialog { Title = "选择工作区目录" };
        if (chooser.ShowDialog(this) == true) RegisterProject.Text = chooser.FolderName;
    }

    private void RegisterExePick_Click(object sender, RoutedEventArgs e)
    {
        var chooser = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择引擎可执行文件", Filter = "可执行文件 (*.exe;*.cmd;*.bat)|*.exe;*.cmd;*.bat|全部 (*.*)|*.*",
            CheckFileExists = true,
        };
        if (chooser.ShowDialog(this) == true) RegisterExe.Text = chooser.FileName;
    }

    private async void RegisterSubmit_Click(object sender, RoutedEventArgs e)
    {
        var project = RegisterProject.Text.Trim();
        if (project.Length == 0 || !Directory.Exists(project))
        {
            WorkerNotice.Text = "请选择存在的工作区目录。";
            return;
        }
        var engine = RegisterEngine.Text?.Trim() is { Length: > 0 } typed
            ? typed : "claude";
        var args = new JsonObject
        {
            ["engine"] = engine,
            ["project"] = project,
            ["skipPermissions"] = RegisterSkip.IsChecked == true,
        };
        if (RegisterExe.Text.Trim() is { Length: > 0 } exe) args["executable"] = exe;
        if (RegisterModel.Text.Trim() is { Length: > 0 } model) args["model"] = model;
        RegisterSubmit.IsEnabled = false;
        try
        {
            var reply = await LinkProtocol.CallAsync(new("agentAdd", Args: args));
            WorkerNotice.Text = reply.Ok ? "已注册，正在启动引擎…" : reply.Error;
            if (reply.Ok) RegisterForm.Visibility = Visibility.Collapsed;
        }
        catch (Exception error) when (IsUnavailable(error)) { WorkerNotice.Text = "后台暂不可用。"; }
        finally { RegisterSubmit.IsEnabled = true; }
        await RefreshAsync();
    }

    private FrameworkElement AgentRow(TrayWorkerCard card, IReadOnlyList<string> current)
    {
        var attached = current.Contains(card.Path, StringComparer.OrdinalIgnoreCase);
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
        else if (probeCache.TryGetValue(card.Path, out var probe) && probe.Ok is { } reachable)
            sub += reachable ? " · 可达" : " · 不可达";
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
            try { await ActAsync(new(attached ? "detachWorker" : "worker", card.Path)); }
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
                await ProbeWorkerAsync(card.Path);
            }
            catch (Exception error) when (IsUnavailable(error))
            {
                WorkerNotice.Text = "后台暂不可用。";
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
        if (probeCache.TryGetValue(card.Path, out var probe) && probe.Ok is { } reachable)
            probeText.Text = reachable ? "引擎可达" : "引擎不可达";
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

    private async Task ProbeAgentAsync(string path)
    {
        agentProbing = true;
        try { await ProbeWorkerAsync(path); }
        catch (Exception error) when (IsUnavailable(error)) { }
        finally { agentProbing = false; }
    }

    private async Task ProbeWorkerAsync(string path)
    {
        probeCache[path] = (probeCache.GetValueOrDefault(path).Ok, DateTime.UtcNow);
        var reply = await LinkProtocol.CallAsync(new("testWorker", path));
        if (reply.Error != "后台网关暂未就绪") probeCache[path] = (reply.Ok, DateTime.UtcNow);
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

    private string? requestsSig;

    private void ShowRequests(JsonArray requests)
    {
        var sig = requests.ToJsonString();
        if (sig == requestsSig) return;
        requestsSig = sig;
        PairingRequests.Children.Clear();
        foreach (var request in requests.OfType<JsonObject>())
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
            var reply = await LinkProtocol.CallAsync(new("invite",
                Args: new JsonObject { ["createAcs"] = InviteAcs.IsChecked == true }));
            if (!reply.Ok || reply.Data is not JsonObject payload)
            {
                InviteHelp.Text = reply.Error ?? "邀请创建失败";
                return;
            }
            inviteExpires = payload["expiresAt"]?.GetValue<long>() ?? 0;
            InviteAcs.IsChecked = false;
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
            QrHelp.Text = memberPhase == "LINKED"
                ? "在 Android 或 iPhone 的 Control 中扫码。会员连接可用时支持任意网络。"
                : "在 Android 或 iPhone 的 Control 中扫码。请连接同一个局域网。";
            QrOverlay.Visibility = Visibility.Visible;
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

    private void MemberFiles_Click(object sender, RoutedEventArgs e)
    {
        choosingWorker = true;
        CancelDismissal();
        try { new LinkFilesWindow { Owner = this }.ShowDialog(); }
        finally { choosingWorker = false; }
    }

    private async void ConnectionSwitch_Click(object sender, RoutedEventArgs e)
    {
        if (working) return;
        await ActAsync(new(PhoneEnabled.IsChecked == true ? "enable" : "disable"));
    }

    private async void PairingApproval_Click(object sender, RoutedEventArgs e)
    {
        if (working) return;
        await ActAsync(new("pairingApproval",
            Args: new JsonObject { ["required"] = PairingApproval.IsChecked == true }));
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

    private void QrClose_Click(object sender, RoutedEventArgs e) => ClearInvite();

    private void ClearInvite()
    {
        Qr.Source = null;
        QrOverlay.Visibility = Visibility.Collapsed;
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

    private void SaveUpdateSettings_Click(object sender, RoutedEventArgs e)
    {
        var startText = UpdateWindowStart.Text.Trim();
        var endText = UpdateWindowEnd.Text.Trim();
        TimeOnly? start = null, end = null;
        if (startText.Length != 0 || endText.Length != 0)
        {
            if (!TimeOnly.TryParseExact(startText, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from) ||
                !TimeOnly.TryParseExact(endText, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var to) ||
                from == to)
            {
                UpdateNotice.Text = "请填写不同的开始和结束时间（HH:mm），或同时留空。";
                return;
            }
            (start, end) = (from, to);
        }
        try
        {
            new WindowsUpdateSchedule(LinkProtocol.Root).Save(new(AutoUpdate.IsChecked == true,
                PauseMetered.IsChecked == true, start, end));
            UpdateNotice.Text = "设置已保存";
            RefreshUpdateStatus();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            UpdateNotice.Text = "无法保存更新设置";
        }
    }

    private void RefreshUpdateStatus()
    {
        var schedule = new WindowsUpdateSchedule(LinkProtocol.Root);
        if (!schedule.Preferences().Enabled)
        {
            UpdateStatus.Text = "自动更新已关闭，仍可从托盘手动检查。";
            return;
        }
        var state = schedule.State();
        var outcome = state?.Outcome switch
        {
            "waiting-window" => "更新已下载，等待安装时段。",
            "waiting-network" => "等待不限流量的网络。",
            "busy" => "等待当前任务完成。",
            "checking" => "正在检查更新。若检查中断，将自动重试。",
            "committed" => "已更新。",
            "rejected" => "新版本未通过健康检查。",
            "download-deferred" or "recovered" => "更新暂未完成，将自动重试。",
            _ => "",
        };
        UpdateStatus.Text = state?.LastCheckUtc is { } last
            ? $"最近检查 {last.ToLocalTime():MM-dd HH:mm} {outcome}".TrimEnd()
            : outcome;
    }

    private static string? Text(JsonNode? node, string name) => node?[name]?.GetValue<string>();

    private static bool IsUnavailable(Exception error) =>
        error is TimeoutException or IOException or OperationCanceledException or JsonException;
}
