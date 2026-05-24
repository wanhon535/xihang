param(
  [switch]$DryRun,
  [switch]$AssumeYes,
  [switch]$SkipTests,
  [switch]$Rollback,
  [Parameter(Position = 0)]
  [string]$BackupPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectRoot

function Assert-InProject {
  param([string]$Path)

  $root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
  $full = [System.IO.Path]::GetFullPath($Path)

  if ($full -ne $root -and -not $full.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside project root: $full"
  }
}

function Get-FullPathFromRelative {
  param([string]$RelativePath)

  [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ($RelativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)))
}

function Get-RelativeProjectPath {
  param([string]$Path)

  $full = [System.IO.Path]::GetFullPath($Path)
  Assert-InProject $full
  $rootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $rootUri = [Uri]$rootFull
  $fileUri = [Uri]$full
  [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString()) -replace '\\', '/'
}

function Get-RelativePathFromDirectory {
  param(
    [string]$FromDirectory,
    [string]$TargetPath
  )

  $fromFull = [System.IO.Path]::GetFullPath($FromDirectory).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $targetFull = [System.IO.Path]::GetFullPath($TargetPath)
  $fromUri = [Uri]$fromFull
  $targetUri = [Uri]$targetFull
  [Uri]::UnescapeDataString($fromUri.MakeRelativeUri($targetUri).ToString()) -replace '\\', '/'
}

function Confirm-Action {
  param([string]$Message)

  if ($DryRun) {
    Write-Host "[dry-run] $Message"
    return $false
  }

  if ($AssumeYes) {
    Write-Host "[yes] $Message"
    return $true
  }

  $answer = Read-Host "$Message (y/N)"
  return $answer -match '^(y|yes|Y|YES|是)$'
}

function Find-LatestBackup {
  $latest = Get-ChildItem -LiteralPath $ProjectRoot -Force -Directory -Filter '.backup_*' |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $latest) {
    throw 'No .backup_* directory with manifest.json was found.'
  }

  $latest.FullName
}

