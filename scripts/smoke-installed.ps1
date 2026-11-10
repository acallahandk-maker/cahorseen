[CmdletBinding()]
param(
    [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$distDirectory = Join-Path $projectRoot 'dist'
$outputDirectory = Join-Path $projectRoot 'out'
$evidencePath = Join-Path $outputDirectory 'installed-smoke-evidence.json'

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $installer = Get-ChildItem -LiteralPath $distDirectory -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $installer) {
        throw 'No Windows NSIS installer was found in dist.'
    }
    $InstallerPath = $installer.FullName
}
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
Assert-True (Test-Path -LiteralPath $InstallerPath -PathType Leaf) "Installer is missing: $InstallerPath"
$installerItem = Get-Item -LiteralPath $InstallerPath

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) (
    'desktop-pet-installed-smoke-' + [Guid]::NewGuid().ToString('N')
)
$installDirectory = Join-Path $temporaryRoot 'app'
$scratchDirectory = Join-Path $temporaryRoot 'scratch'
$shutdownAckPath = Join-Path $scratchDirectory 'shutdown-ack'
$stdoutLines = [Collections.Generic.List[string]]::new()
$stderr = ''
$exitCode = $null
$marker = $null
$success = $false

New-Item -ItemType Directory -Path $temporaryRoot, $installDirectory, $scratchDirectory -Force | Out-Null
try {
    $installerStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $installerStartInfo.FileName = $InstallerPath
    $installerStartInfo.UseShellExecute = $false
    $installerStartInfo.CreateNoWindow = $true
    $installerStartInfo.Arguments = "/S /D=$installDirectory"
    $installerProcess = [Diagnostics.Process]::Start($installerStartInfo)
    Assert-True ($installerProcess.WaitForExit(120000)) 'NSIS installer timed out.'
    Assert-True ($installerProcess.ExitCode -eq 0) "NSIS installer exited with code $($installerProcess.ExitCode)."

    $executablePath = Join-Path $installDirectory 'Desktop Pet Translator.exe'
    Assert-True (Test-Path -LiteralPath $executablePath -PathType Leaf) "Installed executable is missing: $executablePath"

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $executablePath
    $startInfo.WorkingDirectory = $installDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment['DESKTOP_PET_SMOKE_SCENARIO'] = 'live2d-fallback'
    $startInfo.Environment['DESKTOP_PET_SMOKE_SHUTDOWN_ACK'] = '1'
    $startInfo.Environment['DESKTOP_PET_TEST_SCRATCH_DIR'] = $scratchDirectory

    $process = [Diagnostics.Process]::Start($startInfo)
    $stderrTask = $process.StandardError.ReadToEndAsync()
    while ($null -ne ($line = $process.StandardOutput.ReadLine())) {
        $stdoutLines.Add($line)
        if ($line -eq 'DESKTOP_PET_SMOKE_COMPLETE') {
            Set-Content -LiteralPath $shutdownAckPath -Value '' -Encoding utf8
        }
    }
    Assert-True ($process.WaitForExit(120000)) 'Installed application smoke timed out.'
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode

    $markerIndex = $stdoutLines.IndexOf('DESKTOP_PET_SMOKE_COMPLETE')
    Assert-True ($markerIndex -ge 0) 'Installed application did not emit the smoke completion marker.'
    Assert-True (($markerIndex + 1) -lt $stdoutLines.Count) 'Installed application did not emit a JSON smoke marker.'
    try {
        $marker = $stdoutLines[$markerIndex + 1] | ConvertFrom-Json
    } catch {
        throw 'Installed application emitted an invalid JSON smoke marker.'
    }
    Assert-True ($exitCode -eq 0) "Installed application exited with code $exitCode."
    Assert-True (Test-Path -LiteralPath $shutdownAckPath -PathType Leaf) 'Shutdown acknowledgement was not observed.'
    Assert-True ($marker.sandboxDisabled -eq $false) 'Installed application launched with the Chromium sandbox disabled.'
    Assert-True ($marker.windowCount -ge 1) 'Installed application smoke did not retain its renderer window.'
    Assert-True ([string]::IsNullOrWhiteSpace([string]$marker.url) -eq $false) 'Installed application smoke marker has no renderer URL.'
    $success = $true
}
finally {
    $evidence = [ordered]@{
        schemaVersion = 1
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        installerPath = $InstallerPath
        installerSizeBytes = $installerItem.Length
        installedExecutable = Join-Path $installDirectory 'Desktop Pet Translator.exe'
        sandboxDisabled = if ($null -eq $marker) { $null } else { [bool]$marker.sandboxDisabled }
        shutdownAck = Test-Path -LiteralPath $shutdownAckPath -PathType Leaf
        exitCode = $exitCode
        success = $success
        marker = $marker
        stderr = $stderr
    }
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding utf8

    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $resolvedInstallDirectory = [IO.Path]::GetFullPath($installDirectory)
    Assert-True (
        $resolvedInstallDirectory.StartsWith(
            $resolvedTemporaryRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) 'Refusing to remove an install directory outside the temporary smoke root.'
    $temporaryBase = [IO.Path]::GetFullPath(
        [IO.Path]::GetTempPath()
    ).TrimEnd([IO.Path]::DirectorySeparatorChar)
    Assert-True (
        $resolvedTemporaryRoot.StartsWith(
            $temporaryBase + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) 'Refusing to remove a temporary smoke root outside the system temporary directory.'
    $cleanupError = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
            $cleanupError = $null
            break
        } catch {
            $cleanupError = $_
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -ne $cleanupError) {
        throw "Temporary installed smoke cleanup failed: $($cleanupError.Exception.Message)"
    }
}

Write-Host 'Installed application sandbox smoke passed.'
Write-Host "Installer: $InstallerPath"
Write-Host "Installer size: $($installerItem.Length) bytes"
Write-Host "Evidence: $evidencePath"
