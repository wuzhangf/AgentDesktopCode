using System.Security.Cryptography;
using System.Text;

namespace AgentLink;

/// PAC relay credential store for the connector child process.
///
/// The connector (daily_relay.pac_launcher) keeps its `PAC_RELAY_*` settings
/// in a properties file pointed to by `PAC_RELAY_ENV_FILE`. While the
/// connector runs the file stays materialized so the process can rotate
/// tokens; when the host stops the connector the latest contents are sealed
/// with DPAPI and the plaintext file is removed, so member secrets are only
/// readable by this Windows user while a connector session exists.
internal static class MemberCredentials
{
    private static string DirectoryPath => Path.Combine(LinkProtocol.Root, "protected");
    internal static string EnvFilePath => Path.Combine(DirectoryPath, "pac-relay.env");
    private static string ProtectedPath => EnvFilePath + ".dpapi";

    private static readonly string[] RequiredKeys =
    [
        "PAC_RELAY_INSTALLATION_ID", "PAC_RELAY_DEVICE_PRIVATE_KEY_B64",
        "PAC_RELAY_AGENT_REFRESH_TOKEN", "PAC_RELAY_AGENT_INSTANCE_ID",
        "PAC_RELAY_MEMBER_ID", "PAC_RELAY_WORKSPACE_ID",
    ];

    internal static void EnsureMaterialized()
    {
        if (File.Exists(EnvFilePath) || !File.Exists(ProtectedPath)) return;
        var sealedBytes = ProtectedData.Unprotect(File.ReadAllBytes(ProtectedPath), null,
            DataProtectionScope.CurrentUser);
        try
        {
            Directory.CreateDirectory(DirectoryPath);
            LinkIdentity.SaveAtomic(EnvFilePath, sealedBytes);
        }
        finally { CryptographicOperations.ZeroMemory(sealedBytes); }
    }

    /// Seal the working env file for at-rest storage. Called when the
    /// connector stops so rotated refresh tokens are not lost.
    internal static void Collect()
    {
        if (!File.Exists(EnvFilePath)) return;
        var plain = File.ReadAllBytes(EnvFilePath);
        try
        {
            Directory.CreateDirectory(DirectoryPath);
            LinkIdentity.SaveAtomic(ProtectedPath,
                ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser));
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
        File.Delete(EnvFilePath);
    }

    internal static void Clear()
    {
        File.Delete(EnvFilePath);
        File.Delete(ProtectedPath);
    }

    /// Presence check only — secret values never leave the stores and the
    /// protected copy is read in memory, so polling status does not keep a
    /// plaintext env file alive while no connector runs.
    internal static bool HasSession()
    {
        string? text;
        if (File.Exists(EnvFilePath))
        {
            text = File.ReadAllText(EnvFilePath, Encoding.UTF8);
        }
        else if (File.Exists(ProtectedPath))
        {
            byte[] sealedBytes;
            try
            {
                sealedBytes = ProtectedData.Unprotect(File.ReadAllBytes(ProtectedPath), null,
                    DataProtectionScope.CurrentUser);
            }
            catch (CryptographicException) { return false; }
            try { text = Encoding.UTF8.GetString(sealedBytes); }
            finally { CryptographicOperations.ZeroMemory(sealedBytes); }
        }
        else return false;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in text.Split('\n'))
        {
            var split = line.IndexOf('=');
            if (split > 0) values[line[..split].Trim()] = line[(split + 1)..].Trim();
        }
        return RequiredKeys.All(key => values.TryGetValue(key, out var value) && value.Length > 0);
    }
}
