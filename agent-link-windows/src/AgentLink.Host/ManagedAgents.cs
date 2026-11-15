using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentLink;

/// <summary>
/// Managed cli-bridge registry + supervisor. `agents.json` persists every
/// registered workspace (history); at most one workspace per engine is enabled —
/// enabling another switches the default. Each enabled entry spawns
/// `gateway-node.exe components/cli-bridge/cli-bridge.mjs serve …` on a loopback
/// port, waits for /local/v1/identity, then registers it through the gateway
/// owner API exactly like an external worker card. Spawn env carries PATH so
/// the wrapped CLI keeps its normal toolchain; --executable pins the CLI for
/// machines where PATH probing is unreliable.
/// </summary>
internal sealed class ManagedAgents : IDisposable
{
    internal static readonly string[] Engines = ["claude", "codex", "pi"];
    private static readonly TimeSpan RespawnCooldown = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(12);

    internal sealed record Entry(string Key, string Engine, string Project,
        string? Executable, string? Model, bool SkipPermissions, bool Enabled,
        // "cc" forces the cc-switch proxy route, "official" forces the
        // engine's own login/config; null = auto (cc when attached).
        string? Provider = null);
    private sealed record Registry(List<Entry> Agents);

    private sealed class Child
    {
        internal OwnedProcess? Process;
        internal int Port;
        internal string Token = "";
        internal bool Registered;
        internal DateTimeOffset NextSpawn;
        internal string? Detail;
        internal CcSwitch.Route? CcRoute;
    }

    private readonly string file;
    private readonly string stateRoot;
    private readonly string nodeExe;
    private readonly string bridge;
    private readonly Func<HttpMethod, string, object?, CancellationToken, Task<JsonNode?>> owner;
    private readonly HttpClient probe = new(new SocketsHttpHandler { UseProxy = false })
        { Timeout = TimeSpan.FromSeconds(2) };
    private readonly Dictionary<string, Child> children = new(StringComparer.Ordinal);
    private List<Entry> entries = [];
    private bool gatewayUp;

    internal ManagedAgents(string installRoot,
        Func<HttpMethod, string, object?, CancellationToken, Task<JsonNode?>> owner)
    {
        this.owner = owner;
        file = Path.Combine(LinkProtocol.Root, "agents.json");
        stateRoot = Path.Combine(LinkProtocol.Root, "agents");
        nodeExe = Path.Combine(installRoot, "runtime", "gateway-node.exe");
        bridge = Path.Combine(installRoot, "components", "cli-bridge", "cli-bridge.mjs");
        try
        {
            if (File.Exists(file))
            {
                var registry = JsonSerializer.Deserialize<Registry>(File.ReadAllBytes(file), LinkProtocol.Json);
                entries = registry?.Agents ?? [];
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            entries = [];
        }
    }

    internal IReadOnlyList<ManagedAgent> List() => entries
        .Select(e => ToView(e, children.GetValueOrDefault(e.Key))).ToArray();

    private ManagedAgent ToView(Entry e, Child? c)
    {
        var running = c?.Process is { Process.HasExited: false };
        var detail = e.Enabled ? c?.Detail : "已停用";
        if (c?.CcRoute is { Proxied: true, RouteName: { } routeName })
            detail = (detail ?? "就绪") + " · cc:" + routeName;
        return new(e.Key, e.Engine, e.Project, e.Executable, e.Model, e.SkipPermissions, e.Enabled,
            running, running ? "managed-" + e.Key : null, detail,
            c?.CcRoute?.RouteName, c?.CcRoute?.Models, e.Provider);
    }

    internal Entry Add(string engine, string? executable, string project,
        string? model, bool skipPermissions)
    {
        if (!Engines.Contains(engine)) throw new IOException("不支持的引擎：" + engine);
        project = Path.GetFullPath(project);
        if (project.StartsWith(@"\\") || project.Length > 1024 || !Directory.Exists(project))
            throw new IOException("工作区目录不存在：" + project);
        executable = string.IsNullOrWhiteSpace(executable) ? FindExecutable(engine) : Path.GetFullPath(executable);
        if (executable is null || !File.Exists(executable))
            throw new IOException($"未找到 {engine} 可执行文件，请手动指定路径");
        if (model is { Length: > 128 } || model?.Any(c => c is '\r' or '\n') == true)
            throw new IOException("模型名无效");
        var entry = new Entry(engine + "-" + Convert.ToHexStringLower(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)),
            engine, project, executable, string.IsNullOrWhiteSpace(model) ? null : model.Trim(),
            skipPermissions, Enabled: true);
        for (var i = 0; i < entries.Count; i++)
            if (entries[i].Engine == engine) entries[i] = entries[i] with { Enabled = false };
        entries.Add(entry);
        Save();
        return entry;
    }

