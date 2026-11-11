[CmdletBinding()]
param(
    [string]$ReleaseDirectory,
    [switch]$SkipCompile,
    [switch]$VerifyOnly,
    [switch]$SmokeOnly,
    [switch]$KillExisting,
    [string]$MavenRepository = $env:AGENT_CODE_MAVEN_REPOSITORY,
    [string]$ConfigPath = ''
)
$ErrorActionPreference = 'Stop'
if ($env:AGENT_ENV_PS1) {
    if (-not (Test-Path -LiteralPath $env:AGENT_ENV_PS1 -PathType Leaf)) { throw "Missing environment loader: $env:AGENT_ENV_PS1" }
    . $env:AGENT_ENV_PS1
}
$configRoot=(Resolve-Path $PSScriptRoot).Path
$businessRoot=(Resolve-Path (Join-Path $configRoot '..')).Path
$configPath=if($ConfigPath){[IO.Path]::GetFullPath($ConfigPath)}else{Join-Path $configRoot 'service.properties'}
if(-not (Test-Path -LiteralPath $configPath -PathType Leaf)){throw "Missing service configuration: $configPath"}
if([string]::IsNullOrWhiteSpace($MavenRepository)){ $MavenRepository=Join-Path $businessRoot '.local\m2-split-baseline' }

# The client repository owns this operator entry point, but the service is now
# an external AgentCodeService artifact/source repository.
if(-not [string]::IsNullOrWhiteSpace($ReleaseDirectory)){
    $release=[IO.Path]::GetFullPath($ReleaseDirectory)
    $classes=Join-Path $release 'lib'
    if(-not (Test-Path -LiteralPath $classes -PathType Container)){throw "Service release lib directory was not found: $classes"}
    $provenanceSchemaVersion='business-runtime-provenance/1'
    $provenanceSnapshotId='agent-code-release-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + ([guid]::NewGuid().ToString('N'))
    & java ("-Dbusiness.runtime.provenance.snapshotId={0}" -f $provenanceSnapshotId) ("-Dbusiness.runtime.provenance.schemaVersion={0}" -f $provenanceSchemaVersion) '-Dbusiness.history.pagination.enabled=true' '-cp' (Join-Path $classes '*') 'com.sage.agentcode.local.AgentCodeLocalMain' '--config' ([IO.Path]::GetFullPath($configPath))
    exit $LASTEXITCODE
}
$serviceRoot=[IO.Path]::GetFullPath((Join-Path $businessRoot '..\AgentCodeService'))
$runner=Join-Path $serviceRoot 'build\run-local.ps1'
if(-not (Test-Path -LiteralPath $runner -PathType Leaf)){throw "AgentCodeService local runner was not found: $runner"}
$args=@('-Config',[IO.Path]::GetFullPath($configPath),'-MavenRepository',[IO.Path]::GetFullPath($MavenRepository))
if($SkipCompile){$args += '-SkipCompile'}
if($VerifyOnly){$args += '-VerifyOnly'}
if($SmokeOnly){$args += '-SmokeOnly'}
if($KillExisting){Write-Warning 'KillExisting is retained for CLI compatibility; process ownership is not inferred by this launcher.'}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner @args
exit $LASTEXITCODE
