$ErrorActionPreference = 'Stop'
cargo xtask build desktop 2>&1 | Tee-Object bundle.log
if ($LASTEXITCODE -ne 0) { throw "bundle build failed" }
$installer = Get-ChildItem target/release/bundle/nsis/*.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "NSIS installer missing" }
$install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "NSIS install failed with exit code $($install.ExitCode)" }
$registryRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$registeredDirs = @(
  foreach ($root in $registryRoots) {
    Get-ChildItem $root -ErrorAction SilentlyContinue |
      Get-ItemProperty |
      Where-Object { $_.DisplayName -eq 'Dezoomify' -and $_.InstallLocation } |
      ForEach-Object { $_.InstallLocation }
  }
)
$locations = @($registeredDirs) + @(
  "$env:LOCALAPPDATA\Dezoomify",
  "$env:LOCALAPPDATA\Programs\Dezoomify",
  "$env:ProgramFiles\Dezoomify"
)
$exe = $locations | Where-Object { Test-Path $_ } | ForEach-Object {
  Get-ChildItem $_ -Recurse -Filter dezoomify-desktop.exe -ErrorAction SilentlyContinue
} | Select-Object -First 1
if (-not $exe) { throw "installed exe missing" }
$app = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 15
if ($app.HasExited) { throw "installed app exited early" }
Stop-Process -Id $app.Id -Force
