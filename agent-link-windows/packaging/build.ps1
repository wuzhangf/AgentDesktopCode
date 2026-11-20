param(
    [Parameter(Mandatory = $true)][string]$Dotnet,
    [Parameter(Mandatory = $true)][string]$Wix,
    [Parameter(Mandatory = $true)][string]$Node,
    [string]$ConnectorPackage,
    [string]$LinkFilesWorker,
    [string]$CliBridge,
    [string]$OutputRoot = '.local/agent-link-windows-release'
)
$ErrorActionPreference = 'Stop'
$product = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $product -Parent
$out = [IO.Path]::GetFullPath($OutputRoot)
$defaultVersion = ([xml](Get-Content -Raw -LiteralPath (Join-Path $product 'Directory.Build.props'))).Project.PropertyGroup.Version
$requestedVersion = if ($env:AGENT_LINK_PRODUCT_VERSION) { $env:AGENT_LINK_PRODUCT_VERSION } else { $defaultVersion }
$parsedVersion = $null
if ($requestedVersion -notmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z' -or
    ![version]::TryParse($requestedVersion, [ref]$parsedVersion) -or
    $parsedVersion.Major -gt 255 -or $parsedVersion.Minor -gt 255 -or $parsedVersion.Build -gt 65535) {
    throw 'AGENT_LINK_PRODUCT_VERSION must fit the three numeric fields of Windows Installer ProductVersion.'
}
$version = $parsedVersion.ToString(3)
$expectedFileVersion = "1.$version"
$requestedBuild = if ($env:AGENT_LINK_BUILD_NUMBER) { $env:AGENT_LINK_BUILD_NUMBER } else { '1' }
[long]$buildNumber = 0
if ($requestedBuild -notmatch '\A[1-9][0-9]*\z' -or ![long]::TryParse($requestedBuild, [ref]$buildNumber) -or
    $buildNumber -gt 9007199254740991) {
    throw 'AGENT_LINK_BUILD_NUMBER must be a positive decimal integer representable in the release record.'
}
$versionArgs = @("-p:Version=$version", "-p:FileVersion=$expectedFileVersion")
if (Test-Path -LiteralPath $out) { throw 'Choose a fresh output directory.' }
$payload = Join-Path $out 'payload'
$hostOutput = Join-Path $payload 'host'
New-Item -ItemType Directory -Path $out | Out-Null
$gateway = Join-Path $repo 'device-gateway'

& npm.cmd --prefix $gateway run build
if ($LASTEXITCODE) { throw 'Gateway build failed.' }
& $Dotnet publish (Join-Path $product 'src/AgentLink.App') -c Release -r win-x64 --self-contained -o $payload @versionArgs
if ($LASTEXITCODE) { throw 'Tray build failed.' }
& $Dotnet publish (Join-Path $product 'src/AgentLink.Host') -c Release -r win-x64 --self-contained -o $hostOutput @versionArgs
if ($LASTEXITCODE) { throw 'Host build failed.' }
$fileVersion = (Get-Item -LiteralPath (Join-Path $payload 'AgentLink.exe')).VersionInfo.FileVersion
$hostFileVersion = (Get-Item -LiteralPath (Join-Path $hostOutput 'AgentLink.Host.exe')).VersionInfo.FileVersion
if ([version]$fileVersion -ne [version]$expectedFileVersion -or [version]$hostFileVersion -ne [version]$expectedFileVersion) {
    throw 'Tray and Host executables must both carry the expected PE file version.'
}