function Restore-BackupItem {
  param(
    [string]$BackupRoot,
    [string]$RelativePath
  )

  $source = Join-Path (Join-Path $BackupRoot 'files') ($RelativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  $destination = Get-FullPathFromRelative $RelativePath
  Assert-InProject $destination

  if (-not (Test-Path -LiteralPath $source)) {
    Write-Warning "Backup item missing, cannot restore: $RelativePath"
    return
  }

  $parent = Split-Path -Parent $destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function Invoke-Rollback {
  param([string]$BackupPath)

  if (-not $BackupPath) {
    $BackupPath = Find-LatestBackup
  }

  $BackupPath = [System.IO.Path]::GetFullPath($BackupPath)
  Assert-InProject $BackupPath

  $manifestPath = Join-Path $BackupPath 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found in backup directory: $BackupPath"
  }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $operations = @($manifest.operations)

  Write-Host "Rolling back from $BackupPath"

  for ($i = $operations.Count - 1; $i -ge 0; $i -= 1) {
    $op = $operations[$i]

    switch ($op.type) {
      'delete' {
        Restore-BackupItem -BackupRoot $BackupPath -RelativePath $op.path
      }
      'modify' {
        Restore-BackupItem -BackupRoot $BackupPath -RelativePath $op.path
      }
      'createfile' {
        $target = Get-FullPathFromRelative $op.path
        if (Test-Path -LiteralPath $target) {
          Remove-Item -LiteralPath $target -Force
        }
      }
      'move' {
        $destination = Get-FullPathFromRelative $op.destination
        if (Test-Path -LiteralPath $destination) {
          Remove-Item -LiteralPath $destination -Force
        }

        Restore-BackupItem -BackupRoot $BackupPath -RelativePath $op.source

        if ($op.destinationExisted) {
          Restore-BackupItem -BackupRoot $BackupPath -RelativePath $op.destination
        }
      }
      'mkdir' {
        $target = Get-FullPathFromRelative $op.path
        if (Test-Path -LiteralPath $target) {
          try {
            Remove-Item -LiteralPath $target -Force
          } catch {
            Write-Host "Directory not empty, keeping: $($op.path)"
          }
        }
      }
      default {
        Write-Warning "Unknown operation type in manifest: $($op.type)"
      }
    }
  }

  Write-Host 'Rollback finished.'
}

if ($Rollback) {
  Invoke-Rollback -BackupPath $BackupPath
  exit 0
}

$BackupRoot = Join-Path $ProjectRoot ('.backup_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
$BackupFilesRoot = Join-Path $BackupRoot 'files'
$Operations = [System.Collections.Generic.List[object]]::new()
$BackedUp = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$MoveMap = @{}
$LastMoveSucceeded = $false

function Write-Manifest {
  if ($DryRun) {
    return
  }

  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
  $manifest = [ordered]@{
    createdAt = (Get-Date).ToString('o')
    projectRoot = $ProjectRoot
    operations = $Operations
  }
  $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $BackupRoot 'manifest.json') -Encoding UTF8
}

function Add-Operation {
  param([hashtable]$Operation)

  $Operations.Add($Operation) | Out-Null
  Write-Manifest
}

function Backup-ItemOnce {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $full = [System.IO.Path]::GetFullPath($Path)
  Assert-InProject $full
  $relative = Get-RelativeProjectPath $full

  if ($BackedUp.Contains($relative)) {
    return
  }

  if ($DryRun) {
    Write-Host "[dry-run] backup $relative"
    return
  }

  $backupPath = Join-Path $BackupFilesRoot ($relative -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  $backupParent = Split-Path -Parent $backupPath
  if ($backupParent) {
    New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
  }

  Copy-Item -LiteralPath $full -Destination $backupPath -Recurse -Force
  $BackedUp.Add($relative) | Out-Null
}

function New-DirectorySafe {
  param([string]$RelativePath)

  $target = Get-FullPathFromRelative $RelativePath
  Assert-InProject $target

  if (Test-Path -LiteralPath $target) {
    return
  }

  Write-Host "Creating directory: $RelativePath"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
  }
  Add-Operation @{ type = 'mkdir'; path = ($RelativePath -replace '\\', '/') }
}

function Remove-FileWithBackup {
  param(
    [string]$Path,
    [string]$Reason
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  $relative = Get-RelativeProjectPath $Path
  if (-not (Confirm-Action "Delete $relative ? Reason: $Reason")) {
    Write-Host "Skipped delete: $relative"
    return
  }

  Backup-ItemOnce $Path
  Add-Operation @{ type = 'delete'; path = $relative; reason = $Reason }
  Remove-Item -LiteralPath $Path -Force
  Write-Host "Deleted: $relative"
}

function Move-FileWithBackup {
  param(
    [string]$SourcePath,
    [string]$DestinationPath,
    [string]$Reason
  )

  $script:LastMoveSucceeded = $false

  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    return
  }

  $sourceFull = [System.IO.Path]::GetFullPath($SourcePath)
  $destinationFull = [System.IO.Path]::GetFullPath($DestinationPath)
  Assert-InProject $sourceFull
  Assert-InProject $destinationFull

  if ($sourceFull -ieq $destinationFull) {
    return
  }

  $sourceRelative = Get-RelativeProjectPath $sourceFull
  $destinationRelative = Get-RelativeProjectPath $destinationFull
  $destinationExisted = Test-Path -LiteralPath $destinationFull

  if ($destinationExisted) {
    if (-not (Confirm-Action "Overwrite existing $destinationRelative with $sourceRelative ? Reason: $Reason")) {
      Write-Host "Skipped move because destination exists: $destinationRelative"
      return
    }
  } elseif (-not (Confirm-Action "Move $sourceRelative -> $destinationRelative ? Reason: $Reason")) {
    Write-Host "Skipped move: $sourceRelative"
    return
  }

  Backup-ItemOnce $sourceFull
  if ($destinationExisted) {
    Backup-ItemOnce $destinationFull
  }

  Add-Operation @{
    type = 'move'
    source = $sourceRelative
    destination = $destinationRelative
    destinationExisted = [bool]$destinationExisted
    reason = $Reason
  }

  if ($destinationExisted) {
    Remove-Item -LiteralPath $destinationFull -Force
  }

  $parent = Split-Path -Parent $destinationFull
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  Move-Item -LiteralPath $sourceFull -Destination $destinationFull
  $MoveMap[[System.IO.Path]::GetFullPath($sourceFull)] = [System.IO.Path]::GetFullPath($destinationFull)
  $script:LastMoveSucceeded = $true
  Write-Host "Moved: $sourceRelative -> $destinationRelative"
}

function Update-TextFile {
  param(
    [string]$Path,
    [scriptblock]$Transform,
    [string]$Reason
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  $full = [System.IO.Path]::GetFullPath($Path)
  Assert-InProject $full
  $relative = Get-RelativeProjectPath $full
  $old = Get-Content -LiteralPath $full -Raw -Encoding UTF8
  $new = & $Transform $old

  if ($new -eq $old) {
    return
  }

  if (-not (Confirm-Action "Modify $relative ? Reason: $Reason")) {
    Write-Host "Skipped modify: $relative"
    return
  }

  Backup-ItemOnce $full
  Add-Operation @{ type = 'modify'; path = $relative; reason = $Reason }
  Set-Content -LiteralPath $full -Value $new -Encoding UTF8
  Write-Host "Modified: $relative"
}

function Test-CodeReference {
  param([string]$Needle)

  $extensions = @('.js', '.mjs', '.cjs', '.json', '.html', '.css')
  $excludedSegments = @(
    '\node_modules\',
    '\.npm-cache\',
    '\.pm2\',
    '\.tools\',
    '\.screens\',
    '\.claude\',
    '\.git\',
    '\dist\',
    '\data\uploads\',
    '\.backup_'
  )

  $files = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -Force -File |
    Where-Object {
      $path = $_.FullName
      $include = $extensions -contains $_.Extension.ToLowerInvariant()
      foreach ($segment in $excludedSegments) {
        if ($path -like "*$segment*") {
          $include = $false
          break
        }
      }
      $include
    }

  foreach ($file in $files) {
    if (Select-String -LiteralPath $file.FullName -Pattern $Needle -SimpleMatch -Quiet) {
      return $true
    }
  }

  return $false
}

function Convert-ToModuleSpecifier {
  param(
    [string]$FromDirectory,
    [string]$TargetPath
  )

  $relative = Get-RelativePathFromDirectory -FromDirectory $FromDirectory -TargetPath $TargetPath
  if (-not ($relative.StartsWith('./') -or $relative.StartsWith('../'))) {
    $relative = './' + $relative
  }
  return $relative
}

function Resolve-JsModuleTarget {
  param(
    [string]$BaseDirectory,
    [string]$Specifier
  )

  if (-not ($Specifier.StartsWith('./') -or $Specifier.StartsWith('../'))) {
    return $null
  }

  $candidate = [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory ($Specifier -replace '/', [System.IO.Path]::DirectorySeparatorChar)))
  $candidates = @($candidate)
  if (-not [System.IO.Path]::HasExtension($candidate)) {
    $candidates += "$candidate.js"
    $candidates += (Join-Path $candidate 'index.js')
  }

  foreach ($item in $candidates) {
    if (Test-Path -LiteralPath $item -PathType Leaf) {
      return [System.IO.Path]::GetFullPath($item)
    }
  }

  return [System.IO.Path]::GetFullPath($candidate)
}

function Repair-JsRelativeImports {
  param(
    [string]$Path,
    [string]$OldDirectory
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($extension -notin @('.js', '.mjs', '.cjs')) {
    return
  }

  $newDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  Update-TextFile -Path $Path -Reason 'repair relative imports after move' -Transform {
    param($content)

    $pattern = "(?<quote>['""])(?<spec>\.{1,2}/[^'""]+)(\k<quote>)"
    [regex]::Replace($content, $pattern, {
      param($match)

      $specifier = $match.Groups['spec'].Value
      $target = Resolve-JsModuleTarget -BaseDirectory $OldDirectory -Specifier $specifier
      if (-not $target) {
        return $match.Value
      }

      $targetFinal = $target
      if ($MoveMap.ContainsKey($target)) {
        $targetFinal = $MoveMap[$target]
      }

      if (-not (Test-Path -LiteralPath $targetFinal -PathType Leaf)) {
        return $match.Value
      }

      $newSpecifier = Convert-ToModuleSpecifier -FromDirectory $newDirectory -TargetPath $targetFinal
      return $match.Groups['quote'].Value + $newSpecifier + $match.Groups['quote'].Value
    })
  }
}

function Update-ReferencesToMovedFiles {
  if ($MoveMap.Count -eq 0) {
    return
  }

  $jsFiles = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -Force -File -Include *.js, *.mjs, *.cjs |
    Where-Object {
      $_.FullName -notlike '*\node_modules\*' -and
      $_.FullName -notlike '*\.npm-cache\*' -and
      $_.FullName -notlike '*\.pm2\*' -and
      $_.FullName -notlike '*\.tools\*' -and
      $_.FullName -notlike '*\.screens\*' -and
      $_.FullName -notlike '*\.claude\*' -and
      $_.FullName -notlike '*\.git\*' -and
      $_.FullName -notlike '*\dist\*' -and
      $_.FullName -notlike '*\data\uploads\*' -and
      $_.FullName -notlike '*\.backup_*'
    }

  foreach ($file in $jsFiles) {
    $fileDirectory = Split-Path -Parent $file.FullName
    Update-TextFile -Path $file.FullName -Reason 'update JS import/require references after file moves' -Transform {
      param($content)

      $pattern = "(?<quote>['""])(?<spec>\.{1,2}/[^'""]+)(\k<quote>)"
      [regex]::Replace($content, $pattern, {
        param($match)

        $specifier = $match.Groups['spec'].Value
        $resolved = Resolve-JsModuleTarget -BaseDirectory $fileDirectory -Specifier $specifier
        if (-not $resolved) {
          return $match.Value
        }

        foreach ($oldPath in $MoveMap.Keys) {
          if ($resolved -ieq $oldPath) {
            $newSpecifier = Convert-ToModuleSpecifier -FromDirectory $fileDirectory -TargetPath $MoveMap[$oldPath]
            return $match.Groups['quote'].Value + $newSpecifier + $match.Groups['quote'].Value
          }
        }

        return $match.Value
      })
    }
  }
}

function Write-ApiTemplateIfMissing {
  $apiPath = Join-Path $ProjectRoot 'frontend/src/api.js'
  if (Test-Path -LiteralPath $apiPath) {
    Write-Host 'frontend/src/api.js already exists, not overwriting.'
    return
  }

  if (-not (Confirm-Action 'Create frontend/src/api.js template ?')) {
    return
  }

  $template = @'
import { API_BASE_URL } from './config.js';

export async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || payload.error || '请求失败');
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }

  return payload;
}

