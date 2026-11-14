using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

internal static class DeviceScopeSync
{
    internal static IEnumerable<(string DeviceId, object Body)> Changes(JsonNode? catalog, JsonArray? devices)
    {
        if (devices is null) yield break;
        var wanted = LaunchScopes.FromCatalog(catalog).ToHashSet();
        if (wanted.Count == 0) yield break;

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

    private static string? Text(JsonObject row, string key) =>
        row[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
