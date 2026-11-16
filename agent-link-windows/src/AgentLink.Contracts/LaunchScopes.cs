using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AgentLink;

public sealed record LaunchScope(string BackendStoreId, string ProjectId, string EngineId);

/// Availability-filtered (project × engine) pairs from the capabilities
/// localSource catalog — the same set Agent Link Mac sends when minting an
/// invitation and the set the owner scope-sync grants after pairing.
public static class LaunchScopes
{
    // Engines are backend-declared: scope refs carry any well-formed engineId
    // and the backend's own catalog/preflight decides whether it exists —
    // community/third-party engines flow without a core allow-list.
    private static readonly Regex IdShape = new(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// Returns the expressible scope set, or empty when nothing can be
    /// granted (no catalog rows, or more than the gateway's 100-scope bound —
    /// the owner scope-sync applies the same bound).
    public static IReadOnlyList<LaunchScope> FromCatalog(JsonNode? localSource)
    {
        if (localSource is not JsonObject source) return [];
        var wanted = new List<LaunchScope>();
        var seen = new HashSet<LaunchScope>();
        foreach (var backend in Rows(source["backends"]).Prepend(source))
        {
            var backendId = Text(backend, "backendStoreId");
            if (backendId is null || !IdShape.IsMatch(backendId) || !Flag(backend, "available")) continue;
            foreach (var project in Rows(backend["projects"]))
            {
                var projectId = Text(project, "projectId");
                if (projectId is null || !IdShape.IsMatch(projectId) || !Available(project)) continue;
                foreach (var engine in Rows(backend["engines"]))
                {
                    var engineId = Text(engine, "engineId");
                    if (engineId is null || !IdShape.IsMatch(engineId) || !Available(engine)) continue;
                    var scope = new LaunchScope(backendId, projectId, engineId);
                    if (seen.Add(scope)) wanted.Add(scope);
                }
            }
        }
        return wanted.Count is >= 1 and <= 100 ? wanted : [];
    }

    private static bool Available(JsonObject row) => Text(row, "availability") is null or "AVAILABLE";

    private static bool Flag(JsonObject row, string key) =>
        row[key] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    private static IEnumerable<JsonObject> Rows(JsonNode? rows) =>
        (rows as JsonArray)?.OfType<JsonObject>() ?? [];

    private static string? Text(JsonObject row, string key) =>
        row[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
