[CmdletBinding()]
param(
    [ValidateSet('Inspect', 'Backup')]
    [string]$Action = 'Inspect',
    [Parameter(Mandatory = $true)]
    [string]$ProfileRoot,
    [Parameter(Mandatory = $true)]
    [string]$ProfileId,
    [string]$Channel = 'stable',
    [string]$ServiceConfig,
    [string]$StateDir,
    [string]$BackupDestination
)

$ErrorActionPreference = 'Stop'
$MaxInspectFiles = 512
$MaxBackupFiles = 4096
$MaxBackupBytes = 4GB

function Get-FullPath([string]$PathValue) {
    if ($PathValue -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') {
        throw "Path must be absolute: $PathValue"
    }
    return [System.IO.Path]::GetFullPath($PathValue)
}

function Get-NormalPath([string]$PathValue) {
    return (Get-FullPath $PathValue).TrimEnd('\', '/')
}

function Test-Within([string]$Parent, [string]$Candidate) {
    $p = (Get-NormalPath $Parent).ToLowerInvariant()
    $c = (Get-NormalPath $Candidate).ToLowerInvariant()
    return $c -eq $p -or $c.StartsWith($p + '\')
}

function Assert-SafeId([string]$Value, [string]$Name) {
    if ($Value -notmatch '^[a-z0-9][a-z0-9-]{0,47}$' -or
        $Value -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
        throw "$Name is not a safe lowercase profile/channel id"
    }
}

function Assert-NormalDirectory([string]$PathValue, [string]$Name, [switch]$AllowMissing) {
    $full = Get-FullPath $PathValue
    if (-not (Test-Path -LiteralPath $full)) {
        if ($AllowMissing) { return $full }
        throw "$Name does not exist: $full"
    }
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer -or $item.LinkType) {
        throw "$Name must be a normal directory without a reparse link: $full"
    }
    return $item.FullName.TrimEnd('\', '/')
}

function Read-Properties([string]$PathValue) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $PathValue) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
        $parts = $trimmed.Split('=', 2)
        $values[$parts[0].Trim()] = $parts[1].Trim()
    }
    return $values
}

function Get-SafeEndpoint([string]$Endpoint) {
    try {
        $uri = [Uri]$Endpoint
        if ($uri.Scheme -ne 'http' -or
            $uri.Host -notin @('127.0.0.1', 'localhost', '::1', '[::1]') -or
            $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
            ($uri.AbsolutePath -and $uri.AbsolutePath -ne '/')) {
            return 'INVALID_ENDPOINT'
        }
        return $uri.GetLeftPart([System.UriPartial]::Authority)
    } catch {
        return 'INVALID_ENDPOINT'
    }
}

