namespace AgentLink;

public sealed record EngineUsage(string Engine, long Requests, long InputTokens, long OutputTokens);
public sealed record UsageSnapshot(string State, IReadOnlyList<EngineUsage> Engines);
