using System.Text.Json.Nodes;

namespace AgentLink;

internal static class ScheduleTransferRequests
{
    internal const string Route = "schedule-ownership";

    internal static async Task<LinkReply> HandleAsync(LinkRequest request,
        Func<HttpMethod, string, object?, CancellationToken, Task<JsonNode?>> owner,
        CancellationToken cancellation)
    {
        if (request.Operation == "scheduleTransferDirectory")
            return new(true, Data: await owner(HttpMethod.Get, Route, null, cancellation));
        if (request.Operation != "transferSchedule" ||
            request.Id is not { Length: > 0 and < 129 } id || !char.IsAsciiLetterOrDigit(id[0]) ||
            id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.') ||
            request.Args is not JsonObject body)
            return new(false, "INVALID_REQUEST");
        return new(true, Data: await owner(HttpMethod.Post, Route + "/" + id, body, cancellation));
    }
}
