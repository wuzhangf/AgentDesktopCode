using System.Text.Json.Nodes;
using AgentLink;

internal static class ContractChecks
{
    internal static void Run(string mode)
    {
        switch (mode)
        {
            case "contract-relay-lines": RelayLines(); break;
            case "contract-relay-invite": RelayInvite(); break;
            case "contract-launch-scopes": LaunchScopesCheck(); break;
            case "contract-menu-model": MenuModel(); break;
            case "contract-quick-configuration": QuickConfiguration(); break;
            default: throw new ArgumentException("Unknown contract case.");
        }
        Console.WriteLine($"PASS: {mode}.");
    }

    private static void QuickConfiguration()
    {
        var current = new ManagedAgent("a", "codex", @"C:\work\alpha", @"C:\bin\codex.exe", "model-a",
            false, true, true, null, null, "route-a", ["model-a", "model-b"], "cc", CcAvailable: true);
        var standby = current with { Key = "b", Project = @"C:\work\beta", Enabled = false, Running = false };
        var status = new LinkStatus(true, "ready", "PC", null, 0, 0, null, null, null, true);
        var snapshot = new TraySnapshot(true, status, null, null, [], [], [current, standby]);
        var engine = TrayMenuModel.BuildConfiguration(snapshot).Single();
        if (engine.Text != "Codex" || engine.Children?.Count != 2 || engine.Detail?.Contains("model-a") != true)
            throw new InvalidOperationException("Expected grouped workspaces and current model");
        var actions = engine.Children[0].Children!;
        var defaultModel = actions.Single(e => e.Text == "模型").Children!.First();
        if (defaultModel.Action != "agentModel" || defaultModel.Value is not null)
            throw new InvalidOperationException("Default model must clear the override");
        var offline = TrayMenuModel.BuildConfiguration(snapshot with { Reachable = false }).Single();
        if (offline.Children![0].Children!.First().Enabled)
            throw new InvalidOperationException("Cached rows must not enable offline mutations");
        var usage = TrayMenuModel.BuildUsage(new("ready", [new("codex", 12, 300, 20)])).Single();
        if (usage.Badge != "codex" || usage.Detail?.Contains("300") != true || usage.Action is not null)
            throw new InvalidOperationException("Expected read-only usage");
    }

    private static void RelayLines()
    {
        const string route = """
            {"schemaVersion":"pac-relay/1","relay":{"serviceId":"svc-1","assignmentId":"asg-1","memberOrigin":"https://api.steercrew.com"},"personalHostId":"host-1","storeId":"store-1","certificateSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
            """;
        if (!RelayContract.TryParseRouteLine(route, out var parsed) || parsed is null
            || parsed.ServiceId != "svc-1" || parsed.AssignmentId != "asg-1"
            || parsed.MemberOrigin != "https://api.steercrew.com"
            || parsed.CertificateSha256.Length != 64) throw new InvalidOperationException("route line rejected");

        const string setup = """
            {"schemaVersion":"pac-relay-setup/1","serviceId":"svc-1","assignmentId":"asg-1","memberOrigin":"https://api.steercrew.com"}
            """;
        if (RelayContract.TryParseRouteLine(setup, out _)) throw new InvalidOperationException("setup line accepted as route");
        if (RelayContract.TryParseRouteLine("Approve this computer at https://x: CODE", out _))
            throw new InvalidOperationException("approval line accepted as route");
        if (RelayContract.TryParseRouteLine("not json", out _)) throw new InvalidOperationException("noise accepted");

        const string approval = "Approve this computer at https://api.steercrew.com/member/device?userCode=ABCD-1234: ABCD-1234";
        if (!RelayContract.TryParseApprovalLine(approval, out var uri, out var code)
            || uri != "https://api.steercrew.com/member/device?userCode=ABCD-1234" || code != "ABCD-1234")
            throw new InvalidOperationException("approval line rejected");
        if (RelayContract.TryParseApprovalLine("Approve this computer at http://insecure: CODE", out _, out _))
            throw new InvalidOperationException("insecure approval uri accepted");
    }

