param(
  [Parameter(Position = 0)]
  [ValidateSet("dev", "build", "release")]
  [string] $Command = "dev"
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "msvc-environment.ps1")
$tauri = Join-Path $ProjectRoot "node_modules\.bin\tauri.cmd"
if (-not (Test-Path $tauri)) { throw "Run npm ci first." }
$tauriArgs = @($Command)
if ($Command -eq "build") {
  $tauriArgs = @("build", "--config", "src-tauri/tauri.local.conf.json")
}
if ($Command -eq "release") {
  if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw "Release requires TAURI_SIGNING_PRIVATE_KEY." }
  $tauriArgs = @("build")
}
Push-Location $ProjectRoot
try {
  & $tauri @tauriArgs
  exit $LASTEXITCODE
} finally { Pop-Location }