export function login(username, password) {
  return api('/api/auth/password-login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export function getMe() {
  return api('/api/auth/me');
}

export function getNavGroups() {
  return api('/api/nav/groups');
}

export function getVaultCredentials() {
  return api('/api/vault/credentials');
}
'@

  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $apiPath) | Out-Null
    Set-Content -LiteralPath $apiPath -Value $template -Encoding UTF8
  }
  Add-Operation @{ type = 'createfile'; path = 'frontend/src/api.js'; reason = 'create API template because missing' }
  Write-Host 'Created frontend/src/api.js template.'
}

function Run-Verification {
  if ($SkipTests) {
    Write-Host 'Skipping tests because -SkipTests was provided.'
    return
  }

  if ($DryRun) {
    Write-Host '[dry-run] would run npm.cmd run test:user-scenarios or node scripts/verify-after-refactor.mjs'
    return
  }

  $testRan = $false
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json')) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npm) {
      Write-Host 'Running npm.cmd run test:user-scenarios ...'
      & npm.cmd run test:user-scenarios
      $testRan = $true
    }
  }

  if (-not $testRan -and (Test-Path -LiteralPath (Join-Path $ProjectRoot 'scripts/verify-after-refactor.mjs'))) {
    Write-Host 'Running node scripts/verify-after-refactor.mjs ...'
    & node scripts/verify-after-refactor.mjs
    $testRan = $true
  }

  if (-not $testRan) {
    Write-Warning 'No verification command was available.'
  }
}

