namespace AgentLink;

internal sealed class MemberLogoutFiles(string envFile, string grantFile)
{
    private readonly string marker = envFile + ".logout";

    internal bool Pending
    {
        get
        {
            try { File.GetAttributes(marker); return true; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch (IOException) { return true; }
            catch (UnauthorizedAccessException) { return true; }
        }
    }

    internal void Begin()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(marker)!);
        using var file = new FileStream(marker, FileMode.OpenOrCreate, FileAccess.Write,
            FileShare.Read, 1, FileOptions.WriteThrough);
        file.WriteByte(1);
        file.Flush(flushToDisk: true);
    }

    internal void Complete()
    {
        // The caller has confirmed that the connector's entire job has stopped.
        // Keep the marker if any deletion fails or the Host exits halfway through.
        File.Delete(envFile);
        File.Delete(envFile + ".dpapi");
        try { File.Delete(grantFile); }
        catch (DirectoryNotFoundException) { }
        File.Delete(marker);
    }
}
