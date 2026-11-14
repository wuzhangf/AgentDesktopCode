param(
    [Parameter(Mandatory = $true)][string]$Dotnet,
    [Parameter(Mandatory = $true)][string]$Wix,
    [Parameter(Mandatory = $true)][string]$Node,
    [string]$ConnectorPackage,
    [string]$OutputRoot = '.local/agent-link-windows-release'
)
$ErrorActionPreference = 'Stop'
$product = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $product -Parent
$out = [IO.Path]::GetFullPath($OutputRoot)
$version = ([xml](Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'AgentLink.wxs'))).Wix.Package.Version
$managedVersion = ([xml](Get-Content -Raw -LiteralPath (Join-Path $product 'Directory.Build.props'))).Project.PropertyGroup.Version
if ($version -ne $managedVersion) { throw 'Installer and managed product versions must match.' }
if (Test-Path -LiteralPath $out) { throw 'Choose a fresh output directory.' }
$payload = Join-Path $out 'payload'
$hostOutput = Join-Path $payload 'host'
New-Item -ItemType Directory -Path $out | Out-Null
$gateway = Join-Path $repo 'device-gateway'

& npm.cmd --prefix $gateway run build
if ($LASTEXITCODE) { throw 'Gateway build failed.' }
& $Dotnet publish (Join-Path $product 'src/AgentLink.App') -c Release -r win-x64 --self-contained -o $payload
if ($LASTEXITCODE) { throw 'Tray build failed.' }
& $Dotnet publish (Join-Path $product 'src/AgentLink.Host') -c Release -r win-x64 --self-contained -o $hostOutput
if ($LASTEXITCODE) { throw 'Host build failed.' }
$fileVersion = (Get-Item -LiteralPath (Join-Path $payload 'AgentLink.exe')).VersionInfo.FileVersion
if ([version]$fileVersion -ne [version]"1.$version") { throw 'Unexpected PE file version; preview upgrades must remain above 1.0.0.0.' }

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
$manifest = [ordered]@{
    schemaVersion = 1
    product = 'Agent Link'
    version = $version
    fileVersion = $fileVersion
    build = 'windows-lan-preview'
    gatewayBaseRevision = $gatewaySha
    gatewayWorkingTree = [bool](git -C $repo status --porcelain -- device-gateway)
    nodeVersion = $nodeVersion
    routes = @('lan', 'tailscale')
    worker = 'external-registration-card'
    connector = $connectorIncluded
    files = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($payload.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash }
    })
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $payload 'release-manifest.json') -Encoding utf8
$msi = Join-Path $out "Agent-Link-$version-win-x64.msi"
$icon = Join-Path $product 'src/AgentLink.App/Assets/AgentLink.ico'
& $Wix build -arch x64 -d "Payload=$payload" -d "IconFile=$icon" (Join-Path $PSScriptRoot 'AgentLink.wxs') -o $msi
if ($LASTEXITCODE) { throw 'MSI build failed.' }
Get-FileHash -LiteralPath $msi -Algorithm SHA256