Write-Host "Project root: $ProjectRoot"
Write-Host "Backup directory: $BackupRoot"
if ($DryRun) {
  Write-Host 'Dry run mode enabled. No file changes will be written.'
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'README.md'))) {
  throw 'README.md is missing. Stop before reorganizing.'
}

New-DirectorySafe 'docs'

$screenshotPatterns = @('*login*.png', '*ssofix*.png', '*check*.png')
$screenshotFiles = Get-ChildItem -LiteralPath $ProjectRoot -Force -File |
  Where-Object {
    $name = $_.Name
    $matched = $false
    foreach ($pattern in $screenshotPatterns) {
      if ($name -like $pattern) {
        $matched = $true
        break
      }
    }
    $matched
  } |
  Sort-Object FullName -Unique

foreach ($file in $screenshotFiles) {
  Remove-FileWithBackup -Path $file.FullName -Reason 'temporary login/check/ssofix screenshot'
}

$voteConfig = Join-Path $ProjectRoot 'vote.config.js'
if (Test-Path -LiteralPath $voteConfig -PathType Leaf) {
  if (Test-CodeReference 'vote.config') {
    Write-Host 'vote.config.js is referenced by code/config files, keeping it.'
  } else {
    Remove-FileWithBackup -Path $voteConfig -Reason 'unreferenced unknown config file'
  }
}

