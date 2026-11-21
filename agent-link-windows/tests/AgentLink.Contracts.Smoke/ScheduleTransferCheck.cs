using System.Text.Json.Nodes;
using AgentLink;

internal static class ScheduleTransferCheck
{
    internal static async Task RunAsync()
    {
        var body = new JsonObject { ["requestKey"] = "original", ["destination"] = "cloud",
            ["expectedRevision"] = 3, ["expectedScope"] = "same-membership" };
        var requests = new List<(HttpMethod Method, string Path, object? Body)>();
        Task<JsonNode?> Owner(HttpMethod method, string path, object? payload, CancellationToken cancellation)
        {
            requests.Add((method, path, payload));
            return Task.FromResult<JsonNode?>(new JsonObject { ["schemaVersion"] = "link-schedule-ownership/1" });
        }
        var authenticated = await ScheduleTransferRequests.HandleAsync(new("scheduleTransferDirectory"), Owner, default);
        var invalid = await ScheduleTransferRequests.HandleAsync(new("transferSchedule", "../other", body), Owner, default);
        var transferred = await ScheduleTransferRequests.HandleAsync(new("transferSchedule", "rule-1", body), Owner, default);
        if (!authenticated.Ok || invalid.Ok || !transferred.Ok || requests.Count != 2 ||
            requests[0] != (HttpMethod.Get, "schedule-ownership", null) ||
            requests[1] != (HttpMethod.Post, "schedule-ownership/rule-1", body))
            throw new InvalidOperationException("The Host must forward the original revision, key and scope only to the schedule owner API.");
    }
}
