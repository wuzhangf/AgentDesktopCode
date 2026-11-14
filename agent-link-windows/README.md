# Agent Link for Windows

This preview installs a WPF tray app, a per-user host and the existing PAC device gateway on Windows x64. The host manages the gateway with a Windows Job Object. Gateway identity and pairing state live under the current user's local application data. Closing the panel leaves the host running.

Open **Agent Link** from Start. In **Agent**, choose **接入已运行的 Worker…** and select the registration card from a trusted local Worker. Pi normally writes its card under `%USERPROFILE%\.agent-gateway\workers.d` while it runs. In **连接**, choose **连接手机** and scan the invitation from Control on the same network. The invitation includes the selected Worker's available launch scopes. Create a fresh pairing invitation after changing the authorized source. The **设置** tab controls login startup.

The preview uses the Mac gateway's existing listener switch. Turning off **允许手机连接** closes the phone listener. Windows network policy determines whether a phone can reach the listener. Tailscale addresses are advertised when a running Tailscale client reports them.

## Build

Install gateway build dependencies with `npm --prefix device-gateway ci` at the repository root. Use the .NET 10 SDK, WiX 6, and a Windows x64 Node 24 distribution from 24.18.0 onward that includes its license.

```powershell
.\agent-link-windows\packaging\build.ps1 -Dotnet <dotnet.exe> -Wix <wix.exe> -Node <node.exe>
```

The output directory contains the MSI and a manifest of the packaged files. The supplied build script produces an unsigned internal preview. The MSI installs the application and its runtimes in the current user's Programs folder. For a preview upgrade or uninstall, exit through the tray first. Removing the package preserves the user's local state.

The preview supports an explicitly attached Worker and direct connectivity. The membership connector, managed CLI configuration, firewall setup, and release signing are tracked in the Windows Agent Link design and handoff in EnterpriseDevopsAI.