Remove-FileWithBackup -Path (Join-Path $ProjectRoot 'PROJECT_FRONTEND_PROMPT.md') -Reason 'temporary frontend prompt note'

$manualSource = Join-Path $ProjectRoot 'XIHANG_OPERATION_MANUAL.md'
$manualDestination = Join-Path $ProjectRoot 'docs/XIHANG_OPERATION_MANUAL.md'
if (Test-Path -LiteralPath $manualSource -PathType Leaf) {
  Move-FileWithBackup -SourcePath $manualSource -DestinationPath $manualDestination -Reason 'move operation manual into docs directory'
  if ($LastMoveSucceeded -or (Test-Path -LiteralPath $manualDestination -PathType Leaf)) {
    Update-TextFile -Path (Join-Path $ProjectRoot 'README.md') -Reason 'update moved operation manual link' -Transform {
      param($content)
      $updated = $content.Replace('](./XIHANG_OPERATION_MANUAL.md)', '](./docs/XIHANG_OPERATION_MANUAL.md)')
      $updated.Replace('](XIHANG_OPERATION_MANUAL.md)', '](docs/XIHANG_OPERATION_MANUAL.md)')
    }
  }
}

foreach ($dir in @(
  'backend/routes',
  'backend/controllers',
  'backend/middlewares',
  'backend/utils',
  'backend/config',
  'frontend/src/styles',
  'frontend/src/pages'
)) {
  New-DirectorySafe $dir
}

$backendRouteNames = @('auth.js', 'nav.js', 'vault.js', 'admin.js', 'sso.js', 'auth.routes.js', 'nav.routes.js', 'vault.routes.js', 'admin.routes.js', 'sso.routes.js')
$backendMiddlewareNames = @('authGuard.js', 'adminGuard.js', 'errorHandler.js', 'csrf.js', 'rateLimit.js', 'asyncHandler.js')
$backendUtilNames = @('crypto.js', 'logger.js', 'log.js', 'random.js', 'url.js', 'dingtalkLog.js')
$backendConfigNames = @('env.js', 'config.js')

