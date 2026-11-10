$ErrorActionPreference = 'Stop'
if ($env:AGENT_ENV_PS1 -and (Test-Path $env:AGENT_ENV_PS1)) { . $env:AGENT_ENV_PS1 }
if ([string]::IsNullOrWhiteSpace($env:CODEAGENT_SERVICE_TOKEN)) { throw 'CODEAGENT_SERVICE_TOKEN is missing (set AGENT_ENV_PS1 or the env var)' }
$existing = Get-Process -Name electron -ErrorAction SilentlyContinue
if ($existing) { throw ("Electron already running (pid " + $existing[0].Id + "); close it first.") }
$appRoot = $PSScriptRoot
$businessRoot = Split-Path -Parent (Split-Path -Parent $appRoot)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CODEAGENT_SERVICE_ENDPOINT = 'http://127.0.0.1:8769'
$env:CODEAGENT_SERVICE_MODE = 'SHARED_ATTACH'
$electron = Join-Path $appRoot 'node_modules\.bin\electron.CMD'
$logDir = Join-Path $businessRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$proc = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $appRoot -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "electron-8769-$stamp.log") `
    -RedirectStandardError (Join-Path $logDir "electron-8769-$stamp.err.log")
Write-Output "electron pid=$($proc.Id) endpoint=http://127.0.0.1:8769"
