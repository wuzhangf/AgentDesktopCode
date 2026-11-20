# Agent Link for Windows

This preview installs a WPF tray app, a per-user host and the existing PAC device gateway on Windows x64. The host manages the gateway with a Windows Job Object. Gateway identity and pairing state live under the current user's local application data. Closing the panel leaves the host running.

Left-click the blue chain icon in the Windows notification area to open phone connection. Right-click for **配置 / 用量**. Windows may initially place the icon in notification overflow. Escape or clicking outside dismisses either popup. Login startup runs in the tray. Closing the configuration window hides it while the host stays running.

The **配置** tab groups workspaces by engine. Expand a workspace to switch the active workspace, provider mode, or a known model. **用量** reads the recorded CC Switch request count and input/output tokens for the last 24 hours or seven days. These readings cover the local CC Switch database.

Choose **打开主窗口** or start **Agent Link** from Start to register and edit a workspace. Configure its directory, executable, provider mode and model, or test the running engine. Saving changes reloads the affected managed engine. The host checks for active work before changing or removing a running registration. Provider mode applies to the selected Agent Link workspace, with CC Switch routing available to attached Claude Code and Codex engines.

For Hosted v2 cloud tasks, connect a member account through **手机连接** and choose **云任务授权** in the configuration window. Select the workspaces and engines to publish for cloud launch. The optional control checkbox permits follow-up and stop requests on tasks created through the same grant when the source exposes those actions. Clear the selection and save to withdraw the grant. An installation connected with the older relay profile needs to connect again before this page can grant cloud access. The current Windows consumer accepts native tasks with a text instruction and publishes a reference to the source result in Hosted.

Use **接入 Worker 注册卡…** to attach a trusted local external Worker. Pi normally writes its registration card under `%USERPROFILE%\.agent-gateway\workers.d` while it runs. In **连接**, choose **连接手机** and scan the invitation from Control. As a Worker becomes available, Agent Link updates launch choices for paired phones while preserving their existing task access. Open **设置** in the phone panel for login startup.

The **会员账号** card on the 连接 tab signs the computer into the member relay: **登录会员** starts the device-approval flow, opens the member confirmation page, and keeps the packaged PAC connector supervised once approved. While the connector holds a live route, new invitations automatically carry the same relay binding Agent Link Mac produces, so a signed-in phone can pair from any network. Member credentials stay sealed with DPAPI whenever no connector process is running.

The preview uses the Mac gateway's existing listener switch. Turning off **允许手机连接** closes the phone listener. Windows network policy determines whether a phone can reach the listener. Tailscale addresses are advertised when a running Tailscale client reports them.

For a Windows Host launched with a configured local ACS, set `DEVICE_GATEWAY_ACS_URL` to the loopback ACS origin and load `ACS_TOKEN` from the central environment before starting the Host. In **连接**, select **允许这部手机新建、协作和交接 ACS 会话** before creating the pairing QR. This grants creation, assignment, collaboration and handoff actions. Session operations remain scoped to the device's authorized sessions. Changing the session model requires `INTERACT`. Enable personal access on ACS to expose same-host ACS handoff through Windows Link. Remote ACS writes use the commercial authorization lane and need `DEVICE_GATEWAY_DAILY_ORIGIN`. Hosts without an ACS URL start in the existing CLI profile.

**跨设备文件** opens the signed-in member's device and transfer lists. Choose a recipient before selecting a file, or choose a received file and save it to a location you control. File transfers use the member service and its encrypted object storage. Windows protects the device identity with DPAPI. The file window can resume an admitted upload and manage hosted retention.

## Build

Install gateway build dependencies with `npm --prefix device-gateway ci` at the repository root. Use the .NET 10 SDK, WiX 6, and a Windows x64 Node 24 distribution from 24.18.0 onward that includes its license.

```powershell
.\agent-link-windows\packaging\build.ps1 -Dotnet <dotnet.exe> -Wix <wix.exe> -Node <node.exe> [-ConnectorPackage <dir>] [-CliBridge <host.mjs>] [-LinkFilesWorker <exe>]
```

`-CliBridge` points at the managed-agent bridge source (AgentWorkersCode `cli-bridge/host.mjs`); when omitted the script looks in the sibling `AgentWorkersCode-windows-link` then `AgentWorkersCode` checkouts. The file installs under `components/cli-bridge` and the build refuses a source that lacks the `--skip-permissions` switch.