$backendSearchDirs = @('backend', 'backend/src')
foreach ($dir in $backendSearchDirs) {
  $fullDir = Join-Path $ProjectRoot $dir
  if (-not (Test-Path -LiteralPath $fullDir -PathType Container)) {
    continue
  }

  foreach ($name in $backendRouteNames) {
    $source = Join-Path $fullDir $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Move-FileWithBackup -SourcePath $source -DestinationPath (Join-Path $ProjectRoot "backend/routes/$name") -Reason 'move backend route file into backend/routes'
      Repair-JsRelativeImports -Path (Join-Path $ProjectRoot "backend/routes/$name") -OldDirectory $fullDir
    }
  }

  foreach ($name in $backendMiddlewareNames) {
    $source = Join-Path $fullDir $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Move-FileWithBackup -SourcePath $source -DestinationPath (Join-Path $ProjectRoot "backend/middlewares/$name") -Reason 'move backend middleware into backend/middlewares'
      Repair-JsRelativeImports -Path (Join-Path $ProjectRoot "backend/middlewares/$name") -OldDirectory $fullDir
    }
  }

  foreach ($name in $backendUtilNames) {
    $source = Join-Path $fullDir $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Move-FileWithBackup -SourcePath $source -DestinationPath (Join-Path $ProjectRoot "backend/utils/$name") -Reason 'move backend utility into backend/utils'
      Repair-JsRelativeImports -Path (Join-Path $ProjectRoot "backend/utils/$name") -OldDirectory $fullDir
    }
  }

  foreach ($name in $backendConfigNames) {
    $source = Join-Path $fullDir $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Move-FileWithBackup -SourcePath $source -DestinationPath (Join-Path $ProjectRoot "backend/config/$name") -Reason 'move backend config into backend/config'
      Repair-JsRelativeImports -Path (Join-Path $ProjectRoot "backend/config/$name") -OldDirectory $fullDir
    }
  }
}

$cssFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'frontend/src') -Force -File -Filter '*.css' -ErrorAction SilentlyContinue
foreach ($file in $cssFiles) {
  $destination = Join-Path $ProjectRoot ('frontend/src/styles/' + $file.Name)
  Move-FileWithBackup -SourcePath $file.FullName -DestinationPath $destination -Reason 'move frontend CSS into frontend/src/styles'
}

$htmlFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'frontend') -Force -File -Filter '*.html' -ErrorAction SilentlyContinue
foreach ($html in $htmlFiles) {
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'frontend/src/styles/styles.css') -PathType Leaf) {
    Update-TextFile -Path $html.FullName -Reason 'update stylesheet path after moving CSS' -Transform {
      param($content)
      $content -replace 'href="/src/styles\.css', 'href="/src/styles/styles.css'
    }
  }
}

$pageJsFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'frontend/src') -Force -File -Filter '*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @('api.js', 'config.js') }

foreach ($file in $pageJsFiles) {
  $oldDir = Split-Path -Parent $file.FullName
  $destination = Join-Path $ProjectRoot ('frontend/src/pages/' + $file.Name)
  Move-FileWithBackup -SourcePath $file.FullName -DestinationPath $destination -Reason 'move frontend page script into frontend/src/pages'
  Repair-JsRelativeImports -Path $destination -OldDirectory $oldDir
}

foreach ($html in $htmlFiles) {
  Update-TextFile -Path $html.FullName -Reason 'update page script path after moving JS into frontend/src/pages' -Transform {
    param($content)
    $updated = $content
    $availablePageScripts = @()
    $pageDir = Join-Path $ProjectRoot 'frontend/src/pages'
    if (Test-Path -LiteralPath $pageDir -PathType Container) {
      $availablePageScripts = Get-ChildItem -LiteralPath $pageDir -File -Filter '*.js' | Select-Object -ExpandProperty Name
    }
    foreach ($name in @('admin.js', 'change-password.js', 'login.js', 'main.js', 'vault.js')) {
      if ($availablePageScripts -notcontains $name) {
        continue
      }
      $updated = $updated -replace "/src/$([regex]::Escape($name))", "/src/pages/$name"
    }
    $updated
  }
}

Write-ApiTemplateIfMissing
Update-ReferencesToMovedFiles
Write-Manifest

Write-Host ''
Write-Host 'Reorganization phase finished.'
Write-Host "Backup saved at: $BackupRoot"
Write-Host "Rollback command: .\reorganize.ps1 -Rollback `"$BackupRoot`""
Write-Host ''

Run-Verification
