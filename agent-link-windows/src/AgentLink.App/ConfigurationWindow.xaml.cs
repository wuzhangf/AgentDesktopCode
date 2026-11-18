using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace AgentLink;

public partial class ConfigurationWindow : Window
{
    private sealed record ProviderChoice(string Label, string? Value);
    private sealed record WorkspaceRow(ManagedAgent Agent, string Heading, string Description);

    private readonly Func<LinkRequest, Task<LinkReply>> call;
    private readonly Action openPhone;
    private readonly DispatcherTimer refresh = new() { Interval = TimeSpan.FromSeconds(5) };
    private ManagedAgent? editing;
    private bool adding;
    private bool changingSelection;
    private bool busy;
    private bool refreshing;

    internal ConfigurationWindow(Func<LinkRequest, Task<LinkReply>> call, Action openPhone)
    {
        InitializeComponent();
        this.call = call;
        this.openPhone = openPhone;
        LinkTheme.Apply(Resources);
        Activated += (_, _) => LinkTheme.Apply(Resources);
        Closing += (_, e) => { e.Cancel = true; Hide(); };
        IsVisibleChanged += (_, _) => { if (IsVisible) refresh.Start(); else refresh.Stop(); };
        refresh.Tick += async (_, _) =>
        {
            if (busy || refreshing || adding || HasEdits()) return;
            refreshing = true;
            try { await ReloadAsync(quiet: true); }
            catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException or JsonException) { }
            finally { refreshing = false; }
        };
        Engine.ItemsSource = new[] { "claude", "codex", "opencode", "pi", "devin" };
        SetEditor(null);
    }

    internal async Task OpenAsync(string? key = null, bool register = false)
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        var change = register || key is not null && key != editing?.Key;
        if (busy || change && !MayDiscard()) return;
        await RunAsync(async () =>
        {
            await ReloadAsync(key, replaceEditor: change || !HasEdits());
            if (register) SetEditor(null, create: true);
        });
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(() => ReloadAsync(replaceEditor: !HasEdits()));

    private async Task ReloadAsync(string? key = null, bool replaceEditor = true, bool quiet = false)
    {
        var reply = await call(new("managedAgents"));
        if (!reply.Ok || reply.Data is not JsonArray rows)
        {
            if (!quiet) SetNotice(reply.Error ?? "暂时读不到工作区配置。", error: true);
            return;
        }
        var list = rows.Deserialize<List<ManagedAgent>>(LinkProtocol.Json) ?? [];
        var items = list.OrderBy(a => TrayMenuModel.ManagedEngineName(a.Engine), StringComparer.CurrentCultureIgnoreCase)
            .ThenByDescending(a => a.Enabled)
            .Select(a => new WorkspaceRow(a, TrayMenuModel.ManagedEngineName(a.Engine) + " · " + TrayMenuModel.WorkspaceName(a),
                a.Enabled ? a.Running ? "当前 · 运行中" : "当前 · " + (a.Detail is null ? "启动中" : "需处理") : "已停用"))
            .ToArray();
        var selectedKey = key ?? editing?.Key;
        var selected = items.FirstOrDefault(a => a.Agent.Key == selectedKey);
        if (quiet && (!IsVisible || busy || adding || HasEdits())) return;
        if (replaceEditor && !adding) selected ??= items.FirstOrDefault();
        if (quiet && Workspaces.ItemsSource is WorkspaceRow[] prior
            && prior.Select(row => (row.Heading, row.Description, row.Agent.Key))
                .SequenceEqual(items.Select(row => (row.Heading, row.Description, row.Agent.Key)))
            && SameEditor(editing, selected?.Agent)) return;
        changingSelection = true;
        Workspaces.ItemsSource = items;
        Workspaces.SelectedItem = selected;
        changingSelection = false;
        if (replaceEditor && !adding)
        {
            var notice = quiet ? Notice.Text : null;
            SetEditor(selected?.Agent);
            if (quiet && !string.IsNullOrEmpty(notice)) SetNotice(notice);
        }
    }

    private static bool SameEditor(ManagedAgent? first, ManagedAgent? second) =>
        first is null || second is null ? first is null && second is null
        : (first with { Models = null }) == (second with { Models = null })
          && (first.Models ?? []).SequenceEqual(second.Models ?? []);

    private void SetEditor(ManagedAgent? agent, bool create = false)
    {
        adding = create;
        editing = agent;
        Editor.Visibility = Actions.Visibility = create || agent is not null ? Visibility.Visible : Visibility.Collapsed;
        Heading.Text = create ? "注册工作区" : agent is null ? "选择工作区"
            : TrayMenuModel.ManagedEngineName(agent.Engine) + " · " + TrayMenuModel.WorkspaceName(agent);
        Status.Text = create ? "选择引擎和本机目录"
            : agent is null ? "从侧栏选择工作区，或注册一个新工作区。"
            : agent.Running ? "已运行 · " + TrayMenuModel.ProviderLabel(agent)
            : agent.Enabled ? agent.Detail ?? "正在启动" : "已停用";
        Status.ToolTip = agent?.Detail;
        EngineFields.Visibility = create ? Visibility.Visible : Visibility.Collapsed;
        RuntimeFields.Visibility = create || agent?.Executable is not null ? Visibility.Visible : Visibility.Collapsed;
        ProviderFields.Visibility = create ? Visibility.Collapsed : Visibility.Visible;
        Engine.Text = agent?.Engine ?? "claude";
        Project.Text = agent?.Project ?? "";
        Executable.Text = agent?.Executable ?? "";
        EnabledWorkspace.IsChecked = agent?.Enabled ?? false;
        var modes = new List<ProviderChoice> { new("自动（使用可用的 CC Switch 路由）", null), new("CLI 当前配置", "official") };
        if (agent is { CcAvailable: true } || agent?.Provider == "cc")
            modes.Add(new(agent.CcAvailable ? "CC Switch 本机路由" : "CC Switch 本机路由（暂不可用）", "cc"));
        Provider.ItemsSource = modes;
        Provider.SelectedItem = modes.FirstOrDefault(mode => mode.Value == agent?.Provider);
        Apply.Content = create ? "注册工作区" : "应用配置";
        Model.Text = agent?.Model ?? "";
        UpdateModelChoices();
        Test.IsEnabled = agent?.Running == true;
        Test.Visibility = Remove.Visibility = agent is null ? Visibility.Collapsed : Visibility.Visible;
        SetNotice(null);
    }

    private void Provider_Changed(object sender, SelectionChangedEventArgs e) => UpdateModelChoices();

    private void UpdateModelChoices()
    {
        var draft = Model.Text;
        Model.ItemsSource = SelectedProvider == "official" ? null : editing?.Models;
        Model.Text = draft;
    }

    private string? SelectedProvider => (Provider.SelectedItem as ProviderChoice)?.Value;

    private JsonObject Changes(ManagedAgent agent)
    {
        var args = new JsonObject();
        var project = Project.Text.Trim();
        var exe = Executable.Text.Trim();
        var model = NullWhenEmpty(Model.Text);
        if (project != agent.Project) args["project"] = project;
        if (agent.Executable is not null && exe != agent.Executable) args["executable"] = exe;
        if (agent.Executable is not null && model != agent.Model) args["model"] = model;
        if (agent.Executable is not null && SelectedProvider != agent.Provider) args["provider"] = SelectedProvider;
        if ((EnabledWorkspace.IsChecked == true) != agent.Enabled) args["enabled"] = EnabledWorkspace.IsChecked == true;
        return args;
    }

    private bool HasEdits() => adding ? !string.IsNullOrWhiteSpace(Project.Text)
        || !string.IsNullOrWhiteSpace(Executable.Text) || !string.IsNullOrWhiteSpace(Model.Text)
        || EnabledWorkspace.IsChecked == true || Engine.Text != "claude"
        : editing is { } agent && Changes(agent).Count > 0;

    private bool MayDiscard() => !HasEdits() || MessageBox.Show(this, "放弃当前表单中尚未应用的修改？",
        "Agent Link", MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK;

    private void Selection_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (changingSelection || Workspaces.SelectedItem is not WorkspaceRow row) return;
        if (!MayDiscard())
        {
            changingSelection = true;
            Workspaces.SelectedItem = (Workspaces.ItemsSource as IEnumerable<WorkspaceRow>)?
                .FirstOrDefault(item => item.Agent.Key == editing?.Key);
            changingSelection = false;
            return;
        }
        SetEditor(row.Agent);
    }

    private void Add_Click(object sender, RoutedEventArgs e)
    {
        if (busy || !MayDiscard()) return;
        changingSelection = true;
        Workspaces.SelectedItem = null;
        changingSelection = false;
        SetEditor(null, create: true);
        Project.Focus();
    }

    private void Project_Click(object sender, RoutedEventArgs e)
    {
        var chooser = new Microsoft.Win32.OpenFolderDialog { Title = "选择工作区目录" };
        if (Directory.Exists(Project.Text)) chooser.InitialDirectory = Project.Text;
        if (chooser.ShowDialog(this) == true) Project.Text = chooser.FolderName;
    }

    private void Executable_Click(object sender, RoutedEventArgs e)
    {
        var chooser = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择引擎可执行文件", Filter = "Windows 命令 (*.exe;*.cmd;*.bat)|*.exe;*.cmd;*.bat",
            CheckFileExists = true,
        };
        if (chooser.ShowDialog(this) == true) Executable.Text = chooser.FileName;
    }

    private async void Apply_Click(object sender, RoutedEventArgs e) => await RunAsync(async () =>
    {
        var project = Project.Text.Trim();
        var executable = NullWhenEmpty(Executable.Text);
        if (!Path.IsPathFullyQualified(project) || !Directory.Exists(project))
        {
            SetNotice("请选择一个存在的本机工作区目录。", error: true);
            return;
        }
        if (executable is not null && (!Path.IsPathFullyQualified(executable) || !File.Exists(executable))
            || !adding && editing?.Executable is not null && executable is null)
        {
            SetNotice("请选择有效的引擎可执行文件。", error: true);
            return;
        }
        var request = adding ? new LinkRequest("agentAdd", Args: new JsonObject
        {
            ["engine"] = Engine.Text.Trim(),
            ["project"] = project,
            ["executable"] = executable,
            ["model"] = NullWhenEmpty(Model.Text),
            ["enabled"] = EnabledWorkspace.IsChecked == true,
            ["skipPermissions"] = false,
        }) : editing is { } agent ? new("agentSet", agent.Key, Changes(agent)) : null;
        if (request is null || request.Args is JsonObject { Count: 0 })
        {
            SetNotice("没有需要应用的修改。");
            return;
        }
        var reply = await call(request);
        if (!reply.Ok) { SetNotice(reply.Error ?? "配置未应用。", error: true); return; }
        var key = editing?.Key;
        if (adding && reply.Data is JsonArray added)
            key = added.Deserialize<List<ManagedAgent>>(LinkProtocol.Json)?.LastOrDefault()?.Key;
        adding = false;
        await ReloadAsync(key);
        if (string.IsNullOrEmpty(Notice.Text))
            SetNotice("已保存配置。启用的工作区完成重新加载后可使用。");
    });

    private void Reset_Click(object sender, RoutedEventArgs e) => SetEditor(editing, adding);

    private async void Test_Click(object sender, RoutedEventArgs e) => await RunAsync(async () =>
    {
        if (editing is not { } agent) return;
        var reply = await call(new("agentTest", agent.Key));
        SetNotice(reply.Ok ? "本机引擎已连接。" : reply.Error ?? "引擎不可用。", error: !reply.Ok);
    });

    private async void Remove_Click(object sender, RoutedEventArgs e)
    {
        if (busy || editing is not { } agent || MessageBox.Show(this, "移除此工作区的注册？目录中的文件会保留。",
            "Agent Link", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
        await RunAsync(async () =>
        {
            var reply = await call(new("agentRemove", agent.Key));
            if (!reply.Ok) { SetNotice(reply.Error, error: true); return; }
            await ReloadAsync();
        });
    }

    private async void Attach_Click(object sender, RoutedEventArgs e)
    {
        if (busy) return;
        var chooser = new Microsoft.Win32.OpenFileDialog
        {
            Title = "接入 Worker 注册卡", Filter = "Worker 注册卡 (*.json)|*.json", CheckFileExists = true,
        };
        if (chooser.ShowDialog(this) != true) return;
        await RunAsync(async () =>
        {
            var reply = await call(new("worker", chooser.FileName));
            SetNotice(reply.Ok ? "Worker 已接入，可在托盘配置面板查看。" : reply.Error, error: !reply.Ok);
        });
    }

    private void Phone_Click(object sender, RoutedEventArgs e) => openPhone();

    private async void HandoffPeers_Click(object sender, RoutedEventArgs e)
    {
        await RunAsync(async () =>
        {
            var key = await call(new("handoffSigningKey"));
            var peers = await call(new("handoffPeers"));
            if (!key.Ok || key.Data is not JsonObject publicKey || publicKey["available"]?.GetValue<bool>() != true ||
                !peers.Ok || peers.Data is not JsonObject directory)
            {
                SetNotice(key.Error ?? peers.Error ?? "此电脑的交接密钥暂不可用。", error: true);
                return;
            }
            new HandoffPeersWindow(call, publicKey, directory) { Owner = this }.ShowDialog();
        });
    }

    private async void CloudLaunch_Click(object sender, RoutedEventArgs e)
    {
        await RunAsync(async () =>
        {
            var reply = await call(new("cloudLaunch"));
            if (!reply.Ok || reply.Data is not JsonObject directory)
            {
                SetNotice(reply.Error ?? "暂时读不到云任务授权。", error: true);
                return;
            }
            new CloudLaunchWindow(call, directory) { Owner = this }.ShowDialog();
            SetNotice(null);
        });
    }

    private async Task RunAsync(Func<Task> action)
    {
        if (busy) return;
        busy = true;
        Editor.IsEnabled = Actions.IsEnabled = Workspaces.IsEnabled = false;
        SetNotice("正在处理…");
        try { await action(); }
        catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException or JsonException)
        {
            SetNotice("后台暂不可用，请重试。", error: true);
        }
        finally
        {
            busy = false;
            Editor.IsEnabled = Actions.IsEnabled = Workspaces.IsEnabled = true;
            if (Notice.Text == "正在处理…") SetNotice(null);
        }
    }

    private void SetNotice(string? text, bool error = false)
    {
        Notice.Text = text ?? "";
        Notice.SetResourceReference(TextBlock.ForegroundProperty, error ? "LinkWarn" : "LinkSecondary");
    }

    private static string? NullWhenEmpty(string text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