function Get-OwnerMatches([string]$ConfigPathValue) {
    try {
        $needle = (Get-FullPath $ConfigPathValue).Replace('/', '\').ToLowerInvariant()
        $matches = @()
        foreach ($process in @(Get-CimInstance Win32_Process -Property ProcessId, Name, CommandLine)) {
            $commandLine = [string]$process.CommandLine
            if ($commandLine.Length -gt 0 -and $commandLine.Replace('/', '\').ToLowerInvariant().Contains($needle)) {
                $matches += [pscustomobject]@{
                    pid = [int]$process.ProcessId
                    name = [string]$process.Name
                    commandLineContainsConfig = $true
                }
            }
        }
        return [pscustomobject]@{ Available = $true; Matches = $matches; Error = $null }
    } catch {
        return [pscustomobject]@{ Available = $false; Matches = @(); Error = $_.Exception.Message }
    }
}

function Get-BoundedFiles([string]$Root, [int]$MaxFiles, [long]$MaxBytes, [switch]$AllowTruncated) {
    $files = @(Get-ChildItem -LiteralPath $Root -File -Recurse | Select-Object -First ($MaxFiles + 1))
    $truncated = $files.Count -gt $MaxFiles
    if ($truncated -and -not $AllowTruncated) { throw "File count exceeds bounded limit: $MaxFiles" }
    if ($truncated) { $files = @($files | Select-Object -First $MaxFiles) }
    if ($files | Where-Object { $_.LinkType }) { throw 'State inventory contains a reparse-linked file' }
    $sum = ($files | Measure-Object -Property Length -Sum).Sum
    $totalBytes = if ($null -eq $sum) { [long]0 } else { [long]$sum }
    if ($totalBytes -gt $MaxBytes) { throw "State size exceeds bounded limit: $MaxBytes bytes" }
    return [pscustomobject]@{ Files = $files; Count = $files.Count; TotalBytes = $totalBytes; Truncated = $truncated }
}

Assert-SafeId $ProfileId 'ProfileId'
Assert-SafeId $Channel 'Channel'
$root = Assert-NormalDirectory $ProfileRoot 'ProfileRoot' -AllowMissing
$profileDir = Join-Path (Join-Path $root $Channel) $ProfileId
$profileDir = Assert-NormalDirectory $profileDir 'ProfileDir' -AllowMissing

$resolvedServiceConfig = $null
$properties = @{}
if ($ServiceConfig) {
    $resolvedServiceConfig = Get-FullPath $ServiceConfig
    if (-not (Test-Path -LiteralPath $resolvedServiceConfig -PathType Leaf)) {
        throw "ServiceConfig does not exist: $resolvedServiceConfig"
    }
    $properties = Read-Properties $resolvedServiceConfig
}

$resolvedStateDir = $null
if ($StateDir) { $resolvedStateDir = Assert-NormalDirectory $StateDir 'StateDir' -AllowMissing }
elseif ($properties.ContainsKey('state.dir')) { $resolvedStateDir = Assert-NormalDirectory $properties['state.dir'] 'state.dir' -AllowMissing }

if ($resolvedStateDir -and (Test-Within $root $resolvedStateDir -or Test-Within $resolvedStateDir $root)) {
    throw 'ProfileRoot and stateDir overlap; choose separate ownership roots'
}
if ($Action -eq 'Backup') {
    if (-not $resolvedServiceConfig) { throw 'Backup requires -ServiceConfig for owner proof' }
    if (-not $resolvedStateDir -or -not (Test-Path -LiteralPath $resolvedStateDir -PathType Container)) {
        throw 'Backup requires an existing stateDir'
    }
    if (-not $BackupDestination) { throw 'Backup requires an explicit -BackupDestination' }
    $destination = Get-FullPath $BackupDestination
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Backup destination parent must already exist: $parent"
    }
    if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite existing backup: $destination" }
    if (Test-Within $resolvedStateDir $destination -or Test-Within $destination $resolvedStateDir) {
        throw 'Backup destination overlaps stateDir'
    }
    $ownerCheck = Get-OwnerMatches $resolvedServiceConfig
    if (-not $ownerCheck.Available) {
        throw 'Owner proof unavailable: process inspection was denied; rerun with sufficient read permission'
    }
    if ($ownerCheck.Matches.Count -gt 0) {
        throw 'Owner proof failed: a process still contains ServiceConfig; stop it through its owner and retry'
    }
}

$manifestPath = Join-Path $profileDir 'profile-manifest.json'
$manifest = $null
$manifestBytes = $null
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force
    $manifestBytes = [long]$manifestItem.Length
    if ($manifestItem.Length -gt 4096) { throw 'profile-manifest.json exceeds the implementation limit' }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
    catch { $manifest = [pscustomobject]@{ invalid = $true } }
}

$configPath = Join-Path $profileDir 'user-data\config.json'
$tokenPath = Join-Path $profileDir 'user-data\token.enc'
$configSummary = [ordered]@{
    exists = Test-Path -LiteralPath $configPath -PathType Leaf
    bytes = $null
    attachEndpoint = $null
    hasBundledService = $false
    hasTokenEnc = Test-Path -LiteralPath $tokenPath -PathType Leaf
}
if ($configSummary.exists) {
    $configItem = Get-Item -LiteralPath $configPath -Force
    $configSummary.bytes = [long]$configItem.Length
    if ($configItem.Length -le 64KB) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            if ($config.attachEndpoint -is [string]) { $configSummary.attachEndpoint = Get-SafeEndpoint $config.attachEndpoint }
            $configSummary.hasBundledService = $null -ne $config.bundledService
            $configSummary.lastServiceInstanceId = $config.lastServiceInstanceId
        } catch { $configSummary.invalid = $true }
    } else { $configSummary.invalid = $true }
}

