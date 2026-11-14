using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace AgentLink;

internal sealed record LinkIdentity(string InstallationId, string OwnerToken, string ClientToken, string StoreKey,
    string Pfx)
{
    internal static LinkIdentity Load()
    {
        Directory.CreateDirectory(LinkProtocol.Root);
        var file = Path.Combine(LinkProtocol.Root, "identity.dpapi");
        if (File.Exists(file))
        {
            var data = ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser);
            try
            {
                return JsonSerializer.Deserialize<LinkIdentity>(data, LinkProtocol.Json)
                    ?? throw new InvalidDataException("Invalid installation identity.");
            }
            finally { CryptographicOperations.ZeroMemory(data); }
        }
        var database = Path.Combine(LinkProtocol.Root, "gateway", "device-gateway.db");
        if (File.Exists(database)) throw new InvalidDataException("Existing database has no installation identity.");
        var id = Guid.NewGuid().ToString("N");
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=agent-link-" + id[..12],
            rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddDnsName(Environment.MachineName);
        san.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(825));
        var identity = new LinkIdentity(id, RandomToken(), RandomToken(), RandomToken(),
            Convert.ToBase64String(cert.Export(X509ContentType.Pkcs12)));
        var clear = JsonSerializer.SerializeToUtf8Bytes(identity, LinkProtocol.Json);
        try { SaveAtomic(file, ProtectedData.Protect(clear, null, DataProtectionScope.CurrentUser)); }
        finally { CryptographicOperations.ZeroMemory(clear); }
        return identity;
    }

    internal X509Certificate2 Certificate() => X509CertificateLoader.LoadPkcs12(
        Convert.FromBase64String(Pfx), null, X509KeyStorageFlags.EphemeralKeySet | X509KeyStorageFlags.Exportable);

    internal static string RandomToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    internal static void SaveAtomic(string path, byte[] body)
    {
        var staged = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(staged, body);
            File.Move(staged, path, overwrite: true);
        }
        finally { File.Delete(staged); }
    }
}
