$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

New-Item -ItemType Directory -Force -Path "$root\.tmp" | Out-Null
if (-not (Test-Path "$root\.tmp\service-config.ts")) {
  Set-Content -Encoding ASCII -Path "$root\.tmp\service-config.ts" -Value 'export const serviceConfig = { baseUrl: "", token: "" };'
}
if (-not (Test-Path "$root\.tmp\prepared-playback.ts")) {
  Set-Content -Encoding ASCII -Path "$root\.tmp\prepared-playback.ts" -Value 'export const preparedPlayback = { title: "not prepared", mediaUrl: "" };'
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Users\xiaomo\ai\node-v24.22.1-win-x64\node.exe' }
if (-not (Test-Path $nodeExe)) {
  throw "Node.js 24+ not found. Install Node 24+ and add it to PATH."
}

$nshExe = Join-Path $root '.tools\nsh\bin\nsh.exe'
if (-not (Test-Path $nshExe)) {
  $nshCmd = Get-Command nsh -ErrorAction SilentlyContinue
  if ($nshCmd) { $nshExe = $nshCmd.Source }
}
if (-not (Test-Path $nshExe)) {
  $fallback = Join-Path $env:LOCALAPPDATA 'nsh\bin\nsh.exe'
  if (Test-Path $fallback) { $nshExe = $fallback }
}
if (-not (Test-Path $nshExe)) {
  throw "nsh.exe not found. Run: irm https://nsh.dev/install.ps1 | iex"
}

$readyFile = Join-Path $root '.tmp\service-ready'
if (Test-Path $readyFile) { Remove-Item -Force $readyFile }

$svc = Start-Process -FilePath $nodeExe -ArgumentList 'service/server.cjs' -WorkingDirectory $root -PassThru -NoNewWindow
try {
  $ready = $false
  for ($i = 0; $i -lt 50; $i++) {
    if ($svc.HasExited) {
      throw "Backend service exited unexpectedly with code $($svc.ExitCode)"
    }
    if ((Test-Path $readyFile) -and ((Get-Content -Raw $readyFile).Trim() -eq "$($svc.Id)")) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) {
    throw "Backend service startup timed out"
  }

  & $nshExe run --target windows --name '红果短剧-NSH' --window-size 1480x820
} finally {
  if ($svc -and -not $svc.HasExited) {
    Stop-Process -Id $svc.Id -Force -ErrorAction SilentlyContinue
  }
}
