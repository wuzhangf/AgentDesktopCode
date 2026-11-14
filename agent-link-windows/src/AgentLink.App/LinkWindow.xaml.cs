using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
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
    private bool working;
    private bool choosingWorker;
    private long inviteExpires;
    private long dismissedAt = long.MinValue / 2;

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

    internal void CancelDismissal() => dismiss.Stop();

    private void ApplyTheme()
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        var dark = key?.GetValue("AppsUseLightTheme") is 0;
        SetBrush("LinkSurface", dark ? "#202327" : "#FCFCFD", SystemColors.WindowColor);
        SetBrush("LinkText", dark ? "#F0F2F5" : "#17202E", SystemColors.WindowTextColor);
        SetBrush("LinkSecondary", dark ? "#B4BFCC" : "#536071", SystemColors.WindowTextColor);
        SetBrush("LinkLine", dark ? "#434951" : "#DFE4EB", SystemColors.WindowTextColor);
        SetBrush("LinkSubtle", dark ? "#2B3036" : "#EDF1F6", SystemColors.ControlColor);
        SetBrush("LinkHover", dark ? "#383F47" : "#E4EBF4", SystemColors.ControlColor);
        SetBrush("LinkAccent", dark ? "#83B8FF" : "#0863CD", SystemColors.HighlightColor);
        SetBrush("LinkOnAccent", dark ? "#102841" : "#FFFFFF", SystemColors.HighlightTextColor);
        SetBrush("LinkReady", dark ? "#75D7AA" : "#13764E", SystemColors.WindowTextColor);
    }

    private void SetBrush(string key, string color, Color contrastColor)
    {
        var value = SystemParameters.HighContrast ? contrastColor : (Color)ColorConverter.ConvertFromString(color);
        if (Resources[key] is SolidColorBrush previous && previous.Color == value) return;
        var brush = new SolidColorBrush(value);
        brush.Freeze();
        Resources[key] = brush;
    }

    internal async Task RefreshAsync()
    {
        if (working) return;
        working = true;
        try
        {
            var reply = await LinkProtocol.CallAsync(new("status"));
            var state = reply.Data?.Deserialize<LinkStatus>(LinkProtocol.Json);
            if (!reply.Ok || state is null) return;
            Summary.Text = state.Ready ? (state.Enabled ? "手机连接已开启" : "手机连接已关闭") : state.Message;
            Computer.Text = state.Computer;
            StatusDot.SetResourceReference(ShapeFill, state.Ready && state.Enabled ? "LinkReady" : "LinkSecondary");
            Address.Text = state.Ready ? "局域网连接" : "";
            Address.ToolTip = state.Origin;
            Devices.Text = state.DeviceCount == 0 ? "尚未配对手机" : $"已配对 {state.DeviceCount} 部手机";
            PhoneEnabled.IsEnabled = state.Ready;
            PhoneEnabled.IsChecked = state.Enabled;
            Invite.IsEnabled = state.Ready && state.Enabled;
            if (inviteExpires <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && Qr.Source is not null)
                ClearInvite();
            if (!state.Enabled) ClearInvite();
            if (Tabs.SelectedIndex == 1 && state.Ready) await ReadAgentsAsync();
            if (Tabs.SelectedIndex == 0 && state.Ready && state.PendingCount > 0)
                ShowRequests((await LinkProtocol.CallAsync(new("requests"))).Data as JsonArray);
            else PairingRequests.Children.Clear();
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

    private async Task ReadAgentsAsync()
    {
        var reply = await LinkProtocol.CallAsync(new("agents"));
        var source = reply.Data;
        var backends = (source?["backends"] as JsonArray)?.OfType<JsonObject>().ToArray();
        if (backends is null || backends.Length == 0)
            backends = source is JsonObject primary ? [primary] : [];
        var rows = new List<string>();
        foreach (var backend in backends)
        {
            if (backend["available"]?.GetValue<bool>() != true) continue;
            var engines = backend["engines"] as JsonArray;
            var projects = (backend["projects"] as JsonArray)?.Select(p => Text(p, "displayName") ?? Text(p, "projectId"));
            foreach (var engine in engines?.OfType<JsonObject>() ?? [])
            {
                var name = Text(engine, "engineId") switch
                {
                    "sage-pi" or "pi" => "Sage Pi",
                    "sage-codex" or "codex" => "Codex",
                    "claude" => "Claude",
                    { } id => id,
                    _ => "Agent",
                };
                var current = Text(engine, "availability") == "AVAILABLE" ? "可用" : "需要处理";
                rows.Add(name + "  ·  " + current + "\n" + string.Join("、", projects ?? []));
            }
        }
        Agents.Text = rows.Count == 0 ? "尚未接入 Agent。手机可以先配对。" : string.Join("\n\n", rows.Distinct());
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
            InviteHelp.Text = "用 iPhone 上的 Control 扫码。请连接同一个局域网。";
        }
        catch (Exception error) when (IsUnavailable(error))
        {
            InviteHelp.Text = "后台暂不可用，请稍后重试。";
        }
        finally { working = false; Invite.IsEnabled = true; }
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
