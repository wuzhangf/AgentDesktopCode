[CmdletBinding()]
param(
    [switch]$Build,
    [string]$Profile,
    [string]$ServiceConfig,
    [string]$Endpoint,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if ($env:AGENT_ENV_PS1 -and (Test-Path $env:AGENT_ENV_PS1)) { . $env:AGENT_ENV_PS1 }
$AppRoot = if ($PSScriptRoot) {
    [System.IO.Path]::GetFullPath($PSScriptRoot)
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $AppRoot) {
    throw 'Unable to resolve the codeagent-desktop script root.'
}
$BusinessRoot = Split-Path -Parent (Split-Path -Parent $AppRoot)
$ConfigPath = if ($ServiceConfig) {
    if (-not [System.IO.Path]::IsPathRooted($ServiceConfig)) {
        throw '-ServiceConfig must be an absolute path'
    }
    [System.IO.Path]::GetFullPath($ServiceConfig)
} else {
    Join-Path $BusinessRoot 'busi-agent-config\service.properties'
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Missing service configuration: $ConfigPath"
}

$properties = @{}
Get-Content -LiteralPath $ConfigPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line.Split('=', 2)
        $properties[$parts[0].Trim()] = $parts[1].Trim()
    }
}

$hostName = if ($properties.ContainsKey('server.host')) { $properties['server.host'] } else { '127.0.0.1' }
$port = if ($properties.ContainsKey('server.port')) { $properties['server.port'] } else { '8766' }
if ($properties.ContainsKey('auth.token-env')) {
    $tokenEnvName = $properties['auth.token-env']
    if ($tokenEnvName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw 'service.properties auth.token-env is invalid'
    }
    $token = [Environment]::GetEnvironmentVariable($tokenEnvName)
} else {
    $token = if ($properties.ContainsKey('auth.token')) { $properties['auth.token'] } else { '' }
}
if ($hostName -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) {
    throw 'service.properties server.host must be a loopback host'
}
if ([string]::IsNullOrWhiteSpace([string]$token) -or ([string]$token).Length -lt 16) {
    throw 'service.properties must contain an auth.token of at least 16 characters'
}

$configuredHost = if ($hostName -in @('::1', '[::1]')) { '[::1]' } else { $hostName }
$configuredEndpoint = 'http://{0}:{1}' -f $configuredHost, $port
$endpoint = if ($Endpoint) { $Endpoint } else { $configuredEndpoint }
try {
    $endpointUri = [Uri]$endpoint
    if ($endpointUri.Scheme -ne 'http' -or
        $endpointUri.Host -notin @('127.0.0.1', 'localhost', '::1', '[::1]') -or
        $endpointUri.UserInfo -or $endpointUri.Query -or $endpointUri.Fragment -or
        ($endpointUri.AbsolutePath -and $endpointUri.AbsolutePath -ne '/')) {
        throw 'Endpoint must be an http loopback URL without credentials, query, fragment or path'
    }
} catch {
    throw "Invalid -Endpoint: $($_.Exception.Message)"
}
if ($Endpoint -and $ServiceConfig -and $Endpoint.TrimEnd('/') -ne $configuredEndpoint.TrimEnd('/')) {
    throw '-Endpoint and -ServiceConfig point to different service endpoints'
}
if ($Profile) {
    if ($Profile -notmatch '^[a-z0-9][a-z0-9-]{0,47}$' -or $Profile -in @('con', 'prn', 'aux', 'nul') -or
        $Profile -match '^(com|lpt)[1-9]$') {
        throw '-Profile must be a safe lowercase profile id'
    }
    Set-Item -Path Env:CODEAGENT_DESKTOP_PROFILE -Value $Profile
}
$liveUri = $endpoint + '/health/live'
$capabilitiesUri = $endpoint + '/api/v2/capabilities'
try {
    $live = Invoke-WebRequest -UseBasicParsing -Uri $liveUri -TimeoutSec 3 -ErrorAction Stop
    if ([int]$live.StatusCode -ne 200) { throw "HTTP $($live.StatusCode)" }
} catch {
    throw "Business Service is not ready at $endpoint. Start codex-dev-run.ps1 with the same -ServiceConfig first."
}

try {
    $headers = @{ Authorization = 'Bearer ' + $token }
    $capabilitiesResponse = Invoke-WebRequest -UseBasicParsing -Uri $capabilitiesUri -Headers $headers -TimeoutSec 5 -ErrorAction Stop
    $capabilities = $capabilitiesResponse.Content | ConvertFrom-Json
} catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 401) {
        throw 'Business Service rejected auth.token. Refresh the service token and launch again.'
    }
    throw "Business Service capability handshake failed at $endpoint."
}

if ([string]::IsNullOrWhiteSpace([string]$capabilities.protocolVersion)) {
    throw 'Business Service returned an invalid capability handshake.'
}

Set-Item -Path Env:CODEAGENT_SERVICE_ENDPOINT -Value $endpoint
Set-Item -Path Env:CODEAGENT_SERVICE_TOKEN -Value $token
Set-Item -Path Env:CODEAGENT_SERVICE_MODE -Value 'SHARED_ATTACH'
Write-Output "Business Service ready at $endpoint (protocol $($capabilities.protocolVersion), mode SHARED_ATTACH)."

if ($CheckOnly) { exit 0 }

Set-Location -LiteralPath $AppRoot
if ($Build) {
    & pnpm build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& pnpm start
exit $LASTEXITCODE
