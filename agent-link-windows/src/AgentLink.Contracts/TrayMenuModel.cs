using System.Text.Json.Nodes;

namespace AgentLink;

public enum TrayMenuEntryKind { Header, Problem, Submenu, Item, CheckItem, Separator }

public sealed record TrayMenuEntry(
    TrayMenuEntryKind Kind,
    string Text,
    string? Action = null,
    string? Id = null,
    bool Checked = false,
    bool Enabled = true,
    string? Icon = null,
    string? Detail = null,
    bool DetailAccent = false,
    string? Tint = null,
    string? Badge = null,
    IReadOnlyList<TrayMenuEntry>? Children = null);

public sealed record TrayWorkerCard(
    string Path, string Name, string? Engine = null, string? ProjectId = null,
    string? ProjectDir = null, string? ConnectionId = null);

public sealed record TraySnapshot(
    bool Reachable,
    LinkStatus? Status,
    JsonArray? Devices,
    JsonArray? Requests,
    IReadOnlyList<TrayWorkerCard> Workers,
    IReadOnlyList<string> CurrentWorkerPaths,
    IReadOnlyList<ManagedAgent>? Managed = null);

/// <summary>
/// Builds the tray menu from a point-in-time snapshot: a status header,
/// conditional problem rows, pending pairing requests, one drill-down section
/// per managed entity (phones, Agents, member account), then global actions.
/// Agent cards drill into per-agent actions the same way CC Switch entity
/// rows drill into provider pages. Rebuilt on every right-click — the model
/// is pure data so the contract smoke can assert it.
/// </summary>
public static class TrayMenuModel
{
    public static IReadOnlyList<TrayMenuEntry> Build(TraySnapshot snapshot)
    {
        if (!snapshot.Reachable || snapshot.Status is null)
            return
            [
                new(TrayMenuEntryKind.Header, "Agent Link · 后台连接中", Enabled: false),
                new(TrayMenuEntryKind.Problem, "后台暂不可用，点这里打开面板", Action: "open", Icon: "warn"),
                new(TrayMenuEntryKind.Separator, ""),
                new(TrayMenuEntryKind.Item, "刷新", Action: "refresh", Icon: "refresh"),
                new(TrayMenuEntryKind.Item, "打开 Agent Link", Action: "open", Icon: "open"),
                new(TrayMenuEntryKind.Item, "退出 Agent Link…", Action: "exit", Icon: "exit"),
            ];

        var status = snapshot.Status;
        var entries = new List<TrayMenuEntry>
        {
            new(TrayMenuEntryKind.Header, HeaderText(status), Enabled: false),
        };
        if (!status.Ready)
            entries.Add(new(TrayMenuEntryKind.Problem, "后台未就绪 · " + status.Message, Action: "open", Icon: "warn"));
        if (status.MemberState == "ERROR")
            entries.Add(new(TrayMenuEntryKind.Problem, "会员连接需要处理", Action: "open", Icon: "warn"));
        var requests = RequestChildren(snapshot);
        if (requests.Count > 0)
            entries.Add(new(TrayMenuEntryKind.Submenu, $"{status.PendingCount} 条配对请求",
                Icon: "pair", Detail: "待处理", DetailAccent: true, Children: requests));
        entries.Add(new(TrayMenuEntryKind.Separator, ""));
        entries.Add(new(TrayMenuEntryKind.Submenu, "手机连接", Icon: "phone",
            Detail: PhoneDetail(status), DetailAccent: status.Enabled && status.DeviceCount > 0,
            Children: PhoneChildren(snapshot)));
        entries.Add(new(TrayMenuEntryKind.Submenu, "Agent", Icon: "agent",
            Detail: AgentDetail(snapshot), DetailAccent: snapshot.CurrentWorkerPaths.Count > 0,
            Children: AgentChildren(snapshot)));
        entries.Add(new(TrayMenuEntryKind.Submenu, "会员账号", Icon: "member",
            Detail: MemberDetail(status), DetailAccent: status.MemberState == "LINKED",
            Children: MemberChildren(snapshot)));
        entries.Add(new(TrayMenuEntryKind.Separator, ""));
        entries.Add(new(TrayMenuEntryKind.Item, "打开 Agent Link", Action: "open", Icon: "open"));
        entries.Add(new(TrayMenuEntryKind.Item, "刷新", Action: "refresh", Icon: "refresh"));
        entries.Add(new(TrayMenuEntryKind.Item, "设置", Action: "openSettings", Icon: "settings"));
        entries.Add(new(TrayMenuEntryKind.Item, "退出 Agent Link…", Action: "exit", Icon: "exit"));
        return entries;
    }

