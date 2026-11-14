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
            default: throw new ArgumentException("Unknown contract case.");
        }
        Console.WriteLine($"PASS: {mode}.");
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
        // proj-b unavailable, pi unavailable, gemini outside the gateway engine
        // set, backend-3 offline, duplicate proj-a deduped → 2 expressible scopes.
        if (scopes.Count != 2) throw new InvalidOperationException($"expected 2 scopes, got {scopes.Count}");
        if (!scopes.Any(s => s.BackendStoreId == "backend-1" && s.ProjectId == "proj-a" && s.EngineId == "codex")
            || !scopes.Any(s => s.BackendStoreId == "backend-2" && s.ProjectId == "proj-c" && s.EngineId == "claude")
            || scopes.Any(s => s.EngineId is "pi" or "gemini")
            || scopes.Any(s => s.BackendStoreId == "backend-3"))
            throw new InvalidOperationException("scope filtering wrong");

        if (LaunchScopes.FromCatalog(null).Count != 0) throw new InvalidOperationException("null catalog not empty");
        if (LaunchScopes.FromCatalog(JsonNode.Parse("{\"available\":false}")).Count != 0)
            throw new InvalidOperationException("offline catalog not empty");

        // 17 projects × the 6 allow-listed engines = 102 distinct scopes,
        // past the gateway's 100-scope bound.
        var many = new StringBuilderCatalog(17, 6);
        if (LaunchScopes.FromCatalog(many.Build()).Count != 0)
            throw new InvalidOperationException("over-limit catalog not emptied");
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