**cc-switch routing:** when `~/.cc-switch` is present, each managed workspace follows that engine's app route. `direct` mode injects nothing — the CLI's own config (`~/.claude/settings.json`, `~/.codex/auth.json`) rules. `proxy` mode (app attached to a route) injects `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` pointing at cc-switch's local gateway plus its gateway token, so spawned runs keep the user's provider metering and failover. The card detail shows `cc:<route>` while proxied.

`-ConnectorPackage` accepts the locked `control-relay-package/1` artifact produced by `AgentCodeService/build/package-control-relay.py`; its contents install under `components/connector` and enable the member relay. Omitting it produces a direct-connectivity-only build where the member card reports the component as unavailable.

Build the file worker from the `AgentMobileCode` Control Android package with `dart compile exe tool/link_files.dart -o agent-link-files.exe`. Pass that executable to `-LinkFilesWorker` together with the member connector. The Windows Host and the worker exchange requests over process pipes, and the tray uses the current-user-only file pipe.

The output directory contains the MSI, the full payload ZIP, and a manifest of the packaged files. The ZIP and MSI use the same payload tree. The build prints both SHA-256 values. The supplied build script produces an unsigned internal preview. The MSI installs the application and its runtimes in the current user's Programs folder. For a preview upgrade or uninstall, exit through the tray first. Removing the package preserves the user's local state.

The brand vector master is `src/AgentLink.App/Assets/Brand.xaml`. After editing it, run `powershell.exe -NoProfile -STA -File agent-link-windows/packaging/export-icon.ps1` from the repository root and commit the exported ICO. Its nine native sizes (16–256 px) are shared by the tray, executable, Start shortcut and installed-app entry. Normal builds consume the checked-in ICO and require no image tools.

Release builds read `AGENT_LINK_PRODUCT_VERSION` and `AGENT_LINK_BUILD_NUMBER`. The product version has three numeric fields and is shared by the MSI and the managed projects. When unset, the product version comes from `Directory.Build.props` and the build number is 1. The build number is recorded in the release manifest. Change the three-part product version for each MSI upgrade. PE file versions use `1.<product version>` because the first preview shipped `1.0.0.0`. The packaging script verifies the tray and Host file versions before assembling the MSI.

State-root startup regression checks run without opening a UI or touching user data:

```powershell
dotnet build agent-link-windows/tests/AgentLink.Contracts.Smoke
foreach ($case in 'absent','empty','whitespace','explicit','contract-relay-lines','contract-relay-invite','contract-launch-scopes') {
    dotnet run --no-build --project agent-link-windows/tests/AgentLink.Contracts.Smoke -- $case
    if ($LASTEXITCODE) { throw "Smoke case failed: $case" }
}
```

The contract cases cover the connector's `pac-relay/1` route and approval lines, the invite relay-injection guard (host/store/certificate match), and availability-filtered launch-scope expansion.

The versioned payload contract runs separately with `dotnet run --project agent-link-windows/tests/AgentLink.Payload.Smoke`. It exercises archive and manifest verification, busy deferral, version selection after the health callback, and recovery after termination of the selecting process.

The Host exposes `prepare-update` on its local owner pipe. The launcher must hold `LinkUpdateTransition.Acquire(operationId)` throughout the transaction. The Host keeps file operations and connector changes out of the shutdown window and confirms the same operation and gateway boot after the gateway reserves its Workers. The reply identifies the stopping processes. The launcher must also wait for the Host to exit and match the completed `update-stopped.json` receipt before copying state.

The launcher supplies a private copy of `identity.dpapi` and the `gateway` directory under `LinkUpdateTransition.SnapshotPath(operationId)`. The candidate Host's `--probe-update <operationId>` starts only its bundled gateway and verifies the previous host identity, store and device count. The gateway stays fenced until shutdown. The launcher and signed release channel still need to connect this contract to MSI migration and automatic installation.

Run the Host update protocol smoke suite with `dotnet run --project agent-link-windows/tests/AgentLink.Update.Smoke -- <node> <bundled-gateway.mjs> <await-parent.mjs>`. It uses local synthetic state and an actual gateway process.

The preview supports an explicitly attached Worker, direct connectivity, and — in connector builds — the member relay lane. Managed CLI configuration, firewall setup, and release signing are tracked in the Windows Agent Link design and handoff in EnterpriseDevopsAI.
