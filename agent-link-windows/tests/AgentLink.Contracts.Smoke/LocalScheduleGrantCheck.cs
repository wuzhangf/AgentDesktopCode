using System.Text.Json.Nodes;
using AgentLink;

internal static class LocalScheduleGrantCheck
{
    internal static async Task RunAsync()
    {
        const string route = "devices/phone-a/local-schedule-grant";
        var devices = JsonNode.Parse("""
            [
              {"deviceGrantId":"phone-b","state":"ACTIVE","actions":["LAUNCH"],"launchScopes":[
                {"backendStoreId":"worker-other","projectId":"private","engineId":"codex"}]},
              {"deviceGrantId":"phone-a","state":"ACTIVE","actions":["LAUNCH"],"launchScopes":[
                {"backendStoreId":"worker-a","projectId":"work","engineId":"codex"},
                {"backendStoreId":"worker-a","projectId":"mac","engineId":"macos"}]},
              {"deviceGrantId":"revoked","state":"REVOKED","actions":["LAUNCH"],"launchScopes":[]}
            ]
            """);
        var grant = JsonNode.Parse("""{"revision":7,"launchScopes":[]}""");
        var calls = new List<(HttpMethod Method, string Route, object? Body)>();
        Task<JsonNode?> Owner(HttpMethod method, string path, object? body, CancellationToken _)
        {
            calls.Add((method, path, body));
            return Task.FromResult(path switch
            {
                "devices" when method == HttpMethod.Get => devices,
                route => grant,
                _ => throw new InvalidOperationException("Wrong owner endpoint."),
            });
        }

        var result = await LocalScheduleGrantRequests.HandleAsync(new("localScheduleGrant", "phone-a"),
            Owner, CancellationToken.None);
        if (!result.Ok || result.Data?["revision"]?.GetValue<long>() != 7 ||
            result.Data["allowedLaunchScopes"] is not JsonArray { Count: 1 } options ||
            options[0]?["backendStoreId"]?.GetValue<string>() != "worker-a" ||
            calls.Count != 2 || calls[1] != (HttpMethod.Get, route, null))
            throw new InvalidOperationException("Expected only this phone's native launch scope and current revision.");

        calls.Clear();
        var denied = await LocalScheduleGrantRequests.HandleAsync(new("localScheduleGrant", "revoked"),
            Owner, CancellationToken.None);
        if (denied.Ok || denied.Error != "DEVICE_UNAVAILABLE" || calls.Count != 1)
            throw new InvalidOperationException("A revoked pairing must not open a grant editor.");

        calls.Clear();
        var clear = new JsonObject { ["expectedRevision"] = 7, ["launchScopes"] = new JsonArray() };
        var invalid = await LocalScheduleGrantRequests.HandleAsync(new("setLocalScheduleGrant", "../phone-b", clear),
            Owner, CancellationToken.None);
        if (invalid.Ok || calls.Count != 0)
            throw new InvalidOperationException("Invalid pairing ID reached the owner service.");

        var saved = await LocalScheduleGrantRequests.HandleAsync(new("setLocalScheduleGrant", "phone-a", clear),
            Owner, CancellationToken.None);
        if (!saved.Ok || calls.Count != 1 || calls[0] != (HttpMethod.Put, route, clear))
            throw new InvalidOperationException("Withdrawal must send the original revision and only the selected pairing.");
    }
}
