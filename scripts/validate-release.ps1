[CmdletBinding()]
param(
    [switch]$SkipProfile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectRoot 'package.json'
$assetsPath = Join-Path $projectRoot 'ASSETS.md'
$readmePath = Join-Path $projectRoot 'README.md'
$checklistPath = Join-Path $projectRoot 'docs/operations/release-checklist.md'
$performanceDocPath = Join-Path $projectRoot 'docs/operations/performance.md'
$screenshotServicePath = Join-Path $projectRoot 'src/main/services/screenshotService.ts'
$fullFlowTestPath = Join-Path $projectRoot 'tests/electron/fullFlow.test.ts'
$evidenceModulePath = Join-Path $projectRoot 'scripts/validate-release-evidence.mjs'
$installedSmokePath = Join-Path $projectRoot 'scripts/smoke-installed.ps1'
$outputDirectory = Join-Path $projectRoot 'out'

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Contains {
    param(
        [string]$Text,
        [string]$Needle,
        [string]$Message
    )

    Assert-True ($Text.Contains($Needle)) $Message
}

function Invoke-Checked {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    & $Command @Arguments
    Assert-True ($LASTEXITCODE -eq 0) "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
}

if ($SkipProfile) {
    throw 'Release validation requires fresh performance evidence. -SkipProfile is not permitted.'
}

$requiredFiles = @(
    $packagePath,
    $assetsPath,
    $readmePath,
    $checklistPath,
    $performanceDocPath,
    (Join-Path $projectRoot 'scripts/profile-performance.mjs'),
    (Join-Path $projectRoot 'scripts/provision-live2d-assets.mjs'),
    $evidenceModulePath,
    $installedSmokePath,
    $screenshotServicePath,
    $fullFlowTestPath
)
foreach ($file in $requiredFiles) {
    Assert-True (Test-Path -LiteralPath $file -PathType Leaf) "Required release file is missing: $file"
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
Assert-Contains $package.scripts.'validate:release' 'validate-release.ps1' 'validate:release script is not wired to validate-release.ps1'
Assert-Contains $package.scripts.'profile:performance' 'profile-performance.mjs' 'profile:performance script is not wired to profile-performance.mjs'
Assert-Contains $package.scripts.'build:windows' 'electron-builder --win' 'build:windows does not invoke electron-builder for Windows'
Assert-Contains $package.scripts.'smoke:installed' 'smoke-installed.ps1' 'smoke:installed is not wired to smoke-installed.ps1'
$nsisTargets = @($package.build.win.target | Where-Object { $_.target -eq 'nsis' })
Assert-True ($nsisTargets.Count -eq 1) 'Windows build must target exactly one NSIS installer'

$assets = Get-Content -LiteralPath $assetsPath -Raw
$readme = Get-Content -LiteralPath $readmePath -Raw
$checklist = Get-Content -LiteralPath $checklistPath -Raw
Assert-Contains $assets 'personal-only' 'ASSETS.md must record the personal-only restriction'
Assert-Contains $readme 'npm run validate:release' 'README.md must document release validation'
Assert-Contains $readme 'npm run build:windows' 'README.md must document Windows packaging'
foreach ($needle in @(
    'Model and License Verification',
    'Dependency and License Review',
    'No API keys or secrets',
    'No screenshots or image buffers persist'
)) {
    Assert-Contains $checklist $needle "Release checklist is missing: $needle"
}

Push-Location $projectRoot
try {
    Invoke-Checked 'node' @('scripts/provision-live2d-assets.mjs', '--verify')
    Invoke-Checked 'npm' @('run', 'profile:performance')

    $profilePath = Join-Path $outputDirectory 'performance-profile.json'
    $queryPath = Join-Path $outputDirectory 'npm-query.json'
    $reviewPath = Join-Path $outputDirectory 'dependency-license-review.json'
    Assert-True (Test-Path -LiteralPath $profilePath -PathType Leaf) 'Performance profile report is missing'
    npm query '*' | Set-Content -LiteralPath $queryPath -Encoding utf8
    Assert-True ($LASTEXITCODE -eq 0) 'npm query * failed'

    Invoke-Checked 'node' @(
        'scripts/validate-release-evidence.mjs',
        '--root', $projectRoot,
        '--query', $queryPath,
        '--review', $reviewPath,
        '--checklist', $checklistPath,
        '--package', $packagePath,
        '--profile', $profilePath
    )

    $screenshotSource = Get-Content -LiteralPath $screenshotServicePath -Raw
    $fullFlowTest = Get-Content -LiteralPath $fullFlowTestPath -Raw
    Assert-True ($screenshotSource -notmatch 'writeFile|createWriteStream') 'Screenshot service must not persist image bytes to disk'
    Assert-Contains $fullFlowTest 'persistedScreenshotFiles' 'Full-flow test must check for persisted screenshots'
    Assert-Contains $fullFlowTest 'leakedProcessIds' 'Full-flow test must check for leaked child processes'

    $installer = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'dist') -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $installer) {
        Invoke-Checked 'npm' @('run', 'build:windows')
        $installer = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'dist') -Filter '*-setup.exe' -File |
            Sort-Object -Property LastWriteTimeUtc -Descending |
            Select-Object -First 1
    }
    Assert-True ($null -ne $installer) 'Windows installer was not produced by build:windows.'
    Invoke-Checked 'npm' @('run', 'smoke:installed')

    $installedEvidencePath = Join-Path $outputDirectory 'installed-smoke-evidence.json'
    Assert-True (Test-Path -LiteralPath $installedEvidencePath -PathType Leaf) 'Installed smoke evidence is missing.'
    $installedEvidence = Get-Content -LiteralPath $installedEvidencePath -Raw | ConvertFrom-Json
    Assert-True ($installedEvidence.success -eq $true) 'Installed application smoke did not pass.'
    Assert-True ($installedEvidence.sandboxDisabled -eq $false) 'Installed application smoke did not use the normal sandbox.'
    Assert-True ($installedEvidence.shutdownAck -eq $true) 'Installed application shutdown acknowledgement is missing.'
    Assert-True ($installedEvidence.exitCode -eq 0) 'Installed application smoke exited unsuccessfully.'
    Assert-True ($installedEvidence.installerSizeBytes -eq $installer.Length) 'Installed smoke evidence has the wrong installer size.'
}
finally {
    Pop-Location
}

Write-Host 'Release validation passed.'
Write-Host "Dependency review: $reviewPath"
Write-Host "Performance profile: $profilePath"
Write-Host "Installer: $($installer.FullName) ($($installer.Length) bytes)"
Write-Host "Installed smoke evidence: $installedEvidencePath"