$runtime = (New-Item -ItemType Directory -Path (Join-Path $payload 'runtime')).FullName
$gatewayOutput = (New-Item -ItemType Directory -Force -Path (Join-Path $payload 'components/gateway')).FullName
$nodeVersion = & $Node --version
if ($LASTEXITCODE -or $nodeVersion -notmatch '^v24\.\d+\.\d+$' -or [version]$nodeVersion.Substring(1) -lt [version]'24.18.0') {
    throw 'Node 24.18 or later in the 24.x line is required.'
}
$license = Join-Path (Split-Path $Node -Parent) 'LICENSE'
if (!(Test-Path -LiteralPath $license)) { throw 'Use a Node distribution that includes LICENSE.' }
Copy-Item -LiteralPath $Node -Destination (Join-Path $runtime 'gateway-node.exe')
Copy-Item -LiteralPath $license -Destination (Join-Path $runtime 'NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $product 'runtime/await-parent.mjs') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $gateway 'dist/device-gateway.mjs') -Destination $gatewayOutput

# Managed cli-bridge: the Host spawns gateway-node.exe components/cli-bridge/
# cli-bridge.mjs per registered workspace. Source is the Windows-specific
# AgentWorkersCode-windows-link fork (vendor-session history readers are
# Windows-specific there); pass -CliBridge to override the lookup.
$workspace = Split-Path $repo -Parent
$cliBridgeSrc = if ($CliBridge) { [IO.Path]::GetFullPath($CliBridge) } else {
    $found = @(
        (Join-Path $workspace 'AgentWorkersCode-windows-link\cli-bridge\host.mjs'),
        (Join-Path $workspace 'AgentWorkersCode\cli-bridge\host.mjs')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$found) { throw 'cli-bridge source not found — pass -CliBridge <host.mjs>.' }
    $found
}
if (!(Test-Path -LiteralPath $cliBridgeSrc)) { throw "cli-bridge source missing: $cliBridgeSrc" }
if (!(Select-String -LiteralPath $cliBridgeSrc -Pattern 'skip-permissions' -Quiet)) {
    throw 'cli-bridge source lacks --skip-permissions support — stale checkout? pass -CliBridge.'
}
$cliBridgeSha = git -C (Split-Path $cliBridgeSrc -Parent) rev-parse HEAD
if ($LASTEXITCODE) { throw 'Could not read cli-bridge source revision.' }
$bridgeOutput = (New-Item -ItemType Directory -Force -Path (Join-Path $payload 'components/cli-bridge')).FullName
Copy-Item -LiteralPath $cliBridgeSrc -Destination (Join-Path $bridgeOutput 'cli-bridge.mjs')
# Bundled worker adapters (worker-adapter/1): the bridge scans
# <bridge-dir>/adapters/<id>/adapter.mjs — ship the source adapters dir
# beside the copied host so devin/opencode resolve at runtime.
$adaptersSrc = Join-Path (Split-Path $cliBridgeSrc -Parent) 'adapters'
if (Test-Path -LiteralPath $adaptersSrc) {
    Copy-Item -LiteralPath $adaptersSrc -Destination $bridgeOutput -Recurse -Force
}

# Optional locked PAC relay connector (control-relay-package/1 from
# AgentCodeService build/package-control-relay.py). Its contents land at
# components/connector so the Host can supervise python -m daily_relay.pac_launcher.
$connectorIncluded = $false
if ($ConnectorPackage) {
    $connectorSrc = [IO.Path]::GetFullPath($ConnectorPackage)
    $connectorManifest = Join-Path $connectorSrc 'relay-manifest.json'
    if (!(Test-Path -LiteralPath $connectorManifest)) { throw 'Connector package manifest missing.' }
    $connectorSchema = (Get-Content -Raw -LiteralPath $connectorManifest | ConvertFrom-Json).schemaVersion
    if ($connectorSchema -ne 'control-relay-package/1') { throw "Unexpected connector package schema: $connectorSchema" }
    if (!(Test-Path -LiteralPath (Join-Path $connectorSrc 'python/python.exe'))) { throw 'Connector python runtime missing.' }
    Copy-Item -LiteralPath $connectorSrc -Destination (Join-Path $payload 'components/connector') -Recurse
    $connectorIncluded = $true
}

$gatewaySha = git -C $repo rev-parse HEAD
if ($LASTEXITCODE) { throw 'Could not read gateway source revision.' }
if ($LinkFilesWorker) {
    if (!(Test-Path -LiteralPath $LinkFilesWorker -PathType Leaf)) { throw 'File transfer worker missing.' }
    $filesOutput = (New-Item -ItemType Directory -Path (Join-Path $payload 'components/files')).FullName
    Copy-Item -LiteralPath $LinkFilesWorker -Destination (Join-Path $filesOutput 'agent-link-files.exe')
}
$manifest = [ordered]@{
    schemaVersion = 1
    product = 'Agent Link'
    version = $version
    buildNumber = $buildNumber
    fileVersion = $fileVersion
    build = 'windows-lan-preview'
    gatewayBaseRevision = $gatewaySha
    gatewayWorkingTree = [bool](git -C $repo status --porcelain -- device-gateway)
    nodeVersion = $nodeVersion
    routes = @('lan', 'tailscale')
    worker = 'external-registration-card + managed-cli-bridge'
    cliBridgeRevision = $cliBridgeSha
    connector = $connectorIncluded
    files = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($payload.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash }
    })
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $payload 'release-manifest.json') -Encoding utf8
$msi = Join-Path $out "Agent-Link-$version-win-x64.msi"
$icon = Join-Path $product 'src/AgentLink.App/Assets/AgentLink.ico'
& $Wix build -arch x64 -d "Payload=$payload" -d "IconFile=$icon" -d "LinkProductVersion=$version" (Join-Path $PSScriptRoot 'AgentLink.wxs') -o $msi
if ($LASTEXITCODE) { throw 'MSI build failed.' }
Get-FileHash -LiteralPath $msi -Algorithm SHA256
