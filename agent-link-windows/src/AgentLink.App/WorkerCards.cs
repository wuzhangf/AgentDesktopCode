using System.IO;
using System.Text.Json;

namespace AgentLink;

/// <summary>
/// Worker card discovery shared by the tray menu and the panel. Workers
/// self-register by dropping a card into the gateway drop dir — default
/// ~/.agent-gateway/workers.d, overridable per worker through
/// GATEWAY_WORKER_DROP_DIR — and remove it on exit, so the directories are
/// the live registry of running workers.
/// </summary>
internal static class WorkerCards
{
    internal static List<string> Dirs()
    {
        var dirs = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".agent-gateway", "workers.d"),
        };
        var drop = Environment.GetEnvironmentVariable("GATEWAY_WORKER_DROP_DIR");
        if (!string.IsNullOrWhiteSpace(drop)) dirs.Add(drop!);
        return dirs.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    internal static TrayWorkerCard? TryRead(string file)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var name =
                Field(doc.RootElement, "displayName") ??
                Field(doc.RootElement, "connectionId") ??
                Path.GetFileNameWithoutExtension(file);
            return new(Path.GetFullPath(file), name,
                Field(doc.RootElement, "engine"),
                Field(doc.RootElement, "projectId"),
                Field(doc.RootElement, "project"),
                Field(doc.RootElement, "connectionId"));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    internal static List<TrayWorkerCard> Enumerate()
    {
        var cards = new List<TrayWorkerCard>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var dir in Dirs())
        {
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.EnumerateFiles(dir, "*.json").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
            {
                if (TryRead(file) is not { } card) continue;
                if (card.ConnectionId is { } id && !seen.Add(id)) continue;
                cards.Add(card);
            }
        }
        return cards;
    }

    /// Attached card paths — worker-cards.json is the current set file; the
    /// legacy single-slot worker-card.path is honoured once as a migration
    /// seed (the host rewrites the json and deletes the pointer on next op).
    internal static List<string> CurrentPaths()
    {
        try
        {
            var json = Path.Combine(LinkProtocol.Root, "worker-cards.json");
            if (File.Exists(json))
                return (JsonSerializer.Deserialize<string[]>(File.ReadAllText(json)) ?? [])
                    .Where(p => !string.IsNullOrWhiteSpace(p)).ToList();
            var file = Path.Combine(LinkProtocol.Root, "worker-card.path");
            var text = File.Exists(file) ? File.ReadAllText(file).Trim() : null;
            return string.IsNullOrWhiteSpace(text) ? [] : [text];
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return []; }
    }

    private static string? Field(JsonElement card, string name) =>
        card.TryGetProperty(name, out var value) && value.GetString() is { Length: > 0 } text ? text : null;
}
