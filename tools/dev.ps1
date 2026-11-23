$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$nshExe = if ($env:NSH_CLI) { $env:NSH_CLI } else { Join-Path $root '.tools/nsh/bin/nsh.exe' }
if (-not (Test-Path -LiteralPath $nshExe)) {
  $nshExe = (Get-Command nsh -ErrorAction Stop).Source
}
& $nshExe run --target windows --window-size 1480x820
exit $LASTEXITCODE
