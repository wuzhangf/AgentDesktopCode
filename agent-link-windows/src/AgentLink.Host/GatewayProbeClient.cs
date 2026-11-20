using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace AgentLink;

internal static class GatewayProbeClient
{
    private sealed record Health(string State, bool Ready, string OperationId, string BootId,
        string PersonalHostId, string StoreId, int? DeviceCount);

    private sealed record Refusal([property: JsonPropertyName("code")] string Code);

    internal static async Task<bool> CheckAsync(HttpClient http, int port, string ownerToken, string clientToken,
        string operationId, LinkUpdateHandoff? expected, Func<bool> isRunning, CancellationToken cancellation)
    {
        var origin = $"http://127.0.0.1:{port}/api/v2/personal-access/";
        HttpRequestMessage Request(string resource)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, origin + resource);
            request.Headers.Authorization = new("Bearer", ownerToken);
            request.Headers.Add("X-Client-Session", clientToken);
            return request;
        }
        while (isRunning())
        {
            try
            {
                using var request = Request("update-preparation");
                using var response = await http.SendAsync(request, cancellation);
                if (!response.IsSuccessStatusCode) return false;
                var health = await response.Content.ReadFromJsonAsync<Health>(cancellation);
                if (health?.State != "starting" || health.OperationId != operationId) return false;
                if (health.Ready)
                {
                    if (string.IsNullOrEmpty(health.BootId) || string.IsNullOrEmpty(health.PersonalHostId) ||
                        string.IsNullOrEmpty(health.StoreId) || health.DeviceCount is not >= 0 ||
                        expected is not null && (health.BootId == expected.GatewayBootId ||
                        health.PersonalHostId != expected.Identity.PersonalHostId ||
                        health.StoreId != expected.Identity.StoreId || health.DeviceCount != expected.Identity.DeviceCount))
                        return false;
                    using var fenced = Request("capabilities");
                    using var denied = await http.SendAsync(fenced, cancellation);
                    return denied.StatusCode == HttpStatusCode.ServiceUnavailable &&
                        (await denied.Content.ReadFromJsonAsync<Refusal>(cancellation))?.Code == "UPDATE_IN_PROGRESS";
                }
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) { }
            await Task.Delay(100, cancellation);
        }
        return false;
    }
}
