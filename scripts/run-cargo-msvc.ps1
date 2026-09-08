param()
$CargoArgs = $args
if ($CargoArgs.Count -eq 0) {
  throw "Provide Cargo arguments, for example: test --lib"
}
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "msvc-environment.ps1")
if ($CargoArgs[0] -eq "test") {
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ..\scripts\run-test-with-common-controls.ps1"
}
Push-Location (Join-Path $PSScriptRoot "../src-tauri")
try {
  & (Join-Path $CargoBin "cargo.exe") @CargoArgs
  exit $LASTEXITCODE
} finally { Pop-Location }
