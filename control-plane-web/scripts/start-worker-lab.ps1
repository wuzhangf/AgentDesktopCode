param(
    [int]$Port = 8796,
    [string]$RealProject = $env:REAL_PROJECT_ROOT ?? 'D:\workspace\demo-springboot-crud',
    [ValidateSet('Central')][string]$ModelProvider = 'Central',
    [switch]$ProtocolModel,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
. $env:AGENT_ENV_PS1
foreach ($name in @('MODEL_BASE_URL','MODEL_NAME','MODEL_API_KEY')) {
    if (-not [Environment]::GetEnvironmentVariable($name,'Process')) { throw ('Central configuration is missing '+$name) }
}
$appRoot = Split-Path -Parent $PSScriptRoot
$previousModel = @{}
foreach ($name in @('MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY')) {
    $previousModel[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location -LiteralPath $appRoot
try {
    $launchArgs = @('scripts/worker-fixture.py', '--port', [string]$Port)
    $bundle = Join-Path $appRoot '.local\worker-live-e2e\regression-final'
    if (-not (Test-Path -LiteralPath (Join-Path $bundle 'result.json'))) {
        throw 'Build the verified patch bundle with scripts/worker-regression.py first. See README.'
    }
    $launchArgs += @('--patch-bundle', $bundle)
    if (-not $ProtocolModel) {
        $launchArgs += @('--live-project', $RealProject)
    }
    if ($SkipBuild) { $launchArgs += '--skip-build' }
    & python @launchArgs
    if ($LASTEXITCODE -ne 0) { throw 'Worker Lab exited unsuccessfully.' }
}
finally {
    foreach ($name in $previousModel.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousModel[$name], 'Process')
    }
    Pop-Location
}
