using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

/// Relay binding announced by the connector's `pac-relay/1` stdout line —
/// the service/assignment identities plus the host trust it proved.
public sealed record RelayRoute(string ServiceId, string AssignmentId, string MemberOrigin,
    string PersonalHostId, string StoreId, string CertificateSha256);

public static class RelayContract
{
    /// Parses the connector's route announcement. Anything else on stdout —
    /// including the `pac-relay-setup/1` provisioning line — is not a route.
    public static bool TryParseRouteLine(string line, out RelayRoute? route)
    {
        route = null;
        if (!line.StartsWith('{')) return false;
        try
        {
            if (JsonNode.Parse(line) is not JsonObject node
                || node["schemaVersion"]?.GetValue<string>() != "pac-relay/1"
                || node["relay"] is not JsonObject relay) return false;
            var parsed = new RelayRoute(Text(relay, "serviceId"), Text(relay, "assignmentId"),
                Text(relay, "memberOrigin"), Text(node, "personalHostId"),
                Text(node, "storeId"), Text(node, "certificateSha256"));
            if (parsed is { ServiceId.Length: > 0, AssignmentId.Length: > 0,
                MemberOrigin.Length: > 0, PersonalHostId.Length: > 0,
                StoreId.Length: > 0, CertificateSha256.Length: 64 })
            {
                route = parsed;
                return true;
            }
        }
        catch (JsonException) { }
        return false;
    }

    /// `Approve this computer at https://member-origin/path: USER-CODE` — the
    /// device-authorization prompt pac_launcher prints while `--link` polls.
    public static bool TryParseApprovalLine(string line, out string? uri, out string? userCode)
    {
        uri = userCode = null;
        const string prefix = "Approve this computer at ";
        if (!line.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var rest = line[prefix.Length..];
        var split = rest.LastIndexOf(": ", StringComparison.Ordinal);
        if (split <= 0) return false;
        var candidate = rest[..split];
        var code = rest[(split + 2)..];
        if (code.Length is 0 or > 64 || !Uri.TryCreate(candidate, UriKind.Absolute, out var parsed)
            || parsed.Scheme != "https") return false;
        uri = candidate;
        userCode = code;
        return true;
    }

    /// Agent Link Mac's invite guard, applied to the gateway payload: inject
    /// the relay block only while the connector's bound host/store/certificate
    /// identity matches this invitation. Relay routing never dials the
    /// alternate origins, so they are dropped to keep the QR dense-free.
    public static bool TryInjectRelay(JsonObject payload, RelayRoute route, JsonNode? capabilities)
    {
        if (capabilities is not JsonObject cap
            || !route.MemberOrigin.StartsWith("https://", StringComparison.Ordinal)) return false;
        var origin = Text(cap, "origin");
        if (Text(cap, "personalHostId") != route.PersonalHostId
            || Text(cap, "storeId") != route.StoreId
            || Text(cap, "certificateSha256") != route.CertificateSha256
            || Text(payload, "certificateSha256") != route.CertificateSha256) return false;
        if (origin is { Length: > 0 }) payload["origin"] = origin;
        payload["relay"] = new JsonObject
        {
            ["serviceId"] = route.ServiceId,
            ["assignmentId"] = route.AssignmentId,
            ["memberOrigin"] = route.MemberOrigin,
        };
        payload.Remove("origins");
        return true;
    }

    private static string Text(JsonNode? node, string key) =>
        node is JsonObject obj && obj[key] is JsonValue value
            && value.TryGetValue<string>(out var text) ? text : "";
}
