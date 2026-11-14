param(
    [Parameter(Mandatory = $true)][string]$Dotnet,
    [Parameter(Mandatory = $true)][string]$Wix,
    [Parameter(Mandatory = $true)][string]$Node,
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
