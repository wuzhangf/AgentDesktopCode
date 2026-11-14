using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

internal static class DeviceScopeSync
{
    internal sealed record LaunchScope(string BackendStoreId, string ProjectId, string EngineId);

    internal static IEnumerable<(string DeviceId, object Body)> Changes(JsonNode? catalog, JsonArray? devices)
    {
        if (catalog is not JsonObject source || devices is null) yield break;
        var wanted = new HashSet<LaunchScope>();
        foreach (var backend in Rows(source["backends"]).Prepend(source))
        {
            if (backend["available"]?.GetValue<bool>() != true || Text(backend, "backendStoreId") is not { } id) continue;
            foreach (var project in AvailableIds(backend["projects"], "projectId"))
                foreach (var engine in AvailableIds(backend["engines"], "engineId"))
                    wanted.Add(new(id, project, engine));
        }
        if (wanted.Count is 0 or > 100) yield break;

        foreach (var device in devices.OfType<JsonObject>())
        {
            if (Text(device, "state") != "ACTIVE" || Text(device, "deviceGrantId") is not { } id ||
                Text(device, "grantRevision") is not { } revision || device["resources"] is not JsonArray resources ||
                device["actions"] is not JsonArray currentActions) continue;
            var existing = device["launchScopes"]?.Deserialize<LaunchScope[]>(LinkProtocol.Json) ?? [];
            var actions = currentActions.Select(value => value!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
            if (!actions.Add("LAUNCH") && wanted.SetEquals(existing)) continue;
            yield return (id, new
            {
                requestId = "scope-sync-" + Guid.NewGuid().ToString("N"),
                expectedGrantRevision = revision,
                resources,
                launchScopes = wanted,
                actions = actions.Order(StringComparer.Ordinal).ToArray(),
            });
        }
    }

    private static IEnumerable<JsonObject> Rows(JsonNode? rows) => (rows as JsonArray)?.OfType<JsonObject>() ?? [];

    private static IEnumerable<string> AvailableIds(JsonNode? rows, string key) =>
        Rows(rows).Where(row => Text(row, "availability") is null or "AVAILABLE")
            .Select(row => Text(row, key)).OfType<string>().Where(id => id.Length > 0);

    private static string? Text(JsonObject row, string key) =>
        row[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
