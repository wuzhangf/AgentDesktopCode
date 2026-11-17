using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace AgentLink;

/// <summary>
/// Reads provider routing from a local cc-switch install (~/.cc-switch) and
/// maps it onto spawned CLI env. cc-switch has two delivery modes per app:
///   direct — the CLI's own config files rule (settings.json env / auth.json);
///            we inject nothing and the files already ride along on USERPROFILE.
///   proxy  — traffic goes through cc-switch's local gateway
///            http://{listen}/{app}/... authenticated by the gateway token.
/// Resolution reads live-state.json plus cc-switch.db read-only.
/// </summary>
internal static class CcSwitch
{
    public sealed record Route(bool Proxied, string? RouteName, string? BaseUrl,
        string? Token, List<string>? Models);

    private static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cc-switch");

    internal static bool SupportsRouting(string engine) => engine is "claude" or "codex";

    internal static UsageSnapshot ReadUsage(DateTimeOffset now, int days, string? database = null)
    {
        var path = database ?? Path.Combine(Dir, "cc-switch.db");
        if (!File.Exists(path)) return new("missing", []);
        try
        {
            using var con = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false, DefaultTimeout = 1,
            }.ToString());
            con.Open();
            using var cmd = con.CreateCommand();
            cmd.CommandText = """
                SELECT app_type, COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
                FROM proxy_request_logs
                WHERE created_at >= $since AND created_at <= $until
                GROUP BY app_type
                ORDER BY COUNT(*) DESC, app_type
                """;
            cmd.Parameters.AddWithValue("$since", now.AddDays(days == 7 ? -7 : -1).ToUnixTimeSeconds());
            cmd.Parameters.AddWithValue("$until", now.ToUnixTimeSeconds());
            using var reader = cmd.ExecuteReader();
            var engines = new List<EngineUsage>();
            while (reader.Read())
                engines.Add(new(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2), reader.GetInt64(3)));
            return new("ready", engines);
        }
        catch (Exception error) when (error is SqliteException or InvalidCastException or IOException or UnauthorizedAccessException)
        {
            return new("unavailable", []);
        }
    }

    /// <summary>Returns the proxy env for an app that is attached in
    /// live-state, or null when the app is unmanaged/direct (or cc-switch is
    /// absent). Never throws — a broken cc install must not break spawning.</summary>
    public static Route? Resolve(string engine)
    {
        try
        {
            var liveFile = Path.Combine(Dir, "live-state.json");
            if (!File.Exists(liveFile)) return null;
            var app = JsonNode.Parse(File.ReadAllText(liveFile))?
                ["apps"]?[AppKey(engine)];
            if (app is null) return null;
            if (!string.Equals(app["mode"]?.GetValue<string>(), "proxy", StringComparison.OrdinalIgnoreCase)
                || app["attached"]?.GetValue<bool>() != true)
                return null; // direct — CLI config files carry whatever is current

            var (addr, port) = ProxyListen(engine);
            var token = GatewayToken();
            var name = app["proxy_route"]?.GetValue<string>();
            var models = name is null ? null : RouteModels(name);
            if (addr is null || token is null) return new Route(true, name, null, null, models);
            // Attached clients call the gateway root; the auth contract selects
            // the app bucket — forwarding keeps the path verbatim, so an app
            // prefix would 404 upstream.
            return new Route(true, name, $"http://{addr}:{port}", token, models);
        }
        catch { return null; }
    }

    /// <summary>Engine → cc app_type. Our names intentionally match
    /// cc-switch's app_type for claude/codex/pi.</summary>
    private static string AppKey(string engine) => engine switch
    {
        "claude" or "codex" or "pi" => engine,
        _ => engine,
    };

    /// <summary>Inject route env onto a managed child's launch. Token is only
    /// set when the proxy is up; missing token leaves the CLI unauthenticated
    /// rather than silently bypassing the user's metering.</summary>
    public static void Apply(Route route, string engine, System.Diagnostics.ProcessStartInfo launch)
    {
        if (!route.Proxied || route.BaseUrl is null || route.Token is null) return;
        if (engine == "claude")
        {
            launch.Environment["ANTHROPIC_BASE_URL"] = route.BaseUrl;
            launch.Environment["ANTHROPIC_AUTH_TOKEN"] = route.Token;
            launch.Environment["ANTHROPIC_API_KEY"] = route.Token;
        }
        else if (engine == "codex")
        {
            launch.Environment["OPENAI_BASE_URL"] = route.BaseUrl + "/v1";
            launch.Environment["OPENAI_API_KEY"] = route.Token;
        }
    }

    private static (string? addr, int port) ProxyListen(string engine)
    {
        using var con = OpenDb();
        if (con is null) return (null, 15721);
        using var cmd = con.CreateCommand();
        cmd.CommandText =
            "select listen_address, listen_port from proxy_config where app_type=$app and enabled=1";
        cmd.Parameters.AddWithValue("$app", AppKey(engine));
        using var r = cmd.ExecuteReader();
        return r.Read() ? (r.GetString(0), r.GetInt32(1)) : (null, 15721);
    }

    private static string? GatewayToken()
    {
        using var con = OpenDb();
        if (con is null) return null;
        using var cmd = con.CreateCommand();
        // Single shared token today; prefer an app-scoped key if a future
        // cc-switch version splits them.
        cmd.CommandText =
            "select value from settings where key like '%gateway_token%' limit 1";
        return cmd.ExecuteScalar() as string;
    }

    /// <summary>Model ids a route actually serves upstream — `models[]` in the
    /// provider config (pi-style) or the mapped targets of
    /// `meta.claudeDesktopModelRoutes` (claude-style alias slots). These are
    /// the real upstream ids: the gateway only rewrites claude-desktop alias
    /// models for the desktop attach, so managed CLIs must send them raw.</summary>
    private static List<string>? RouteModels(string routeName)
    {
        using var con = OpenDb();
        if (con is null) return null;
        using var cmd = con.CreateCommand();
        cmd.CommandText = "select settings_config, meta from providers where id=$id limit 1";
        cmd.Parameters.AddWithValue("$id", routeName);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        try
        {
            if (JsonNode.Parse(r.GetString(0))?["models"] is JsonArray arr)
            {
                var ids = arr
                    .Select(m => m?["id"]?.GetValue<string>())
                    .Where(id => !string.IsNullOrWhiteSpace(id)).Cast<string>().Distinct().ToList();
                if (ids.Count > 0) return ids;
            }
            if (JsonNode.Parse(r.IsDBNull(1) ? "{}" : r.GetString(1))?
                    ["claudeDesktopModelRoutes"] is JsonObject routes)
            {
                var ids = routes
                    .Select(kv => kv.Value?["model"]?.GetValue<string>())
                    .Where(id => !string.IsNullOrWhiteSpace(id)).Cast<string>().Distinct().ToList();
                if (ids.Count > 0) return ids;
            }
        }
        catch (JsonException) { }
        return null;
    }

    private static SqliteConnection? OpenDb()
    {
        var file = Path.Combine(Dir, "cc-switch.db");
        if (!File.Exists(file)) return null;
        try
        {
            var con = new SqliteConnection(
                $"Data Source={file};Mode=ReadOnly;Cache=Shared");
            con.Open();
            return con;
        }
        catch { return null; }
    }
}