    private static string HeaderText(LinkStatus status)
    {
        var lane = !status.Enabled ? "连接已关闭"
            : status.MemberState == "LINKED" ? "局域网 + 会员"
            : "局域网";
        return $"{status.Computer} · {lane} · {status.DeviceCount} 台手机";
    }

    private static string PhoneDetail(LinkStatus status) =>
        !status.Enabled ? "已关闭"
            : status.DeviceCount > 0 ? $"{status.DeviceCount} 台在线"
            : "已开启 · 无手机在线";

    private static string AgentDetail(TraySnapshot snapshot)
    {
        var parts = new List<string>();
        var enabled = snapshot.Managed?.Where(a => a.Enabled).ToArray() ?? [];
        if (enabled.Length > 0)
            parts.Add(string.Join("、", enabled.Select(ManagedTitle)) + " · 运行中");
        var attachedNames = snapshot.CurrentWorkerPaths
            .Select(path => snapshot.Workers.FirstOrDefault(c =>
                string.Equals(c.Path, path, StringComparison.OrdinalIgnoreCase))?.Name
                ?? Path.GetFileNameWithoutExtension(path))
            .ToArray();
        if (attachedNames.Length > 0) parts.Add(string.Join("、", attachedNames) + " · 接入中");
        if (parts.Count > 0) return string.Join(" + ", parts);
        var total = snapshot.Workers.Count + (snapshot.Managed?.Count ?? 0);
        return total > 0 ? $"{total} 个可接入" : "未接入";
    }

    private static string ManagedTitle(ManagedAgent agent)
    {
        var name = Path.GetFileName(agent.Project.TrimEnd(Path.DirectorySeparatorChar));
        return ManagedEngineName(agent.Engine) + " · " + (name is { Length: > 0 } ? name : "workspace");
    }

    private static string ManagedEngineName(string engine) => engine switch
    {
        "claude" => "Claude",
        "codex" => "Codex",
        "pi" => "Sage Pi",
        _ => engine,
    };

    private static string MemberDetail(LinkStatus status) => status.MemberState switch
    {
        "LINKED" => "已连接",
        "LINKING" => "等待确认",
        "CONNECTING" => "连接中",
        "ERROR" => "需要处理",
        _ => "未登录",
    };

    private static IReadOnlyList<TrayMenuEntry> RequestChildren(TraySnapshot snapshot)
    {
        var status = snapshot.Status!;
        var requests = snapshot.Requests?.OfType<JsonObject>()
            .Where(r => Text(r, "state") == "PENDING" && Text(r, "pairingRequestId") is { Length: > 0 })
            .ToArray() ?? [];
        if (status.PendingCount > 0 && requests.Length == 0)
            return [new(TrayMenuEntryKind.Item, "打开面板处理配对请求", Action: "open")];
        var items = new List<TrayMenuEntry>();
        foreach (var request in requests)
        {
            var id = Text(request, "pairingRequestId")!;
            var label = Text(request, "label") ?? "手机";
            items.Add(new(TrayMenuEntryKind.Item, label + " · " + Text(request, "checkWords"),
                Enabled: false, Icon: "phone"));
            items.Add(new(TrayMenuEntryKind.Item, "批准配对", Action: "approve", Id: id, Icon: "check"));
            items.Add(new(TrayMenuEntryKind.Item, "拒绝", Action: "reject", Id: id, Icon: "reject"));
        }
        return items;
    }

    private static IReadOnlyList<TrayMenuEntry> PhoneChildren(TraySnapshot snapshot)
    {
        var status = snapshot.Status!;
        var items = new List<TrayMenuEntry>();
        var devices = snapshot.Devices?.OfType<JsonObject>().ToArray() ?? [];
        if (devices.Length == 0)
        {
            items.Add(new(TrayMenuEntryKind.Item, "尚未配对手机", Enabled: false));
        }
        else
        {
            foreach (var device in devices)
            {
                var state = Text(device, "state");
                if (state == "REVOKED") continue;
                var active = state == "ACTIVE";
                var grant = Text(device, "deviceGrantId");
                var label = Text(device, "label") ?? grant?[..8] ?? "手机";
                items.Add(new(TrayMenuEntryKind.Submenu, label,
                    Icon: "phone", Detail: active ? "在线" : "不可用", DetailAccent: active,
                    Children: DeviceChildren(grant, label, active)));
            }
        }
        items.Add(new(TrayMenuEntryKind.Separator, ""));
        var inviteReady = status.Ready && status.Enabled;
        items.Add(new(TrayMenuEntryKind.Item, "生成配对邀请…", Action: "inviteQr", Enabled: inviteReady, Icon: "invite"));
        items.Add(new(TrayMenuEntryKind.Item, "复制连接码", Action: "inviteCopy", Enabled: inviteReady, Icon: "copy"));
        items.Add(new(TrayMenuEntryKind.Separator, ""));
        items.Add(new(TrayMenuEntryKind.CheckItem, "手机连接", Action: "togglePhone",
            Checked: status.Enabled, Enabled: status.Ready, Icon: "phone"));
        return items;
    }

