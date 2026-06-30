param(
  [Parameter(Position = 0)]
  [ValidateSet("dev", "build")]
  [string] $Command = "dev"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $CargoBin) {
  $env:PATH = "$CargoBin;$env:PATH"
}

function Find-VcVars64 {
  $candidates = @()
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

  if (Test-Path $vswhere) {
    $installations = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    foreach ($installation in $installations) {
      if ($installation) {
        $candidates += Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat"
      }
    }

    if ($candidates.Count -eq 0) {
      $installations = & $vswhere -latest -products * -property installationPath
      foreach ($installation in $installations) {
        if ($installation) {
          $candidates += Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat"
        }
      }
    }
  }

  $searchRoots = @(
    "C:\Program Files\Microsoft Visual Studio",
    "C:\Program Files (x86)\Microsoft Visual Studio"
  )

  foreach ($root in $searchRoots) {
    if (Test-Path $root) {
      $candidates += Get-ChildItem -Path $root -Filter "vcvars64.bat" -Recurse -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    }
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Visual Studio x64 C++ build environment was not found. Install Visual Studio Build Tools with the C++ build tools workload."
}

function Import-VsEnvironment([string] $VcVars64) {
  $environment = & cmd.exe /d /s /c "call `"$VcVars64`" >nul && set"
  foreach ($line in $environment) {
    if ($line -match "^([^=]+)=(.*)$") {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
    }
  }
}

$Rustup = Join-Path $CargoBin "rustup.exe"
if (-not (Test-Path $Rustup)) {
  throw "rustup.exe was not found at $Rustup. Install Rust with rustup first."
}

$toolchains = & $Rustup toolchain list
if (-not ($toolchains -match "stable-x86_64-pc-windows-msvc")) {
  throw "Rust MSVC toolchain is missing. Run: rustup toolchain install stable-x86_64-pc-windows-msvc"
}

$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
$vcvars64 = Find-VcVars64
Import-VsEnvironment $vcvars64

$link = (& where.exe link 2>$null | Select-Object -First 1)
if (-not $link -or $link -notmatch "Microsoft Visual Studio") {
  throw "MSVC link.exe is not first in PATH. Current first link.exe: $link"
}

$tauri = Join-Path $ProjectRoot "node_modules\.bin\tauri.cmd"
if (-not (Test-Path $tauri)) {
  throw "Tauri CLI was not found at $tauri. Run npm install first."
}

Push-Location $ProjectRoot
try {
  & $tauri $Command
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