    private static void RelayInvite()
    {
        var pin = new string('a', 64);
        var payload = JsonNode.Parse("""
            {"schemaVersion":"personal-pairing-invite/1","origin":"https://host.local:1",
             "origins":["https://host.local:1","https://192.168.1.2:1"],"personalHostId":"host-1",
             "storeId":"store-1","inviteId":"inv","inviteSecret":"sec","expiresAt":1,
             "certificateSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
             "certificatePem":"PEM"}
            """)!.AsObject();
        payload["certificateSha256"] = pin;
        var cap = JsonNode.Parse("""
            {"personalHostId":"host-1","storeId":"store-1","origin":"https://host.local:1",
             "certificateSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
            """);
        var route = new RelayRoute("svc-1", "asg-1", "https://api.steercrew.com",
            "host-1", "store-1", pin);

        if (!RelayContract.TryInjectRelay(payload, route, cap)) throw new InvalidOperationException("valid relay rejected");
        if (payload["relay"]?["serviceId"]?.GetValue<string>() != "svc-1"
            || payload["origins"] is not null) throw new InvalidOperationException("relay payload wrong");

        var mismatch = JsonNode.Parse("""
            {"schemaVersion":"personal-pairing-invite/1","origin":"https://host.local:1",
             "personalHostId":"host-1","storeId":"store-1","inviteId":"inv","inviteSecret":"sec",
             "expiresAt":1,"certificateSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
            """)!.AsObject();
        if (RelayContract.TryInjectRelay(mismatch, route, cap)) throw new InvalidOperationException("mismatched pin injected");

        var wrongStore = new RelayRoute("svc-1", "asg-1", "https://api.steercrew.com", "host-1", "other", pin);
        var clean = JsonNode.Parse("""
            {"schemaVersion":"personal-pairing-invite/1","origin":"https://host.local:1","personalHostId":"host-1",
             "storeId":"store-1","inviteId":"inv","inviteSecret":"sec","expiresAt":1,
             "certificateSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
            """)!.AsObject();
        if (RelayContract.TryInjectRelay(clean, wrongStore, cap)) throw new InvalidOperationException("store mismatch injected");

        var httpRoute = new RelayRoute("svc-1", "asg-1", "http://api.steercrew.com", "host-1", "store-1", pin);
        if (RelayContract.TryInjectRelay(clean, httpRoute, cap)) throw new InvalidOperationException("http member origin injected");
    }

    private static void LaunchScopesCheck()
    {
        var catalog = JsonNode.Parse("""
            {"available":true,"backendStoreId":"backend-1","projects":[
              {"projectId":"proj-a","availability":"AVAILABLE"},
              {"projectId":"proj-b","availability":"UNAVAILABLE"},
              {"projectId":"proj-a","availability":"AVAILABLE"}],
             "engines":[
              {"engineId":"codex","availability":"AVAILABLE"},
              {"engineId":"pi","availability":"UNAVAILABLE"},
              {"engineId":"gemini","availability":"AVAILABLE"}],
             "backends":[
              {"available":true,"backendStoreId":"backend-2","projects":[{"projectId":"proj-c"}],
               "engines":[{"engineId":"claude"}]},
              {"available":false,"backendStoreId":"backend-3","projects":[{"projectId":"proj-d"}],
               "engines":[{"engineId":"codex"}]}]}
            """);
        var scopes = LaunchScopes.FromCatalog(catalog);
        // proj-b unavailable, pi unavailable, backend-3 offline, duplicate
        // proj-a deduped → 3 expressible scopes. Engine ids are backend-
        // declared — gemini scopes now flow like any community engine.
        if (scopes.Count != 3) throw new InvalidOperationException($"expected 3 scopes, got {scopes.Count}");
        if (!scopes.Any(s => s.BackendStoreId == "backend-1" && s.ProjectId == "proj-a" && s.EngineId == "codex")
            || !scopes.Any(s => s.BackendStoreId == "backend-1" && s.ProjectId == "proj-a" && s.EngineId == "gemini")
            || !scopes.Any(s => s.BackendStoreId == "backend-2" && s.ProjectId == "proj-c" && s.EngineId == "claude")
            || scopes.Any(s => s.EngineId == "pi")
            || scopes.Any(s => s.BackendStoreId == "backend-3"))
            throw new InvalidOperationException("scope filtering wrong");

        if (LaunchScopes.FromCatalog(null).Count != 0) throw new InvalidOperationException("null catalog not empty");
        if (LaunchScopes.FromCatalog(JsonNode.Parse("{\"available\":false}")).Count != 0)
            throw new InvalidOperationException("offline catalog not empty");

        // 17 projects × 6 engine ids = 102 distinct scopes,
        // past the gateway's 100-scope bound.
        var many = new StringBuilderCatalog(17, 6);
        if (LaunchScopes.FromCatalog(many.Build()).Count != 0)
            throw new InvalidOperationException("over-limit catalog not emptied");
    }