    internal void SetEnabled(string key, bool enabled)
    {
        var index = IndexOf(key);
        for (var i = 0; i < entries.Count; i++)
            if (entries[i].Engine == entries[index].Engine)
                entries[i] = entries[i] with { Enabled = i == index && enabled };
        Save();
    }

    internal async Task UpdateAsync(string key, JsonNode args, CancellationToken cancellation)
    {
        var index = IndexOf(key);
        if (args["enabled"] is { } enabled) SetEnabled(key, enabled.GetValue<bool>());
        var entry = entries[index];
        var restart = false;
        if (args["skipPermissions"] is { } skip)
        {
            var on = skip.GetValue<bool>();
            if (on != entry.SkipPermissions) { entry = entry with { SkipPermissions = on }; restart = true; }
        }
        if (args["project"]?.GetValue<string>() is { Length: > 0 } project)
        {
            var full = Path.GetFullPath(project);
            if (!Directory.Exists(full)) throw new IOException("工作区目录不存在：" + project);
            if (full != entry.Project) { entry = entry with { Project = full }; restart = true; }
        }
        if (args["executable"]?.GetValue<string>() is { Length: > 0 } executable)
        {
            var full = Path.GetFullPath(executable);
            if (!File.Exists(full)) throw new IOException("可执行文件不存在：" + executable);
            if (full != entry.Executable) { entry = entry with { Executable = full }; restart = true; }
        }
        if (args["model"] is { } model)
        {
            var value = model.GetValue<string?>();
            if (value is { Length: > 128 } || value?.Any(c => c is '\r' or '\n') == true)
                throw new IOException("模型名无效");
            var trimmed = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            if (trimmed != entry.Model) { entry = entry with { Model = trimmed }; restart = true; }
        }
        if (args["provider"] is { } provider)
        {
            var value = provider.GetValue<string?>();
            if (value is not (null or "cc" or "official")) throw new IOException("provider 只能是 cc/official");
            if (value != entry.Provider) { entry = entry with { Provider = value }; restart = true; }
        }
        entries[index] = entry;
        Save();
        if (restart && children.TryGetValue(key, out var child))
            await StopChildAsync(key, child, unregister: true);
    }

    internal async Task RemoveAsync(string key, CancellationToken cancellation)
    {
        IndexOf(key);
        entries.RemoveAll(e => e.Key == key);
        Save();
        if (children.TryGetValue(key, out var child))
            await StopChildAsync(key, child, unregister: true);
    }

    private int IndexOf(string key)
    {
        var index = entries.FindIndex(e => e.Key == key);
        if (index < 0) throw new IOException("未找到该 Agent 注册：" + key);
        return index;
    }

    private void Save()
    {
        Directory.CreateDirectory(LinkProtocol.Root);
        LinkIdentity.SaveAtomic(file, JsonSerializer.SerializeToUtf8Bytes(
            new Registry(entries), LinkProtocol.Json));
    }

    /// <summary>Gateway (re)started: all owner-side registrations are gone —
    /// re-register on the next reconcile. Bridge processes keep running.</summary>
    internal void GatewayRestarted()
    {
        gatewayUp = true;
        foreach (var child in children.Values) child.Registered = false;
    }

    internal void GatewayStopped() => gatewayUp = false;

