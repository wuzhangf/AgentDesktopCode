# 个人 Worker 管理控制台：构建 SSR 服务端并以 127.0.0.1 回环启动
param(
    [int]$Port = 8860,
    [string]$StateRoot = '.local\personal-console',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
if ($env:AGENT_ENV_PS1) { . $env:AGENT_ENV_PS1 }
$appRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $appRoot
try {
    $env:PERSONAL_CONSOLE_PORT = [string]$Port
    $env:PERSONAL_CONSOLE_ROOT = $StateRoot
    if (-not $SkipBuild) {
        & node scripts\management-build.mjs
        if ($LASTEXITCODE -ne 0) { throw 'management-build failed.' }
    }
    & node .local\management-server\management-server.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Management console exited unsuccessfully.' }
}
finally {
    Pop-Location
}
