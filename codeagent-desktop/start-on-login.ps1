#Requires -Version 5.1
<#
  Starts the dedicated Business service on 8766 and then the desktop app when
  the interactive Windows user logs in. The script is intentionally separate
  from start-detached.ps1: the latter is an operator-facing fail-fast launcher
  and must not silently start a second service.
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if (Test-Path 'D:\project\env\env.ps1') { . 'D:\project\env\env.ps1' }
$AppRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$BusinessRoot = [IO.Path]::GetFullPath((Join-Path $AppRoot '..\..'))
$ConfigPath = [IO.Path]::GetFullPath((Join-Path $BusinessRoot 'busi-agent-config\service.properties'))
$ServiceLauncher = Join-Path $BusinessRoot 'busi-agent-config\start-service.ps1'
$ElectronCmd = Join-Path $AppRoot 'node_modules\.bin\electron.CMD'

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Missing service configuration: $ConfigPath"
}
if (-not (Test-Path -LiteralPath $ServiceLauncher -PathType Leaf)) {
    throw "Missing service launcher: $ServiceLauncher"
}

function Read-Properties([string]$Path) {
    $values = @{}
    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $pair = $line.Split('=', 2)
            $values[$pair[0].Trim()] = $pair[1].Trim()
        }
    }
    return $values
}

function Owned-ServiceProcess {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
        Where-Object {
            [string]$_.CommandLine -like '*com.sage.agentcode.local.AgentCodeLocalMain*' -and
            [string]$_.CommandLine -like "*$ConfigPath*"
        })
}

function Service-IsReady {
    try {
        $uri = 'http://{0}:{1}/health/live' -f $hostName, $port
        $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 2 -ErrorAction Stop
        return [int]$response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$properties = Read-Properties $ConfigPath
$hostName = if ($properties.ContainsKey('server.host')) { [string]$properties['server.host'] } else { '127.0.0.1' }
$port = if ($properties.ContainsKey('server.port')) { [int]$properties['server.port'] } else { 8766 }
if ($hostName -notin @('127.0.0.1', 'localhost', '::1')) {
    throw 'The dedicated local service must bind to a loopback host.'
}
if ($port -ne 8766) {
    throw "The Codex desktop autostart is restricted to port 8766; configured port was $port."
}

$tokenEnvName = if ($properties.ContainsKey('auth.token-env')) { [string]$properties['auth.token-env'] } else { 'CODEAGENT_SERVICE_TOKEN' }
if ($tokenEnvName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw 'service.properties auth.token-env is invalid.'
}
$token = [Environment]::GetEnvironmentVariable($tokenEnvName)
if ([string]::IsNullOrWhiteSpace([string]$token) -or ([string]$token).Length -lt 16) {
    throw "The user environment variable $tokenEnvName is missing or too short."
}

# Prefer the same artifact repository used by the currently installed local
# launcher. It is configurable through the user environment, with the
# workspace-local repository as the portable fallback.
$mavenRepository = [Environment]::GetEnvironmentVariable('AGENT_CODE_MAVEN_REPOSITORY')
if ([string]::IsNullOrWhiteSpace($mavenRepository) -and $properties.ContainsKey('service.maven.repository')) {
    $mavenRepository = [string]$properties['service.maven.repository']
}
if ([string]::IsNullOrWhiteSpace($mavenRepository)) {
    $workspaceRepository = Join-Path $BusinessRoot '.local\m2-split-baseline'
    if (Test-Path -LiteralPath $workspaceRepository -PathType Container) {
        # The desktop autostart must use the same verified dependency set as
        # the dedicated 8766 launcher. A machine-wide Maven cache can contain
        # an older same-version sandbox/framework jar and would silently
        # resurrect the pre-fix runtime after the next login.
        $mavenRepository = $workspaceRepository
    } elseif (Test-Path -LiteralPath 'D:\software\.m2\repository' -PathType Container) {
        $mavenRepository = 'D:\software\.m2\repository'
    } else {
        $mavenRepository = $workspaceRepository
    }
}
$mavenRepository = [IO.Path]::GetFullPath($mavenRepository)

$ownedService = Owned-ServiceProcess
if (-not $ownedService -and -not (Service-IsReady)) {
    $logDir = Join-Path $BusinessRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $serviceLog = Join-Path $logDir "service-autostart-$stamp.log"
    $serviceErrLog = Join-Path $logDir "service-autostart-$stamp.err.log"
    $serviceArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $ServiceLauncher + '" -ConfigPath "' + $ConfigPath + '" -MavenRepository "' + $mavenRepository + '" -SkipCompile'
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $BusinessRoot -ArgumentList $serviceArguments -RedirectStandardOutput $serviceLog -RedirectStandardError $serviceErrLog | Out-Null
}

$deadline = (Get-Date).AddSeconds(60)
while (-not (Service-IsReady) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
}
if (-not (Service-IsReady)) {
    throw 'Business service 8766 did not become ready within 60 seconds.'
}

$endpoint = 'http://{0}:{1}' -f $hostName, $port
Set-Item Env:CODEAGENT_SERVICE_ENDPOINT -Value $endpoint
Set-Item Env:CODEAGENT_SERVICE_TOKEN -Value $token
Set-Item Env:CODEAGENT_SERVICE_MODE -Value 'SHARED_ATTACH'

if ($CheckOnly) {
    Write-Output "CodeAgent autostart ready at $endpoint"
    exit 0
}

if (-not (Test-Path -LiteralPath $ElectronCmd -PathType Leaf)) {
    throw "Electron launcher not found: $ElectronCmd"
}
$existingDesktop = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object {
        [string]$_.CommandLine -like "*$AppRoot*" -and
        [string]$_.CommandLine -notmatch '--type='
    })
if (-not $existingDesktop) {
    $logDir = Join-Path $BusinessRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $appLog = Join-Path $logDir "electron-autostart-$stamp.log"
    $appErrLog = Join-Path $logDir "electron-autostart-$stamp.err.log"
    Start-Process -FilePath $ElectronCmd -ArgumentList '.' -WorkingDirectory $AppRoot -RedirectStandardOutput $appLog -RedirectStandardError $appErrLog | Out-Null
}
Write-Output "CodeAgent Desktop autostart completed at $endpoint"
