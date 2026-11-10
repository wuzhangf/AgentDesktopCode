#Requires -Version 5.1
<#
  start-detached.ps1 — 无 pnpm 的 Electron 分离启动（2026-09-05 实录验证）
  与 start-with-service.ps1 的差别：
    - 不依赖 pnpm（本机 pnpm 常不在 PATH，见调试指南坑18）
    - Start-Process 分离启动：Electron 不随当前终端/会话退出
    - 就绪校验与 env 注入口径与 start-with-service.ps1 完全一致（坑3/14）
  用法：
    .\start-detached.ps1              # 校验 + 分离启动 Electron
    .\start-detached.ps1 -CheckOnly   # 只校验服务健康与握手，不启动
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if ($env:AGENT_ENV_PS1 -and (Test-Path $env:AGENT_ENV_PS1)) { . $env:AGENT_ENV_PS1 }
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BusinessRoot = Split-Path -Parent (Split-Path -Parent $AppRoot)
$Launcher = Join-Path $AppRoot 'start-with-service.ps1'
$ElectronCmd = Join-Path $AppRoot 'node_modules\.bin\electron.CMD'

# 单实例锁（坑9）：已有 Electron 在跑时新实例会秒退，先拒绝而不是静默失败
$existing = Get-Process -Name electron -ErrorAction SilentlyContinue
if ($existing -and -not $CheckOnly) {
    throw ("已有 Electron 实例在运行 (pid {0})。先关闭当前 CodeAgent Desktop 再启动（调试指南坑9）。" -f ($existing | Select-Object -First 1).Id)
}

# 复用标准启动器的健康+握手校验；子进程 stderr 走 2>&1 捕获，
# PS 5.1 下须局部降级 EAP，否则 stderr 行会变成终止错误（见 zcode-dev-run.ps1 头部说明）
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $checkOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Launcher -CheckOnly 2>&1
    $checkCode = $LASTEXITCODE
} finally {
    if ($prevEap) { $ErrorActionPreference = $prevEap }
}
$checkOut | ForEach-Object { Write-Host ("  {0}" -f $_) }
if ($checkCode -ne 0) { throw "start-with-service -CheckOnly 失败 (exit $checkCode)，服务未就绪或 token 不匹配。" }
if ($CheckOnly) { exit 0 }

# endpoint/token 从同一份 service.properties 读取，只注入本次 Electron 进程（坑3/14）
$props = @{}
Get-Content -LiteralPath (Join-Path $BusinessRoot 'busi-agent-config\service.properties') | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $kv = $line.Split('=', 2); $props[$kv[0].Trim()] = $kv[1].Trim()
    }
}
$endpoint = 'http://{0}:{1}' -f $props['server.host'], $props['server.port']
$token = if ($props.ContainsKey('auth.token-env')) {
    $environmentName = [string]$props['auth.token-env']
    if ($environmentName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'service.properties auth.token-env 无效' }
    [Environment]::GetEnvironmentVariable($environmentName)
} else { [string]$props['auth.token'] }
if (-not $token -or $token.Length -lt 16) { throw 'service.properties 缺少有效 bearer token' }
Set-Item Env:CODEAGENT_SERVICE_ENDPOINT -Value $endpoint
Set-Item Env:CODEAGENT_SERVICE_TOKEN -Value $token
Set-Item Env:CODEAGENT_SERVICE_MODE -Value 'SHARED_ATTACH'

if (-not (Test-Path -LiteralPath $ElectronCmd -PathType Leaf)) { throw "electron 启动器不存在: $ElectronCmd（先安装依赖）" }
$logDir = Join-Path $BusinessRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $logDir "electron-app-$stamp.log"
$errLog = Join-Path $logDir "electron-app-$stamp.err.log"

$proc = Start-Process -FilePath $ElectronCmd -ArgumentList '.' -WorkingDirectory $AppRoot -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Host ("Electron 已分离启动 pid={0} endpoint={1}" -f $proc.Id, $endpoint) -ForegroundColor Green
Write-Host ("日志: {0}" -f $outLog)
