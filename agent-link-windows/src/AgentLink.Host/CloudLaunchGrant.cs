using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

internal static class CloudLaunchGrant
{
    private const string Schema = "windows-cloud-launch-grant/1";
    private static string GrantPath => Path.Combine(LinkProtocol.Root, "gateway", "windows-cloud-launch.json");

    internal static LinkReply Read(JsonNode? capabilities)
    {
        if (MemberCredentials.FileSession(requireCloudProfile: true) is not { } session)
            return new(false, MemberCredentials.HasSession() ? "请在手机连接中重新连接会员账号以启用云任务" : "请先连接会员账号");
        var binding = session.Scope.Split('\n');
        var current = ReadGrant(binding);
        var targets = Targets(capabilities);
        return new(true, Data: new JsonObject
        {
            ["revision"] = current?["revision"]?.DeepClone() ?? JsonValue.Create(0),
            ["controls"] = current?["controls"]?.DeepClone() ?? JsonValue.Create(false),
            ["approvals"] = current?["approvals"]?.DeepClone() ?? JsonValue.Create(false),
            ["allowed"] = new JsonArray((current?["launchScopes"] as JsonArray ?? []).OfType<JsonObject>()
                .Select(scope => (JsonNode?)JsonValue.Create(Key(scope, "backendStoreId"))).ToArray()),
            ["targets"] = new JsonArray(targets.Select(target => (JsonNode?)new JsonObject
            {
                ["id"] = Key(target, "backendId"),
                ["label"] = $"{target["projectId"]} · {target["engineId"]} · {target["backendId"]}"
            }).ToArray())
        });
    }

    internal static LinkReply Save(JsonNode? capabilities, JsonNode? args)
    {
        if (MemberCredentials.FileSession(requireCloudProfile: true) is not { } session)
            return new(false, "请先连接会员账号");
        if (args is not JsonObject request || request["targets"] is not JsonArray selection
            || selection.Count > 100 || request["expectedRevision"] is not JsonValue revision
            || !revision.TryGetValue<int>(out var expected) || request["controls"] is not JsonValue controlValue
            || !controlValue.TryGetValue<bool>(out var controls))
            return new(false, "授权参数无效");
        var binding = session.Scope.Split('\n');
        var current = ReadGrant(binding);
        var approve = false;
        if (request["approvals"] is JsonNode approvalSetting &&
            (approvalSetting is not JsonValue approvalsValue || !approvalsValue.TryGetValue<bool>(out approve)))
            return new(false, "审批授权参数无效");
        var actual = current?["revision"]?.GetValue<int>() ?? 0;
        if (actual != expected) return new(false, "云任务授权已变化，请刷新后重试");
        var targets = Targets(capabilities).ToDictionary(target => Key(target, "backendId"), StringComparer.Ordinal);
        var scopes = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in selection)
        {
            if (value is not JsonValue item || !item.TryGetValue<string>(out var id) || !seen.Add(id)
                || !targets.TryGetValue(id, out var target)) return new(false, "所选目标已变化，请刷新后重试");
            scopes.Add(new JsonObject
            {
                ["backendStoreId"] = target["backendId"]?.DeepClone(),
                ["projectId"] = target["projectId"]?.DeepClone(),
                ["engineId"] = target["engineId"]?.DeepClone(),
            });
        }
        var existing = current?["launchScopes"] as JsonArray ?? [];
        var sameScopes = existing.OfType<JsonObject>().Select(scope => Key(scope, "backendStoreId")).ToHashSet().SetEquals(seen);
        controls = controls && scopes.Count > 0;
        var previousApproval = current?["approvals"]?.GetValue<bool>() ?? false;
        var approvals = scopes.Count > 0 && (request["approvals"] is null ? sameScopes && previousApproval : approve);
        var unchanged = sameScopes
            && (current?["controls"]?.GetValue<bool>() ?? false) == controls && previousApproval == approvals;
        if (unchanged) return Read(capabilities);
        if (MemberCredentials.FileSession(requireCloudProfile: true)?.Scope != session.Scope) return new(false, "会员账号已切换");
        var grant = new JsonObject
        {
            ["schemaVersion"] = Schema, ["memberId"] = binding[0], ["workspaceId"] = binding[1],
            ["instanceId"] = binding[2], ["revision"] = checked(actual + 1), ["launchScopes"] = scopes,
            ["controls"] = controls,
            ["approvals"] = approvals,
        };
        LinkIdentity.SaveAtomic(GrantPath, JsonSerializer.SerializeToUtf8Bytes(grant, LinkProtocol.Json));
        return Read(capabilities);
    }

    private static JsonObject? ReadGrant(string[] binding)
    {
        if (!File.Exists(GrantPath)) return null;
        var grant = JsonNode.Parse(File.ReadAllBytes(GrantPath)) as JsonObject;
        return grant?["schemaVersion"]?.GetValue<string>() == Schema
            && grant["memberId"]?.GetValue<string>() == binding[0]
            && grant["workspaceId"]?.GetValue<string>() == binding[1]
            && grant["instanceId"]?.GetValue<string>() == binding[2] ? grant : null;
    }

    private static JsonObject[] Targets(JsonNode? capabilities) =>
        (capabilities?["linkTargets"]?["targets"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(target => target["sourceKind"]?.GetValue<string>() == "NATIVE")
            .DistinctBy(target => Key(target, "backendId")).ToArray();

    private static string Key(JsonObject target, string backend) =>
        $"{target[backend]}|{target["projectId"]}|{target["engineId"]}";
}