    private static void MenuModel()
    {
        LinkStatus Status(bool ready = true, bool enabled = true, int devices = 0, int pending = 0,
            string? member = null, string? info = null) =>
            new(ready, ready ? "后台已就绪" : "正在启动", "PC-1", null, devices, pending,
                "host", "store", 100, enabled, member, info);

        TrayMenuEntry? Find(IReadOnlyList<TrayMenuEntry> entries, string action) =>
            entries.FirstOrDefault(e => e.Action == action)
            ?? entries.SelectMany(e => e.Children ?? []).FirstOrDefault(e => e.Action == action);

        // Unreachable: header + problem + refresh/global actions, no entity submenus.
        var offline = TrayMenuModel.Build(new(false, null, null, null, [], []));
        if (offline.Count != 6 || offline[0].Kind != TrayMenuEntryKind.Header || offline[0].Enabled
            || offline[1].Kind != TrayMenuEntryKind.Problem || offline[1].Action != "open"
            || offline.Any(e => e.Kind == TrayMenuEntryKind.Submenu)
            || Find(offline, "refresh") is null || Find(offline, "exit") is null)
            throw new InvalidOperationException("offline menu wrong");

        // Ready: header shows computer, lane and device count; problems surface;
        // pending pairing requests become an actionable drill-down submenu.
        var requests = JsonNode.Parse("""
            [{"pairingRequestId":"req-1","label":"iPhone-吴","checkWords":"BLUE-CAT","state":"PENDING"},
             {"pairingRequestId":"req-2","label":"旧请求","checkWords":"DONE","state":"APPROVED"}]
            """)!.AsArray();
        var ready = TrayMenuModel.Build(new(true, Status(devices: 2, pending: 1, member: "ERROR"), null, requests, [], []));
        if (!ready[0].Text.Contains("PC-1") || !ready[0].Text.Contains("2 台手机")
            || ready.Count(e => e.Kind == TrayMenuEntryKind.Problem) != 1)
            throw new InvalidOperationException("ready header/problems wrong");
        var pairing = ready.FirstOrDefault(e => e is { Kind: TrayMenuEntryKind.Submenu } && e.Text.Contains("配对请求"))
            ?? throw new InvalidOperationException("pairing submenu missing");
        var pairRows = pairing.Children!;
        if (pairRows.Count != 3 || pairRows[0].Enabled || !pairRows[0].Text.Contains("BLUE-CAT")
            || pairRows[1] is not { Action: "approve", Id: "req-1" }
            || pairRows[2] is not { Action: "reject", Id: "req-1" })
            throw new InvalidOperationException("pairing rows wrong");

        // Devices: ACTIVE marked online, inactive marked unavailable, label fallback.
        var devices = JsonNode.Parse("""
            [{"deviceGrantId":"g1","label":"iPhone-吴","state":"ACTIVE"},
             {"deviceGrantId":"g2-abcdefghij","state":"REVOKED"}]
            """)!.AsArray();
        var phone = TrayMenuModel.Build(new(true, Status(), devices, null, [], []))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "手机连接" }).Children!;
        if (phone[0] is not { Kind: TrayMenuEntryKind.Submenu, Text: "iPhone-吴", Detail: "在线", DetailAccent: true }
            || phone[1].Kind != TrayMenuEntryKind.Separator
            || phone[0].Children!.FirstOrDefault(e => e.Text == "取消配对…") is not
                { Kind: TrayMenuEntryKind.Submenu } revoke
            || !revoke.Children!.Any(e => e is { Action: "revokeDevice", Id: "g1", Text: "确认取消配对" })
            || Find(phone, "inviteQr")!.Enabled == false || Find(phone, "inviteCopy")!.Enabled == false
            || Find(phone, "togglePhone") is not { Checked: true })
            throw new InvalidOperationException("device rows wrong");

        // Phone off: invites disabled, toggle unchecked, lane says closed.
        var off = TrayMenuModel.Build(new(true, Status(enabled: false), devices, null, [], []));
        var phoneOff = off.First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "手机连接" }).Children!;
        if (!off[0].Text.Contains("连接已关闭") || Find(phoneOff, "inviteQr")!.Enabled
            || Find(phoneOff, "inviteCopy")!.Enabled || Find(phoneOff, "togglePhone") is not { Checked: false })
            throw new InvalidOperationException("disabled phone wrong");

        // Workers: each card drills into a per-agent page (CC-style entity rows):
        // attach/detach, engine test and workspace browse.
        var cards = new List<TrayWorkerCard>
        {
            new(@"D:\cards\pi.json", "Sage Pi", "sage-pi", "pi-workspace", @"D:\ws\pi"),
            new(@"D:\cards\codex.json", "Codex", "codex", "codex-proj"),
        };
        var agents = TrayMenuModel.Build(new(true, Status(), null, null, cards, [@"d:\CARDS\pi.json"]))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "Agent" }).Children!;
        if (agents[0] is not { Kind: TrayMenuEntryKind.Submenu, Text: "Sage Pi", Detail: "接入中",
                Tint: "#6366F1", Badge: "sage-pi" }
            || agents[1] is not { Kind: TrayMenuEntryKind.Submenu, Text: "Codex", Detail: "codex · codex-proj",
                Badge: "codex" })
            throw new InvalidOperationException("agent card rows wrong");
        var sagePage = agents[0].Children!;
        if (!sagePage.Any(e => e.Action == "detachWorker")
            || !sagePage.Any(e => e is { Action: "testWorker", Id: @"D:\cards\pi.json" })
            || !sagePage.Any(e => e is { Action: "browseWorker", Id: @"D:\ws\pi", Enabled: true }))
            throw new InvalidOperationException("attached agent page wrong");
        var codexPage = agents[1].Children!;
        if (!codexPage.Any(e => e is { Action: "attachWorker", Id: @"D:\cards\codex.json" })
            || codexPage.Any(e => e.Action == "detachWorker")
            || codexPage.FirstOrDefault(e => e.Action == "browseWorker") is not { Enabled: false })
            throw new InvalidOperationException("unattached agent page wrong");
        if (Find(agents, "workerPick") is null || Find(agents, "openAgents") is null
            || Find(agents, "agentAdd") is null)
            throw new InvalidOperationException("agent section tail wrong");

        // Managed workspaces appear before cards: enable/disable switch,
        // approval-free CheckItem, engine test, workspace browse, remove.
        var managed = new List<ManagedAgent>
        {
            new("claude-abc12345", "claude", @"D:\ws\proj", @"C:\Tools\claude.exe", null,
                SkipPermissions: true, Enabled: true, Running: true,
                ConnectionId: "managed-claude-abc12345", Detail: null,
                CcRoute: "opencode-go", Models: ["deepseek-v4.1-flash"], Provider: "cc"),
            new("codex-def67890", "codex", @"D:\ws\old", null, "gpt-5.6-sol",
                SkipPermissions: false, Enabled: false, Running: false, null, "已停用", null, null, null),
        };
        var managedSection = TrayMenuModel.Build(new(true, Status(), null, null, [], [], managed))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "Agent" });
        if (managedSection.Detail != "Claude · proj · 运行中")
            throw new InvalidOperationException("managed agent detail wrong: " + managedSection.Detail);
        var mrows = managedSection.Children!;
        if (mrows[0] is not { Kind: TrayMenuEntryKind.Submenu, Text: "Claude · proj", Detail: "运行中",
                Badge: "claude" }
            || mrows[1] is not { Kind: TrayMenuEntryKind.Submenu, Text: "Codex · old", Detail: "已停用" })
            throw new InvalidOperationException("managed agent rows wrong");
        var live = mrows[0].Children!;
        if (!live.Any(e => e is { Action: "agentDisable", Id: "claude-abc12345" })
            || live.FirstOrDefault(e => e.Action == "agentSkip") is not { Kind: TrayMenuEntryKind.CheckItem, Checked: true }
            || live.FirstOrDefault(e => e.Action == "agentTest") is not { Enabled: true }
            || live.FirstOrDefault(e => e.Action == "browseWorker") is not { Id: @"D:\ws\proj" }
            || !live.Any(e => e is { Action: "agentRemove", Id: "claude-abc12345" }))
            throw new InvalidOperationException("running managed page wrong");
        var stopped = mrows[1].Children!;
        if (!stopped.Any(e => e is { Action: "agentEnable", Id: "codex-def67890" })
            || stopped.FirstOrDefault(e => e.Action == "agentSkip") is not { Checked: false }
            || stopped.FirstOrDefault(e => e.Action == "agentTest") is not { Enabled: false })
            throw new InvalidOperationException("stopped managed page wrong");

        // Orphan current path still shows an attached row; empty shows the hint.
        var orphan = TrayMenuModel.Build(new(true, Status(), null, null, cards, [@"D:\gone\old.json"]))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "Agent" }).Children!;
        if (orphan[0] is not { Kind: TrayMenuEntryKind.Submenu, Text: "old", Detail: "接入中" }
            || !orphan[0].Children!.Any(e => e.Action == "detachWorker"))
            throw new InvalidOperationException("orphan worker row wrong");
        var none = TrayMenuModel.Build(new(true, Status(), null, null, [], []))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "Agent" }).Children!;
        if (none[0].Text != "尚未接入 Agent" || none[0].Enabled) throw new InvalidOperationException("empty workers wrong");

        // Member phases drive status text, action label and operation.
        var linked = TrayMenuModel.Build(new(true, Status(member: "LINKED"), null, null, [], []))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "会员账号" }).Children!;
        if (linked[0].Text != "会员连接可用" || linked[0].Enabled
            || linked[1].Text != "退出登录" || linked[1].Id != "memberLogout")
            throw new InvalidOperationException("member linked wrong");
        var linking = TrayMenuModel.Build(new(true, Status(member: "LINKING", info: "ABCD-1234"), null, null, [], []))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "会员账号" }).Children!;
        if (!linking[0].Text.Contains("ABCD-1234") || linking[1].Text != "取消" || linking[1].Id != "memberCancel")
            throw new InvalidOperationException("member linking wrong");
        var connecting = TrayMenuModel.Build(new(true, Status(member: "CONNECTING"), null, null, [], []))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "会员账号" }).Children!;
        if (connecting[1].Enabled) throw new InvalidOperationException("member connecting should be disabled");
        var noneMember = TrayMenuModel.Build(new(true, Status(member: null, info: "此安装不包含会员连接组件"), null, null, [], []))
            .First(e => e is { Kind: TrayMenuEntryKind.Submenu, Text: "会员账号" }).Children!;
        if (noneMember[0].Text != "此安装不包含会员连接组件" || noneMember[1].Text != "登录会员"
            || noneMember[1].Id != "memberLogin") throw new InvalidOperationException("member none wrong");
    }

    private static readonly string[] EngineIds = ["codex", "claude", "pi", "macos", "sage-pi", "sage-codex"];

    private sealed class StringBuilderCatalog(int projects, int engines)
    {
        internal JsonNode Build()
        {
            var root = new JsonObject { ["available"] = true, ["backendStoreId"] = "backend-1" };
            var ps = new JsonArray();
            for (var p = 0; p < projects; p++) ps.Add(new JsonObject { ["projectId"] = $"proj-{p}" });
            var es = new JsonArray();
            for (var e = 0; e < engines; e++) es.Add(new JsonObject { ["engineId"] = EngineIds[e % EngineIds.Length] });
            root["projects"] = ps;
            root["engines"] = es;
            return root;
        }
    }
}
