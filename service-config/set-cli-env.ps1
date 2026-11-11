[CmdletBinding()]
param(
    [string]$ModelApiKey,
    [string]$ProviderApiKey,
    [string]$MemoryApiKey
)

$ErrorActionPreference = 'Stop'
if ($env:AGENT_ENV_PS1) {
    if (-not (Test-Path -LiteralPath $env:AGENT_ENV_PS1 -PathType Leaf)) { throw "Missing environment loader: $env:AGENT_ENV_PS1" }
    . $env:AGENT_ENV_PS1
}
$ConfigRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceProperties = Join-Path $ConfigRoot 'service.properties'
if (-not (Test-Path -LiteralPath $ServiceProperties -PathType Leaf)) {
    throw "Missing service configuration: $ServiceProperties"
}

$service = @{}
Get-Content -LiteralPath $ServiceProperties | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line.Split('=', 2)
        $service[$parts[0].Trim()] = $parts[1].Trim()
    }
}
$token = if ($service.ContainsKey('auth.token-env')) {
    $environmentName = $service['auth.token-env']
    if ($environmentName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'service.properties auth.token-env is invalid' }
    [Environment]::GetEnvironmentVariable($environmentName)
} elseif ($service.ContainsKey('auth.token')) { $service['auth.token'] } else { $null }
if ([string]::IsNullOrWhiteSpace([string]$token) -or ([string]$token).Length -lt 16) {
    throw 'service.properties must provide a bearer token through auth.token-env or auth.token'
}

$env:CODEAGENT_SERVICE_TOKEN = $token
$modelConfigPath = if ($service.ContainsKey('model.config')) {
    $service['model.config']
} else {
    Join-Path $ConfigRoot 'model-providers.properties'
}
if (-not [IO.Path]::IsPathRooted($modelConfigPath)) {
    $modelConfigPath = Join-Path (Split-Path -Parent $ConfigRoot) $modelConfigPath
}
if (-not (Test-Path -LiteralPath $modelConfigPath -PathType Leaf)) {
    throw "Missing independent model catalog: $modelConfigPath"
}
$providerEnvironmentNames = @(Get-Content -LiteralPath $modelConfigPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -match '^PROVIDER_[0-9]+_API_KEY_ENV=(.+)$') {
        $name = $Matches[1].Trim()
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') { $name }
    }
} | Sort-Object -Unique)
$secret = if (-not [string]::IsNullOrWhiteSpace($ProviderApiKey)) {
    $ProviderApiKey
} elseif (-not [string]::IsNullOrWhiteSpace($ModelApiKey)) {
    # Keep the old switch as a command-line compatibility alias; the service
    # itself accepts only PROVIDER_N_* catalog entries.
    $ModelApiKey
} else {
    $null
}
if (-not [string]::IsNullOrWhiteSpace($secret)) {
    foreach ($environmentName in $providerEnvironmentNames) {
        Set-Item -Path "env:$environmentName" -Value $secret
    }
}
if (-not [string]::IsNullOrWhiteSpace($MemoryApiKey)) {
    $memoryEnvironment = $service['memory.api-key-env']
    if ([string]::IsNullOrWhiteSpace($memoryEnvironment)) {
        throw 'MemoryApiKey was supplied but memory.api-key-env is not configured'
    }
    Set-Item -Path "env:$memoryEnvironment" -Value $MemoryApiKey
}
Write-Output "CODEAGENT_SERVICE_TOKEN initialized for http://$($service['server.host']):$($service['server.port'])"
$configuredProvider = $false
foreach ($environmentName in $providerEnvironmentNames) {
    $value = (Get-Item -Path "env:$environmentName" -ErrorAction SilentlyContinue).Value
    if (-not [string]::IsNullOrWhiteSpace($value)) { $configuredProvider = $true; break }
}
if (-not $configuredProvider) {
    Write-Warning 'No configured provider API key is set; health/version work, Product execution will fail until one is provided.'
}
if ($service['memory.enabled'] -eq 'true') {
    $memoryEnvironment = $service['memory.api-key-env']
    $memoryValue = if ([string]::IsNullOrWhiteSpace($memoryEnvironment)) {
        $null
    } else {
        (Get-Item -Path "env:$memoryEnvironment" -ErrorAction SilentlyContinue).Value
    }
    if ([string]::IsNullOrWhiteSpace($memoryValue)) {
        Write-Warning "Memory is enabled but $memoryEnvironment is not set; service startup will fail closed."
    }
}