$invalidManifests = @()
if (Test-Path -LiteralPath $profileDir -PathType Container) {
    $invalidManifests = @(Get-ChildItem -LiteralPath $profileDir -Filter '.profile-manifest.json.invalid.*.json' -File -ErrorAction SilentlyContinue |
        Select-Object -First 32 -Property Name, Length, LastWriteTimeUtc)
}
$stateSummary = $null
if ($resolvedStateDir) {
    $inventory = $null
    if (Test-Path -LiteralPath $resolvedStateDir -PathType Container) {
        $inventory = Get-BoundedFiles $resolvedStateDir $MaxInspectFiles $MaxBackupBytes -AllowTruncated
    }
    $stateSummary = [ordered]@{
        path = $resolvedStateDir
        exists = Test-Path -LiteralPath $resolvedStateDir -PathType Container
        fileCountCappedAt512 = if ($inventory) { $inventory.Count } else { 0 }
        inventoryTruncated = if ($inventory) { $inventory.Truncated } else { $false }
        totalBytesCappedAt4GiB = if ($inventory) { $inventory.TotalBytes } else { 0 }
        guiSessionsDb = Test-Path -LiteralPath (Join-Path $resolvedStateDir 'gui-sessions.db') -PathType Leaf
        guiSessionsDbBytes = if (Test-Path -LiteralPath (Join-Path $resolvedStateDir 'gui-sessions.db') -PathType Leaf) { [long](Get-Item -LiteralPath (Join-Path $resolvedStateDir 'gui-sessions.db') -Force).Length } else { $null }
        migrationBackupDirectory = Test-Path -LiteralPath (Join-Path $resolvedStateDir 'control-plane-migration-backups') -PathType Container
    }
}

$matchingProcesses = @()
$ownerCheck = $null
if ($resolvedServiceConfig) {
    $ownerCheck = Get-OwnerMatches $resolvedServiceConfig
    $matchingProcesses = @($ownerCheck.Matches)
}
$result = [ordered]@{
    action = $Action
    profileRoot = $root
    channel = $Channel
    profileId = $ProfileId
    profileDir = $profileDir
    manifest = if ($manifest) {
        [ordered]@{
            exists = $true
            invalid = $manifest.invalid -eq $true
            bytes = $manifestBytes
            schemaVersion = $manifest.schemaVersion
            manifestProfileId = $manifest.profileId
            clientId = $manifest.clientId
            lastProcessInstanceId = $manifest.lastProcessInstanceId
            channel = $manifest.channel
            createdByVersion = $manifest.createdByVersion
        }
    } else { [ordered]@{ exists = $false } }
    invalidManifestFiles = $invalidManifests
    config = $configSummary
    state = $stateSummary
    ownerProof = if ($resolvedServiceConfig) {
        [ordered]@{
            serviceConfig = $resolvedServiceConfig
            status = if ($ownerCheck.Available) { 'AVAILABLE' } else { 'UNAVAILABLE' }
            matchingProcessCount = $matchingProcesses.Count
            matchingProcesses = $matchingProcesses
            error = $ownerCheck.Error
            backupRequiresZeroMatchingProcesses = $true
        }
    } else { [ordered]@{ status = 'NOT_CHECKED'; reason = 'ServiceConfig not supplied' } }
}

if ($Action -eq 'Backup') {
    $sourceInventory = Get-BoundedFiles $resolvedStateDir $MaxBackupFiles $MaxBackupBytes
    Copy-Item -LiteralPath $resolvedStateDir -Destination $destination -Recurse
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) { throw 'Backup did not produce a destination directory' }
    $targetInventory = Get-BoundedFiles $destination $MaxBackupFiles $MaxBackupBytes
    if ($sourceInventory.Count -ne $targetInventory.Count -or $sourceInventory.TotalBytes -ne $targetInventory.TotalBytes) {
        throw 'Backup inventory differs from source; mark the destination INCOMPLETE and do not use it'
    }
    $targetDb = Join-Path $destination 'gui-sessions.db'
    $result.backup = [ordered]@{
        destination = $destination
        complete = $true
        fileCount = $targetInventory.Count
        totalBytes = $targetInventory.TotalBytes
        guiSessionsDbSha256 = if (Test-Path -LiteralPath $targetDb -PathType Leaf) { (Get-FileHash -LiteralPath $targetDb -Algorithm SHA256).Hash } else { $null }
    }
}

$result | ConvertTo-Json -Depth 8
