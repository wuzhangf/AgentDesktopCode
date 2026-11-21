using System.Text.Json.Nodes;

namespace AgentLink;

internal static class LocalScheduleGrantRequests
{
    internal static async Task<LinkReply> HandleAsync(LinkRequest request,
        Func<HttpMethod, string, object?, CancellationToken, Task<JsonNode?>> owner,
        CancellationToken cancellation)
    {
        if (request.Id is not { Length: > 0 and < 129 } id || !char.IsAsciiLetterOrDigit(id[0]) ||
            id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.'))
            return new(false, "INVALID_REQUEST");

        var route = $"devices/{id}/local-schedule-grant";
        if (request.Operation == "setLocalScheduleGrant")
        {
            if (request.Args is not JsonObject body) return new(false, "INVALID_REQUEST");
            return new(true, Data: await owner(HttpMethod.Put, route, body, cancellation));
        }

        var devices = await owner(HttpMethod.Get, "devices", null, cancellation) as JsonArray;
        var device = devices?.OfType<JsonObject>().FirstOrDefault(row =>
            row["deviceGrantId"]?.GetValue<string>() == id);
        if (device is null || device["state"]?.GetValue<string>() != "ACTIVE")
            return new(false, "DEVICE_UNAVAILABLE");

        if (await owner(HttpMethod.Get, route, null, cancellation) is not JsonObject grant ||
            grant["revision"] is not JsonValue revision || !revision.TryGetValue<long>(out var number) ||
            number < 0 || grant["launchScopes"] is not JsonArray selected)
            return new(false, "INVALID_RESPONSE");

        var options = new JsonArray();
        if (device["actions"] is JsonArray actions && actions.Any(action => action?.GetValue<string>() == "LAUNCH") &&
            device["launchScopes"] is JsonArray scopes)
        {
            foreach (var target in scopes.OfType<JsonObject>().Where(target => target["engineId"]?.GetValue<string>() != "macos"))
                options.Add(target.DeepClone());
        }
        return new(true, Data: new JsonObject
        {
            ["revision"] = number,
            ["launchScopes"] = selected.DeepClone(),
            ["allowedLaunchScopes"] = options,
        });
    }
}
