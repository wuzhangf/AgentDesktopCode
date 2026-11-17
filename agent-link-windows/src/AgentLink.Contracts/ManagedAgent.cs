namespace AgentLink;

/// <summary>
/// A managed cli-bridge registration owned by AgentLink.Host: engine + working
/// directory + launch options. `agents.json` keeps every registered workspace —
/// disabling keeps the entry (history) while its bridge stops; at most one
/// workspace per engine is enabled at a time (the "default" workspace).
/// </summary>
public sealed record ManagedAgent(
    string Key,
    string Engine,
    string Project,
    string? Executable,
    string? Model,
    bool SkipPermissions,
    bool Enabled,
    bool Running,
    string? ConnectionId,
    string? Detail,
    /// <summary>cc-switch route this workspace is attached to (proxy mode), or null.</summary>
    string? CcRoute,
    /// <summary>Upstream model ids the attached cc route serves — the options a
    /// phone/desktop picker should offer for `model`.</summary>
    List<string>? Models,
    /// <summary>"cc" forces the cc-switch route, "official" forces the engine's
    /// own login/config; null = auto (cc when attached).</summary>
    string? Provider,
    bool CcAvailable = false);