    internal async Task ReconcileAsync(CancellationToken cancellation)
    {
        if (!gatewayUp) return;
        var wanted = new HashSet<string>(entries.Where(e => e.Enabled).Select(e => e.Key), StringComparer.Ordinal);
        foreach (var (key, child) in children.ToArray())
            if (!wanted.Contains(key)) await StopChildAsync(key, child, unregister: true);
        foreach (var entry in entries.Where(e => e.Enabled))
        {
            var child = children.GetValueOrDefault(entry.Key) ?? (children[entry.Key] = new Child());
            if (child.Process is { Process.HasExited: false })
            {
                if (!child.Registered) await RegisterAsync(entry, child, cancellation);
                continue;
            }
            if (DateTimeOffset.UtcNow < child.NextSpawn) continue;
            if (child.Process is { } stale) { stale.Dispose(); child.Process = null; }
            try { await SpawnAsync(entry, child, cancellation); }
            catch (Exception error) when (error is IOException or Win32Exception or InvalidOperationException
                or HttpRequestException or TimeoutException or JsonException
                || error is OperationCanceledException && !cancellation.IsCancellationRequested)
            {
                child.Detail = "启动失败：" + error.Message;
                child.NextSpawn = DateTimeOffset.UtcNow + RespawnCooldown;
            }
        }
    }