    private static IReadOnlyList<TrayMenuEntry> DeviceChildren(string? grant, string label, bool active)
    {
        var items = new List<TrayMenuEntry>
        {
            new(TrayMenuEntryKind.Item, label + (active ? " · 在线" : " · 不可用"),
                Enabled: false, Icon: "phone"),
        };
        if (grant is { Length: > 0 })
            items.Add(new(TrayMenuEntryKind.Submenu, "取消配对…", Icon: "reject",
                Children:
                [
                    new(TrayMenuEntryKind.Item, "确认取消配对？需重新扫码连接", Enabled: false, Icon: "phone"),
                    new(TrayMenuEntryKind.Item, "确认取消配对", Action: "revokeDevice", Id: grant, Icon: "reject"),
                ]));
        items.Add(new(TrayMenuEntryKind.Separator, ""));
        items.Add(new(TrayMenuEntryKind.Item, "打开面板", Action: "open", Icon: "open"));
        return items;
    }

    private static IReadOnlyList<TrayMenuEntry> AgentChildren(TraySnapshot snapshot)
    {
        var items = new List<TrayMenuEntry>();
        foreach (var agent in snapshot.Managed ?? [])
        {
            items.Add(new(TrayMenuEntryKind.Submenu, ManagedTitle(agent), Icon: "agent",
                Detail: agent.Running ? "运行中" : agent.Enabled ? "启动中" : "已停用",
                DetailAccent: agent.Running, Tint: EngineTint(agent.Engine), Badge: agent.Engine,
                Children: ManagedAgentChildren(agent)));
        }
        if (items.Count > 0 && snapshot.Workers.Count > 0)
            items.Add(new(TrayMenuEntryKind.Separator, ""));
        var attached = new HashSet<string>(snapshot.CurrentWorkerPaths, StringComparer.OrdinalIgnoreCase);
        foreach (var path in attached.Where(p => snapshot.Workers.All(c =>
            !string.Equals(c.Path, p, StringComparison.OrdinalIgnoreCase))))
        {
            var orphan = new TrayWorkerCard(path, Path.GetFileNameWithoutExtension(path));
            items.Add(new(TrayMenuEntryKind.Submenu, orphan.Name, Icon: "agent",
                Detail: "接入中", DetailAccent: true, Tint: EngineTint(orphan.Engine),
                Badge: orphan.Engine,
                Children: AgentCardChildren(orphan, true)));
        }
        foreach (var card in snapshot.Workers)
        {
            var on = attached.Contains(card.Path);
            items.Add(new(TrayMenuEntryKind.Submenu, card.Name, Icon: "agent",
                Detail: on ? "接入中" : CardSubtitle(card),
                DetailAccent: on, Tint: EngineTint(card.Engine), Badge: card.Engine,
                Children: AgentCardChildren(card, on)));
        }
        if (items.Count == 0)
            items.Add(new(TrayMenuEntryKind.Item, "尚未接入 Agent", Enabled: false));
        items.Add(new(TrayMenuEntryKind.Separator, ""));
        items.Add(new(TrayMenuEntryKind.Item, "注册工作区…", Action: "agentAdd", Icon: "card"));
        items.Add(new(TrayMenuEntryKind.Item, "接入 Worker 注册卡…", Action: "workerPick", Icon: "card"));
        items.Add(new(TrayMenuEntryKind.Item, "管理 Agent…", Action: "openAgents", Icon: "open"));
        return items;
    }

