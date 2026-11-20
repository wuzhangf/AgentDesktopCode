using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace AgentLink;

internal sealed class PublisherTrust(string expectedKey)
{
    private static readonly Guid Action = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    internal void Verify(InstalledPayload payload)
    {
        Verify(Path.Combine(payload.Directory, "AgentLink.exe"));
        Verify(Path.Combine(payload.Directory, "host", "AgentLink.Host.exe"));
    }

    internal void Verify(string path)
    {
        var action = Action;
        var file = new FileInfo
        {
            Size = (uint)Marshal.SizeOf<FileInfo>(),
            Path = Marshal.StringToCoTaskMemUni(path),
        };
        var buffer = Marshal.AllocCoTaskMem(Marshal.SizeOf<FileInfo>());
        var trust = new TrustData
        {
            Size = (uint)Marshal.SizeOf<TrustData>(),
            UiChoice = 2, // WTD_UI_NONE
            UnionChoice = 1, // WTD_CHOICE_FILE
            Info = buffer,
            StateAction = 1, // WTD_STATEACTION_VERIFY
            Flags = 0x1000, // WTD_CACHE_ONLY_URL_RETRIEVAL
        };
        try
        {
            Marshal.StructureToPtr(file, buffer, false);
            if (WinVerifyTrust(new IntPtr(-1), ref action, ref trust) != 0)
                throw new CryptographicException("Windows rejected the Agent Link signature.");
            var provider = WTHelperProvDataFromStateData(trust.StateData);
            var signer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            var certificate = signer == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer, 0);
            if (certificate == IntPtr.Zero) throw new CryptographicException("Missing verified Agent Link signer.");
            var context = Marshal.PtrToStructure<ProviderCertificate>(certificate).Certificate;
            if (context == IntPtr.Zero) throw new CryptographicException("Missing verified Agent Link certificate.");
            using var signing = new X509Certificate2(context);
            var key = Convert.ToHexString(SHA256.HashData(signing.GetPublicKey()));
            if (!key.Equals(expectedKey, StringComparison.OrdinalIgnoreCase))
                throw new CryptographicException("Windows package publisher differs from the configured publisher.");
        }
        finally
        {
            if (trust.StateData != IntPtr.Zero)
            {
                trust.StateAction = 2; // WTD_STATEACTION_CLOSE
                WinVerifyTrust(new IntPtr(-1), ref action, ref trust);
            }
            Marshal.FreeCoTaskMem(buffer);
            Marshal.FreeCoTaskMem(file.Path);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo
    {
        public uint Size;
        public IntPtr Path, File, KnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData
    {
        public uint Size;
        public IntPtr PolicyData, SipData;
        public uint UiChoice, Revocation, UnionChoice;
        public IntPtr Info;
        public uint StateAction;
        public IntPtr StateData, Url;
        public uint Flags, UiContext;
        public IntPtr SignatureSettings;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProviderCertificate
    {
        public uint Size;
        public IntPtr Certificate;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint index,
        [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterIndex);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint index);
}