    private async Task SpawnAsync(Entry entry, Child child, CancellationToken cancellation)
    {
        if (!File.Exists(nodeExe)) throw new IOException("安装缺少 gateway-node.exe");
        if (!File.Exists(bridge)) throw new IOException("安装缺少 cli-bridge 组件");
        var port = FreePort();
        child.Token = Convert.ToHexStringLower(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(24));
        var launch = LinkHost.ProcessInfo(nodeExe, entry.Project);
        launch.Environment["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "";
        launch.Environment["PATHEXT"] = Environment.GetEnvironmentVariable("PATHEXT") ?? "";
        launch.Environment["ComSpec"] = Environment.GetEnvironmentVariable("ComSpec") ?? "";
        launch.Environment["WORKER_LOCAL_TOKEN"] = child.Token;
        // Provider auth for spawned CLIs: file-based login (~/.claude,
        // ~/.codex) rides on the whitelisted profile vars above; API-key style
        // auth needs the actual env values through.
        foreach (var name in new[] { "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL" })
            if (Environment.GetEnvironmentVariable(name) is { } secret)
                launch.Environment[name] = secret;
        // "official" skips cc entirely; auto/cc resolve the attach state —
        // a proxied route wins over ambient env for metering/failover.
        child.CcRoute = entry.Provider == "official" ? null : CcSwitch.Resolve(entry.Engine);
        if (entry.Provider == "cc" && child.CcRoute is null)
            throw new IOException("cc-switch 未给 " + entry.Engine + " 挂接路由");
        if (child.CcRoute is { } ccRoute) CcSwitch.Apply(ccRoute, entry.Engine, launch);
        var projectId = Path.GetFileName(entry.Project.TrimEnd(Path.DirectorySeparatorChar));
        launch.ArgumentList.Add(bridge);
        launch.ArgumentList.Add("serve");
        launch.ArgumentList.Add("--engine"); launch.ArgumentList.Add(entry.Engine);
        launch.ArgumentList.Add("--state"); launch.ArgumentList.Add(Path.Combine(stateRoot, entry.Key));
        launch.ArgumentList.Add("--port"); launch.ArgumentList.Add(port.ToString());
        launch.ArgumentList.Add("--project"); launch.ArgumentList.Add(entry.Project);
        launch.ArgumentList.Add("--project-id"); launch.ArgumentList.Add(projectId ?? "workspace");
        launch.ArgumentList.Add("--project-name"); launch.ArgumentList.Add(projectId ?? "workspace");
        launch.ArgumentList.Add("--executable"); launch.ArgumentList.Add(entry.Executable!);
        launch.ArgumentList.Add("--skip-permissions"); launch.ArgumentList.Add(entry.SkipPermissions ? "on" : "off");
        var model = entry.Model
            ?? (child.CcRoute is { Proxied: true } ? child.CcRoute.Models?.FirstOrDefault() : null);
        if (model is { }) { launch.ArgumentList.Add("--model"); launch.ArgumentList.Add(model); }
        var owned = new OwnedProcess(launch, signalStart: false);
        _ = Task.Run(() => owned.Process.StandardOutput.BaseStream.CopyToAsync(Stream.Null));
        _ = Task.Run(() => owned.Process.StandardError.BaseStream.CopyToAsync(Stream.Null));
        child.Process = owned;
        child.Port = port;
        child.Registered = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(StartupTimeout);
        while (true)
        {
            if (owned.Process.HasExited) throw new IOException("进程已退出（" + owned.Process.ExitCode + "）");
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get,
                    $"http://127.0.0.1:{port}/local/v1/identity");
                request.Headers.Authorization = new("Bearer", child.Token);
                using var response = await probe.SendAsync(request, timeout.Token);
                if (response.IsSuccessStatusCode) break;
            }
            catch (HttpRequestException) { }
            await Task.Delay(300, timeout.Token);
        }
        await RegisterAsync(entry, child, cancellation);
    }

    private async Task RegisterAsync(Entry entry, Child child, CancellationToken cancellation)
    {
        try { await owner(HttpMethod.Delete, "worker-registrations/managed-" + entry.Key, null, cancellation); }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException) { }
        var projectId = Path.GetFileName(entry.Project.TrimEnd(Path.DirectorySeparatorChar)) ?? "workspace";
        await owner(HttpMethod.Post, "worker-registrations", new
        {
            connectionId = "managed-" + entry.Key,
            url = $"http://127.0.0.1:{child.Port}/",
            token = child.Token,
            displayName = DisplayName(entry.Engine) + " · " + projectId,
        }, cancellation);
        child.Registered = true;
        child.Detail = null;
    }

    private async Task StopChildAsync(string key, Child child, bool unregister)
    {
        children.Remove(key);
        if (unregister && child.Registered)
        {
            try { await owner(HttpMethod.Delete, "worker-registrations/managed-" + key, null, CancellationToken.None); }
            catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException) { }
        }
        if (child.Process is { } owned)
        {
            try { await owned.StopAsync(TimeSpan.FromSeconds(4)); }
            catch (Exception error) when (error is IOException or Win32Exception or InvalidOperationException) { }
            owned.Dispose();
        }
        child.Process = null;
        child.Registered = false;
    }

    /// <summary>Adopt a vendor-CLI session into this managed workspace: creates
    /// a quiescent task bound to the session id via the bridge's adoptSessionId —
    /// imported messages show on the phone and the first new message resumes the
    /// session through `exec resume` / `--resume`.</summary>
    internal async Task<JsonNode?> AdoptAsync(string key, string? file, string? title,
        CancellationToken cancellation)
    {
        var entry = entries.FirstOrDefault(e => e.Key == key) ?? throw new IOException("未找到该 Agent 注册");
        var child = children.GetValueOrDefault(key);
        if (!entry.Enabled || child?.Process is not { Process.HasExited: false })
            throw new IOException("工作区未运行——先启用它再接管会话");
        if (file is not { Length: > 0 }) throw new IOException("缺少会话文件");
        var full = Path.GetFullPath(file);
        if (!full.StartsWith(HistoryRoot(entry.Engine) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase))
            throw new IOException("会话文件不在引擎目录内");
        var match = System.Text.RegularExpressions.Regex.Match(Path.GetFileName(full),
            "([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})");
        if (!match.Success) throw new IOException("无法从会话文件解析会话 ID");
        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"http://127.0.0.1:{child.Port}/local/v1/tasks");
        request.Headers.Authorization = new("Bearer", child.Token);
        request.Content = System.Net.Http.Json.JsonContent.Create(new
        {
            requestKey = "adopt-" + entry.Key + "-"
                + Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)),
            projectId = Path.GetFileName(entry.Project.TrimEnd(Path.DirectorySeparatorChar)) ?? "workspace",
            engineId = entry.Engine,
            instruction = "接管会话：" + (title is { Length: > 0 } t ? t[..Math.Min(60, t.Length)] : match.Groups[1].Value[..8]),
            adoptSessionId = match.Groups[1].Value,
        });
        using var response = await probe.SendAsync(request, cancellation);
        var text = await response.Content.ReadAsStringAsync(cancellation);
        if (!response.IsSuccessStatusCode)
        {
            var code = JsonNode.Parse(text)?["code"]?.GetValue<string>();
            throw new IOException(code is "ADOPT_WRONG_PROJECT"
                ? "此会话属于别的工作区目录，先把工作区切到会话所在项目"
                : code ?? $"HTTP {(int)response.StatusCode}");
        }
        return JsonNode.Parse(text);
    }

    /// <summary>Local vendor-CLI session history: the bundled cli-bridge's
    /// `history` subcommand scans the engine's session root (read-only) and
    /// emits one JSON document. The file arg must stay inside that root.</summary>
    internal async Task<JsonNode?> HistoryListAsync(string engine, CancellationToken cancellation) =>
        await RunHistoryAsync(engine, null, cancellation);

    internal async Task<JsonNode?> HistoryReadAsync(string engine, string? file, CancellationToken cancellation)
    {
        if (file is not { Length: > 0 }) throw new IOException("缺少会话文件");
        var root = HistoryRoot(engine);
        var full = Path.GetFullPath(file);
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException("会话文件不在引擎目录内");
        return await RunHistoryAsync(engine, full, cancellation);
    }

    private static string HistoryRoot(string engine) => engine switch
    {
        "codex" => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".codex", "sessions"),
        "claude" => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".claude", "projects"),
        _ => throw new IOException("不支持查看历史的引擎：" + engine),
    };

    private async Task<JsonNode?> RunHistoryAsync(string engine, string? file, CancellationToken cancellation)
    {
        var root = HistoryRoot(engine);
        if (!File.Exists(nodeExe) || !File.Exists(bridge))
            throw new IOException("安装缺少 cli-bridge 组件");
        var launch = LinkHost.ProcessInfo(nodeExe,
            Directory.Exists(root) ? root : LinkProtocol.Root);
        launch.ArgumentList.Add(bridge);
        launch.ArgumentList.Add("history");
        launch.ArgumentList.Add("--engine"); launch.ArgumentList.Add(engine);
        launch.ArgumentList.Add("--root"); launch.ArgumentList.Add(root);
        launch.ArgumentList.Add("--limit"); launch.ArgumentList.Add(file is null ? "10" : "60");
        if (file is not null) { launch.ArgumentList.Add("--file"); launch.ArgumentList.Add(file); }
        using var process = Process.Start(launch) ?? throw new IOException("读取进程启动失败");
        _ = process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            var text = await output;
            return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(); } catch (Exception error) when (error is InvalidOperationException or Win32Exception) { }
            throw;
        }
    }

    internal async Task<(bool Ok, string? Detail)> TestAsync(string key)
    {
        var entry = entries.FirstOrDefault(e => e.Key == key) ?? throw new IOException("未找到该 Agent 注册");
        var child = children.GetValueOrDefault(key);
        if (child?.Process is not { Process.HasExited: false })
            return (false, "未运行——先启用此工作区");
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"http://127.0.0.1:{child.Port}/local/v1/identity");
            request.Headers.Authorization = new("Bearer", child.Token);
            using var response = await probe.SendAsync(request, CancellationToken.None);
            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadAsStringAsync();
            return (true, body.Length > 512 ? body[..512] : body);
        }
        catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
        {
            return (false, "引擎不可达：" + error.Message);
        }
    }

    /// <summary>Resolve a CLI name to an absolute executable using the host's
    /// own PATH plus vendor install locations the CLI never adds itself to.</summary>
    internal static string? FindExecutable(string engine)
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            foreach (var ext in new[] { ".exe", ".cmd", ".bat" })
            {
                var candidate = Path.Combine(dir, engine + ext);
                if (File.Exists(candidate)) return candidate;
            }
        }
        if (engine == "claude")
        {
            var p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".local", "bin", "claude.exe");
            if (File.Exists(p)) return p;
        }
        if (engine == "codex")
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenAI", "Codex", "bin");
            if (Directory.Exists(root))
                foreach (var dir in Directory.EnumerateDirectories(root).OrderBy(d => d))
                {
                    var p = Path.Combine(dir, "codex.exe");
                    if (File.Exists(p)) return p;
                }
        }
        return null;
    }

    internal static string DisplayName(string engine) => engine switch
    {
        "claude" => "Claude",
        "codex" => "Codex",
        "pi" => "Sage Pi",
        _ => engine,
    };

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    public void Dispose()
    {
        foreach (var (key, child) in children.ToArray())
        {
            children.Remove(key);
            if (child.Process is { } owned)
            {
                try { owned.Process.Kill(); } catch (Exception error) when (error is InvalidOperationException or Win32Exception) { }
                owned.Dispose();
            }
        }
        probe.Dispose();
    }
}