    private static IReadOnlyList<TrayMenuEntry> ManagedAgentChildren(ManagedAgent agent)
    {
        var state = agent.Running ? " · 运行中" : agent.Enabled ? " · 启动中" : " · 已停用";
        var items = new List<TrayMenuEntry>
        {
            new(TrayMenuEntryKind.Item, ManagedTitle(agent) + state,
                Enabled: false, Icon: "agent", Tint: EngineTint(agent.Engine), Badge: agent.Engine),
            new(TrayMenuEntryKind.Item, agent.Project, Enabled: false, Icon: "open",
                Detail: agent.Detail, DetailAccent: agent.Detail is { Length: > 0 }),
        };
        items.Add(agent.Enabled
            ? new(TrayMenuEntryKind.Item, "停用此工作区", Action: "agentDisable", Id: agent.Key, Icon: "reject")
            : new(TrayMenuEntryKind.Item, "启用为当前工作区", Action: "agentEnable", Id: agent.Key, Icon: "check"));
        items.Add(new(TrayMenuEntryKind.CheckItem, "免审批执行（跳过工具确认）",
            Action: "agentSkip", Id: agent.Key, Checked: agent.SkipPermissions, Icon: "agent"));
        items.Add(new(TrayMenuEntryKind.Item, "测试引擎", Action: "agentTest", Id: agent.Key,
            Enabled: agent.Running, Icon: "refresh"));
        items.Add(new(TrayMenuEntryKind.Item, "浏览工作区", Action: "browseWorker", Id: agent.Project,
            Icon: "open"));
        items.Add(new(TrayMenuEntryKind.Separator, ""));
        items.Add(new(TrayMenuEntryKind.Item, "移除注册", Action: "agentRemove", Id: agent.Key, Icon: "reject"));
        items.Add(new(TrayMenuEntryKind.Item, "管理 Agent…", Action: "openAgents", Icon: "open"));
        return items;
    }

    private static IReadOnlyList<TrayMenuEntry> AgentCardChildren(TrayWorkerCard card, bool attached)
    {
        var items = new List<TrayMenuEntry>
        {
            new(TrayMenuEntryKind.Item, CardSubtitle(card) + (attached ? " · 接入中" : ""),
                Enabled: false, Icon: "agent", Tint: EngineTint(card.Engine), Badge: card.Engine),
        };
        if (attached)
            items.Add(new(TrayMenuEntryKind.Item, "断开接入", Action: "detachWorker", Id: card.Path, Icon: "reject"));
        else
            items.Add(new(TrayMenuEntryKind.Item, "接入此 Agent", Action: "attachWorker", Id: card.Path, Icon: "check"));
        items.Add(new(TrayMenuEntryKind.Item, "测试引擎", Action: "testWorker", Id: card.Path, Icon: "refresh"));
        items.Add(new(TrayMenuEntryKind.Item, "浏览工作区", Action: "browseWorker", Id: card.ProjectDir,
            Enabled: card.ProjectDir is { Length: > 0 }, Icon: "open"));
        items.Add(new(TrayMenuEntryKind.Separator, ""));
        items.Add(new(TrayMenuEntryKind.Item, "管理 Agent…", Action: "openAgents", Icon: "open"));
        return items;
    }

    private static string CardSubtitle(TrayWorkerCard card)
    {
        var engine = card.Engine ?? "Worker";
        return card.ProjectId is { Length: > 0 } project ? engine + " · " + project : engine;
    }

    public static string? EngineTint(string? engine) => engine switch
    {
        { } e when e.Contains("devin") => "#E8590C",
        { } e when e.Contains("claude") => "#D97757",
        { } e when e.Contains("codex") => "#10A37F",
        { } e when e.Contains("pi") => "#6366F1",
        { } e when e.Contains("gemini") => "#3C7FF5",
        { } e when e.Contains("grok") => "#1D1D1F",
        _ => null,
    };

    private static IReadOnlyList<TrayMenuEntry> MemberChildren(TraySnapshot snapshot)
    {
        var status = snapshot.Status!;
        var phase = status.MemberState ?? "NONE";
        var detail = status.MemberInfo;
        var text = phase switch
        {
            "LINKED" => "会员连接可用",
            "LINKING" => detail is { Length: > 0 } code ? $"请在浏览器中确认 {code}" : "等待浏览器确认",
            "CONNECTING" => "会员连接中",
            "ERROR" => detail ?? "会员连接需要处理",
            _ => detail ?? "未登录",
        };
        var (action, op) = phase switch
        {
            "LINKED" => ("退出登录", "memberLogout"),
            "LINKING" => ("取消", "memberCancel"),
            "ERROR" => ("重试", "memberLogin"),
            _ => ("登录会员", "memberLogin"),
        };
        return
        [
            new(TrayMenuEntryKind.Item, text, Enabled: false, Icon: "member"),
            new(TrayMenuEntryKind.Item, action, Action: "member", Id: op, Icon: "member",
                Enabled: status.Ready && phase != "CONNECTING"),
        ];
    }

    private static string? Text(JsonNode? node, string name) => node?[name]?.GetValue<string>();
}
