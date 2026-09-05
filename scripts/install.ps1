#requires -Version 5.1
# Install the current stable Murmur build on Windows.
# Safe to pipe: irm https://github.com/<repo>/releases/latest/download/install.ps1 | iex
[CmdletBinding()]
param(
    [switch]$Portable,
    [switch]$Android,
    [switch]$PrintUrl,
    [string]$InstallDir = $env:MURMUR_INSTALL_DIR,
    [string]$Repo = $(if ($env:MURMUR_REPO) { $env:MURMUR_REPO } else { 'BenItBuhner/voxflow' })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$base = if ($env:MURMUR_DOWNLOAD_BASE) {
    $env:MURMUR_DOWNLOAD_BASE.TrimEnd('/')
} else {
    "https://github.com/$Repo/releases/latest/download"
}

if ($Android) {
    $asset = 'Murmur-android.apk'
} elseif ($Portable) {
    $asset = 'Murmur-portable.exe'
} else {
    $asset = 'Murmur-setup.exe'
}

$url = "$base/$asset"
if ($PrintUrl) {
    Write-Output $url
    return
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("murmur-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
$download = Join-Path $tempDir $asset

try {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing

    $sumsUrl = "$base/SHA256SUMS.txt"
    $sumsFile = Join-Path $tempDir 'SHA256SUMS.txt'
    try {
        Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsFile -UseBasicParsing
        $line = Get-Content -LiteralPath $sumsFile | Where-Object { $_ -match "  $([regex]::Escape($asset))$" } | Select-Object -First 1
        if ($line) {
            $expected = ($line -split '\s+')[0].ToLowerInvariant()
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
            if ($expected -ne $actual) {
                throw "SHA-256 mismatch for $asset (expected $expected, got $actual)"
            }
            Write-Host "Checksum OK"
        } else {
            Write-Warning "SHA256SUMS.txt has no entry for $asset"
        }
    } catch {
        Write-Warning "Could not verify SHA-256: $($_.Exception.Message)"
    }

    if ($Android) {
        $dest = if ($InstallDir) {
            Join-Path $InstallDir $asset
        } else {
            Join-Path ([Environment]::GetFolderPath('UserProfile')) "Downloads\$asset"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $download -Destination $dest -Force
        Write-Host "Saved APK to $dest"
        Write-Host 'Copy it to the device (or adb install) and finish the in-app setup.'
        return
    }

    if ($Portable) {
        $dest = if ($InstallDir) {
            Join-Path $InstallDir $asset
        } else {
            Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Murmur\$asset"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $download -Destination $dest -Force
        Write-Host "Saved portable build to $dest"
        return
    }

    $dest = if ($InstallDir) { Join-Path $InstallDir $asset } else { $download }
    if ($dest -ne $download) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $download -Destination $dest -Force
    }
    Write-Host "Launching $dest"
    Start-Process -FilePath $dest
} finally {
    if (-not $Portable -and -not $Android -and -not $InstallDir) {
        # Leave the installer in TEMP so Start-Process can finish reading it.
    } elseif (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
