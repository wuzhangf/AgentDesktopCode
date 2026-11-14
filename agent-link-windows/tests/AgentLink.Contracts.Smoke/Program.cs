using System.Runtime.CompilerServices;
using AgentLink;

var mode = args.Single();
var daily = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Steercrew", "AgentLink");
var isolated = Path.Combine(Path.GetTempPath(), "Agent Link smoke", Guid.NewGuid().ToString("N"));
Environment.SetEnvironmentVariable("AGENT_LINK_WINDOWS_STATE", mode switch
{
    "absent" => null,
    "empty" => "",
    "whitespace" => " \t ",
    "explicit" => isolated,
    _ => throw new ArgumentException("Unknown smoke case."),
});
CheckRoot(mode == "explicit" ? isolated : daily);
Console.WriteLine($"PASS: {mode} state override resolves without a startup exception.");

// Root is static. Each case runs in its own process and initializes it after setting the environment.
[MethodImpl(MethodImplOptions.NoInlining)]
static void CheckRoot(string expected)
{
    if (!string.Equals(LinkProtocol.Root, Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Unexpected state root.");
    if (!LinkProtocol.Pipe.StartsWith("Steercrew.AgentLink.", StringComparison.Ordinal))
        throw new InvalidOperationException("Instance initialization failed.");
}
