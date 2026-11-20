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
    private static readonly TimeSpan RespawnCooldown = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(12);
    private static readonly System.Text.RegularExpressions.Regex EngineShape =
        new("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");

    internal sealed record Entry(string Key, string Engine, string Project,
        string? Executable, string? Model, bool SkipPermissions, bool Enabled,
        // "cc" forces the cc-switch proxy route, "official" forces the
        // engine's own login/config; null = auto (cc when attached).
        string? Provider = null);
    private sealed record Registry(List<Entry> Agents, List<string>? DisabledStores = null);

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
    private readonly Dictionary<string, (CcSwitch.Route? Route, DateTimeOffset Expires)> routeViews = new();
    private List<Entry> entries = [];
    private bool gatewayUp;
    private bool detectRan;
    private readonly HashSet<string> detectedStores = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> detectedBins = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> disabledStores = new(StringComparer.OrdinalIgnoreCase);

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
                if (registry?.DisabledStores is { } gone)
                    disabledStores.UnionWith(gone);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            entries = [];
        }
        // Store engines seed in DetectOnceAsync from the bridge's own adapter
        // knowledge — the host carries no vendor store locations of its own.
    }

    internal IReadOnlyList<ManagedAgent> List() => entries
        .Select(e => ToView(e, children.GetValueOrDefault(e.Key))).ToArray();

    private ManagedAgent ToView(Entry e, Child? c)
    {
        var available = e.Executable is not null ? RouteView(e.Engine) : null;
        var running = c?.Process is { Process.HasExited: false };
        var detail = e.Enabled ? c?.Detail : "已停用";
        if (c?.CcRoute is { Proxied: true, RouteName: { } routeName })
            detail = (detail ?? "就绪") + " · cc:" + routeName;
        return new(e.Key, e.Engine, e.Project, e.Executable, e.Model, e.SkipPermissions, e.Enabled,
            running, running ? "managed-" + e.Key : null, detail,
            c?.CcRoute?.RouteName,
            available?.Models ?? c?.CcRoute?.Models, e.Provider, RouteAvailable(available));
    }

    private CcSwitch.Route? RouteView(string engine)
    {
        if (!CcSwitch.SupportsRouting(engine)) return null;
        var now = DateTimeOffset.UtcNow;
        if (routeViews.TryGetValue(engine, out var cached) && cached.Expires > now) return cached.Route;
        var route = CcSwitch.Resolve(engine);
        routeViews[engine] = (route, now.AddSeconds(10));
        return route;
    }

    private static bool RouteAvailable(CcSwitch.Route? route) => route is { BaseUrl: not null, Token: not null };

    internal Entry Add(string engine, string? executable, string project,
        string? model, bool skipPermissions, bool enabled = true)
    {
        if (!EngineShape.IsMatch(engine)) throw new IOException("引擎名无效：" + engine);
        project = Path.GetFullPath(project);
        if (project.StartsWith(@"\\") || project.Length > 1024 || !Directory.Exists(project))
            throw new IOException("工作区目录不存在：" + project);
        // Store engines wrap no CLI — they serve a vendor session db read-only.
        // "devin" stays a backstop literal for adds that race the first detect.
        var storeOnly = engine == "devin" || detectedStores.Contains(engine);
        executable = storeOnly ? null
            : string.IsNullOrWhiteSpace(executable)
                ? detectedBins.GetValueOrDefault(engine) ?? FindExecutable(engine)
                : Path.GetFullPath(executable);
        if (!storeOnly && (executable is null || !File.Exists(executable)))
            throw new IOException($"未找到 {engine} 可执行文件，请手动指定路径");
        if (model is { Length: > 128 } || model?.Any(c => c is '\r' or '\n') == true)
            throw new IOException("模型名无效");
        var entry = new Entry(engine + "-" + Convert.ToHexStringLower(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)),
            engine, project, executable, string.IsNullOrWhiteSpace(model) ? null : model.Trim(),
            skipPermissions, enabled);
        var next = entries.Select(e => enabled && e.Enabled && SameEngine(e, entry)
            ? e with { Enabled = false } : e).Append(entry).ToList();
        foreach (var displaced in entries.Where(e => enabled && e.Enabled && SameEngine(e, entry)))
            EnsureIdle(displaced);
        var tombstones = disabledStores.Where(e => !string.Equals(e, engine, StringComparison.OrdinalIgnoreCase)).ToList();
        Persist(next, tombstones);
        entries = next;
        disabledStores.Remove(engine);
        return entry;
    }

    internal async Task UpdateAsync(string key, JsonNode args, CancellationToken cancellation)
    {
        var index = IndexOf(key);
        var previous = entries[index];
        var entry = previous;
        if (args["skipPermissions"] is { } skip)
        {
            var on = skip.GetValue<bool>();
            entry = entry with { SkipPermissions = on };
        }
        if (args["project"]?.GetValue<string>() is { Length: > 0 } project)
        {
            var full = Path.GetFullPath(project);
            if (full.StartsWith(@"\\") || full.Length > 1024 || !Directory.Exists(full))
                throw new IOException("工作区目录不存在或不可用：" + project);
            entry = entry with { Project = full };
        }
        if (args["executable"]?.GetValue<string>() is { Length: > 0 } executable)
        {
            var full = Path.GetFullPath(executable);
            if (previous.Executable is null || !File.Exists(full)) throw new IOException("可执行文件不可用：" + executable);
            entry = entry with { Executable = full };
        }
        if (args.AsObject().ContainsKey("model"))
        {
            var value = args["model"]?.GetValue<string>();
            if (value is { Length: > 128 } || value?.Any(c => c is '\r' or '\n') == true)
                throw new IOException("模型名无效");
            var trimmed = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            entry = entry with { Model = trimmed };
        }
        if (args.AsObject().ContainsKey("provider"))
        {
            var value = args["provider"]?.GetValue<string>();
            if (value is not (null or "cc" or "official")) throw new IOException("provider 只能是 cc/official");
            if (value == "cc" && value != previous.Provider
                && (!CcSwitch.SupportsRouting(entry.Engine) || !RouteAvailable(CcSwitch.Resolve(entry.Engine))))
                throw new IOException("请先在 CC Switch 启用此引擎的本机路由。");
            entry = entry with { Provider = value };
        }
        var restart = entry != previous;
        var enableRequested = args["enabled"]?.GetValue<bool>();
        if (enableRequested is { } enabled) entry = entry with { Enabled = enabled };
        var next = entries.Select(e => e.Key == key ? entry
            : enableRequested == true && e.Enabled && SameEngine(e, entry) ? e with { Enabled = false } : e).ToList();
        var stopping = entries.Where(e => e.Enabled && (e.Key == key
            ? restart || !entry.Enabled : enableRequested == true && SameEngine(e, entry))).ToArray();
        if (entries.SequenceEqual(next)) return;
        foreach (var affected in stopping) EnsureIdle(affected);
        cancellation.ThrowIfCancellationRequested();
        Persist(next, [.. disabledStores]);
        entries = next;
        foreach (var affected in stopping)
            if (children.TryGetValue(affected.Key, out var child))
                await StopChildAsync(affected.Key, child, unregister: true);
    }

    internal async Task RemoveAsync(string key, CancellationToken cancellation)
    {
        var removed = entries[IndexOf(key)];
        EnsureIdle(removed);
        var next = entries.Where(e => e.Key != key).ToList();
        // Removing a store row means "don't auto-seed it again" — tombstone the
        // engine so DetectOnceAsync stays honest across restarts.
        var excluded = disabledStores.ToList();
        if (removed.Executable is null && !disabledStores.Contains(removed.Engine)) excluded.Add(removed.Engine);
        cancellation.ThrowIfCancellationRequested();
        Persist(next, excluded);
        entries = next;
        disabledStores.UnionWith(excluded);
        if (children.TryGetValue(key, out var child))
            await StopChildAsync(key, child, unregister: true);
    }

    private int IndexOf(string key)
    {
        var index = entries.FindIndex(e => e.Key == key);
        if (index < 0) throw new IOException("未找到该 Agent 注册：" + key);
        return index;
    }

    private static bool SameEngine(Entry one, Entry other) =>
        string.Equals(one.Engine, other.Engine, StringComparison.OrdinalIgnoreCase);

    private void EnsureIdle(Entry entry)
    {
        if (!children.TryGetValue(entry.Key, out var child) || child.Process is not { Process.HasExited: false }) return;
        var ledger = Path.Combine(stateRoot, entry.Key, "ledger.json");
        using var stream = File.OpenRead(ledger);
        using var data = JsonDocument.Parse(stream);
        var tasks = data.RootElement.GetProperty("tasks");
        var activeTask = tasks.EnumerateObject().Any(task =>
            task.Value.TryGetProperty("quiescent", out var idle) && idle.ValueKind == JsonValueKind.False
            || task.Value.GetProperty("state").GetString() is not ("SUCCEEDED" or "FAILED" or "CANCELLED" or "PAUSED"));
        var activeQuestion = data.RootElement.TryGetProperty("sessionQuestions", out var questions)
            && questions.EnumerateObject().Any(q => q.Value.GetProperty("state").GetString() == "RUNNING");
        if (activeTask || activeQuestion) throw new IOException("此工作区有任务正在执行，完成后再应用配置。");
    }

    private void Save() => Persist(entries, [.. disabledStores]);

    private void Persist(List<Entry> next, List<string> excluded)
    {
        Directory.CreateDirectory(LinkProtocol.Root);
        LinkIdentity.SaveAtomic(file, JsonSerializer.SerializeToUtf8Bytes(
            new Registry(next, excluded), LinkProtocol.Json));
    }

    /// <summary>Gateway (re)started: all owner-side registrations are gone —
    /// re-register on the next reconcile. Bridge processes keep running.</summary>
    internal void GatewayRestarted()
    {
        gatewayUp = true;
        foreach (var child in children.Values) child.Registered = false;
    }

    internal void GatewayStopped() => gatewayUp = false;

    // A live managed worker which has not registered has no gateway reservation.
    internal bool HasUnregisteredWorker => children.Values.Any(
        child => !child.Registered && child.Process is { Process.HasExited: false });

    internal Task StopForUpdateAsync() => Task.WhenAll(children.Values
        .Select(child => child.Process?.StopForUpdateAsync(requireCleanExit: false) ?? Task.CompletedTask));

    internal async Task ReconcileAsync(CancellationToken cancellation)
    {
        if (!gatewayUp) return;
        await DetectOnceAsync(cancellation);
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

    /// Bridge-declared discovery (worker-adapter/1 §detect): `cli-bridge.mjs
    /// detect` reports what every loaded adapter can see — a resolved binary
    /// for spawn engines, existing data dirs for stores. Store engines with
    /// data present seed a managed row; spawn bins feed FindExecutable. Runs
    /// once per host start — failures fall back to the built-in guesses.
    private async Task DetectOnceAsync(CancellationToken cancellation)
    {
        if (detectRan || !File.Exists(nodeExe) || !File.Exists(bridge)) return;
        detectRan = true;
        try
        {
            using var process = Process.Start(new ProcessStartInfo(nodeExe, $"\"{bridge}\" detect")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (process is null) return;
            var stdout = await process.StandardOutput.ReadToEndAsync(cancellation);
            await process.WaitForExitAsync(cancellation);
            if (process.ExitCode != 0) return;
            foreach (var row in JsonNode.Parse(stdout)?["engines"]?.AsArray() ?? [])
            {
                var id = row?["id"]?.GetValue<string>();
                if (id is not { Length: > 0 }) continue;
                var hasData = row?["dataDirs"] is JsonArray { Count: > 0 };
                var binPath = row?["binPath"]?.GetValue<string>();
                switch (row?["kind"]?.GetValue<string>())
                {
                    case "store" when hasData:
                        detectedStores.Add(id);
                        break;
                    case "both" or "spawn" when binPath is { Length: > 0 }:
                        detectedBins[id] = binPath;
                        break;
                    // A both-kind engine whose CLI is gone but whose session
                    // store remains still earns a read-only row.
                    case "both" when hasData:
                        detectedStores.Add(id);
                        break;
                }
            }
            var seeded = false;
            foreach (var id in detectedStores)
            {
                if (disabledStores.Contains(id) || entries.Any(e => e.Engine == id)) continue;
                entries.Add(new Entry(id + "-" + Convert.ToHexStringLower(
                    System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)),
                    id, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    null, null, false, Enabled: true));
                seeded = true;
            }
            if (seeded) Save();
        }
        catch (Exception error) when (error is IOException or Win32Exception or JsonException
            or InvalidOperationException || error is OperationCanceledException && !cancellation.IsCancellationRequested)
        {
            // node/bridge missing or malformed output — the per-engine
            // hardcoded discovery below still covers the built-ins.
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
        // A store child spawns no CLI itself but side questions may spawn any
        // engine — hand it every attached engine's proxy env up front.
        if (entry.Executable is null)
        {
            child.CcRoute = null;
            foreach (var qe in new[] { "claude", "codex" })
                if (CcSwitch.Resolve(qe) is { } qRoute) CcSwitch.Apply(qRoute, qe, launch);
        }
        else
        {
            child.CcRoute = entry.Provider == "official" ? null : CcSwitch.Resolve(entry.Engine);
            if (entry.Provider == "cc" && child.CcRoute is null)
                throw new IOException("cc-switch 未给 " + entry.Engine + " 挂接路由");
            if (child.CcRoute is { } ccRoute) CcSwitch.Apply(ccRoute, entry.Engine, launch);
        }
        // The project id crosses the wire inside scope grants where only the
        // gateway's id shape is legal — a basename that isn't (e.g. a
        // non-ASCII profile dir like %USERPROFILE%) is hashed instead so the
        // backend stays reachable instead of being silently dropped.
        var projectId = ProjectId(entry.Project);
        var projectName = Path.GetFileName(entry.Project.TrimEnd(Path.DirectorySeparatorChar)) ?? "workspace";
        launch.ArgumentList.Add(bridge);
        launch.ArgumentList.Add("serve");
        launch.ArgumentList.Add("--engine"); launch.ArgumentList.Add(entry.Engine);
        launch.ArgumentList.Add("--state"); launch.ArgumentList.Add(Path.Combine(stateRoot, entry.Key));
        launch.ArgumentList.Add("--port"); launch.ArgumentList.Add(port.ToString());
        launch.ArgumentList.Add("--project"); launch.ArgumentList.Add(entry.Project);
        launch.ArgumentList.Add("--project-id"); launch.ArgumentList.Add(projectId);
        launch.ArgumentList.Add("--project-name"); launch.ArgumentList.Add(projectName);
        if (entry.Executable is { } exe)
        {
            launch.ArgumentList.Add("--executable"); launch.ArgumentList.Add(exe);
        }
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
        if (engine == "opencode")
        {
            // The desktop app bundles resources\opencode-cli.exe under
            // @opencode-* folders, including updater's .update-<hash> twins —
            // newest folder name first so an update-in-place wins.
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs");
            if (Directory.Exists(root))
                foreach (var dir in Directory.EnumerateDirectories(root, "@opencode*")
                             .OrderByDescending(d => d))
                {
                    var p = Path.Combine(dir, "resources", "opencode-cli.exe");
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
        "devin" => "Devin",
        "opencode" => "OpenCode",
        _ => engine,
    };

    /// Wire-safe project id: the directory basename when it already matches
    /// the gateway's id shape, otherwise a stable hash of the full path so a
    /// non-ASCII basename (e.g. the profile dir under a CJK username) cannot
    /// make the backend's scope grants unwritable.
    internal static string ProjectId(string project)
    {
        var name = Path.GetFileName(project.TrimEnd(Path.DirectorySeparatorChar));
        if (!string.IsNullOrEmpty(name) && System.Text.RegularExpressions.Regex.IsMatch(
                name, @"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
            return name;
        var hash = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(Path.GetFullPath(project)));
        return "project-" + Convert.ToHexStringLower(hash)[..12];
    }

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
