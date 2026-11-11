[CmdletBinding()]
param(
    [switch]$SkipCompile,
    [switch]$SmokeOnly,
    [switch]$VerifyOnly,
    [switch]$FullUpstream,
    [switch]$AllowMavenNetwork,
    [switch]$KillExisting,
    [string]$ServiceConfig = '',
    [string]$FrameworkDir = '',
    [string]$ProductsDir = '',
    [string]$FoundationDir = '',
    [string]$MavenRepo = ''
)
$ErrorActionPreference='Stop'
if ($env:AGENT_ENV_PS1) {
    if (-not (Test-Path -LiteralPath $env:AGENT_ENV_PS1 -PathType Leaf)) { throw "Missing environment loader: $env:AGENT_ENV_PS1" }
    . $env:AGENT_ENV_PS1
}
$root=(Resolve-Path $PSScriptRoot).Path
$runner=Join-Path $root 'service-config\start-service.ps1'
if(-not (Test-Path -LiteralPath $runner -PathType Leaf)){throw "Missing client service launcher: $runner"}
if($FullUpstream -or $AllowMavenNetwork -or $FrameworkDir -or $ProductsDir -or $FoundationDir){Write-Warning 'Upstream override switches are retained for compatibility; AgentCodeService resolves its released dependency closure.'}
$args=@()
if($ServiceConfig){$args += @('-ConfigPath',[IO.Path]::GetFullPath($ServiceConfig))}
if($SkipCompile){$args += '-SkipCompile'}
if($SmokeOnly){$args += '-SmokeOnly'}
if($VerifyOnly){$args += '-VerifyOnly'}
if($KillExisting){$args += '-KillExisting'}
if($MavenRepo){$args += @('-MavenRepository',[IO.Path]::GetFullPath($MavenRepo))}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner @args
exit $LASTEXITCODE
