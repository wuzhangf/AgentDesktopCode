using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

internal sealed record GatewayUpdateReservation(string? Error, string? BootId = null, LinkUpdateIdentity? Identity = null)
{
    private sealed record Reply(string State, string? OperationId, string? BootId, long ExpiresAt);

    internal static async Task<GatewayUpdateReservation> AcquireAsync(
        Func<HttpMethod, string, object?, CancellationToken, Task<JsonNode?>> call,
        string operationId, CancellationToken cancellation)
    {
        var response = await call(HttpMethod.Post, "update-preparation", new { operationId }, cancellation);
        var reservation = response?.Deserialize<Reply>(JsonSerializerOptions.Web);
        if (reservation?.State == "busy")
            return new(response?["reason"]?.GetValue<string>() ?? "UPDATE_IN_PROGRESS");
        if (reservation?.BootId is not { Length: > 0 } bootId || !Matches(reservation, operationId, bootId))
            return new("GATEWAY_UNCONFIRMED");
        var capabilities = await call(HttpMethod.Get, "capabilities", null, cancellation);
        var devices = await call(HttpMethod.Get, "devices", null, cancellation) as JsonArray;
        var confirmed = await call(HttpMethod.Get, "update-preparation", null, cancellation);
        var host = capabilities?["personalHostId"]?.GetValue<string>();
        var store = capabilities?["storeId"]?.GetValue<string>();
        if (!Matches(confirmed?.Deserialize<Reply>(JsonSerializerOptions.Web), operationId, bootId) ||
            host is not { Length: > 0 } || store is not { Length: > 0 } || devices is null)
            return new("GATEWAY_UNCONFIRMED");
        return new(null, bootId, new LinkUpdateIdentity(host, store, devices.Count));
    }

    private static bool Matches(Reply? value, string operationId, string bootId) =>
        value?.State == "held" && value.OperationId == operationId && value.BootId == bootId &&
        value.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 12_000;
}
