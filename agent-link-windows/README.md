# Agent Link for Windows

This preview installs a WPF tray app, a per-user host and the existing PAC device gateway on Windows x64. The host manages the gateway with a Windows Job Object. Gateway identity and pairing state live under the current user's local application data. Closing the panel leaves the host running.

Click the blue chain icon in the Windows notification area to open or dismiss the compact panel. Windows may initially place it in the notification overflow. Escape or clicking outside dismisses the panel. Right-click the icon for settings and exit. The panel follows the Windows app theme; login startup stays in the notification area without opening a panel or taskbar window.

Open **Agent Link** from Start. In **Agent**, choose **接入已运行的 Worker…** and select the registration card from a trusted local Worker. Pi normally writes its card under `%USERPROFILE%\.agent-gateway\workers.d` while it runs. In **连接**, choose **连接手机** and scan the invitation from Control on the same network. The invitation includes the selected Worker's available launch scopes. When the selected Worker becomes available, Agent Link updates the launch choices for paired phones while preserving access to their existing tasks. The **设置** tab controls login startup.

The preview uses the Mac gateway's existing listener switch. Turning off **允许手机连接** closes the phone listener. Windows network policy determines whether a phone can reach the listener. Tailscale addresses are advertised when a running Tailscale client reports them.

## Build

Install gateway build dependencies with `npm --prefix device-gateway ci` at the repository root. Use the .NET 10 SDK, WiX 6, and a Windows x64 Node 24 distribution from 24.18.0 onward that includes its license.

```powershell
.\agent-link-windows\packaging\build.ps1 -Dotnet <dotnet.exe> -Wix <wix.exe> -Node <node.exe>
```

The output directory contains the MSI and a manifest of the packaged files. The supplied build script produces an unsigned internal preview. The MSI installs the application and its runtimes in the current user's Programs folder. For a preview upgrade or uninstall, exit through the tray first. Removing the package preserves the user's local state.

The brand vector master is `src/AgentLink.App/Assets/Brand.xaml`. After editing it, run `powershell.exe -NoProfile -STA -File agent-link-windows/packaging/export-icon.ps1` from the repository root and commit the exported ICO. Its nine native sizes (16–256 px) are shared by the tray, executable, Start shortcut and installed-app entry. Normal builds consume the checked-in ICO and require no image tools.

Keep the three-part product version in `Directory.Build.props` and `AgentLink.wxs` synchronized. PE file versions use `1.<product version>` because the first preview shipped `1.0.0.0`; Windows Installer must see increasing file versions when upgrading that preview. The packaging script checks both versions before producing an MSI.

State-root startup regression checks run without opening a UI or touching user data:

```powershell
dotnet build agent-link-windows/tests/AgentLink.Contracts.Smoke
foreach ($case in 'absent','empty','whitespace','explicit') {
    dotnet run --no-build --project agent-link-windows/tests/AgentLink.Contracts.Smoke -- $case
    if ($LASTEXITCODE) { throw "State-root case failed: $case" }
}
```

The preview supports an explicitly attached Worker and direct connectivity. The membership connector, managed CLI configuration, firewall setup, and release signing are tracked in the Windows Agent Link design and handoff in EnterpriseDevopsAI.
