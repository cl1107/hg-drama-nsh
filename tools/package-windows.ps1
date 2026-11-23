param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$nshExe = if ($env:NSH_CLI) { $env:NSH_CLI } else { Join-Path $root '.tools/nsh/bin/nsh.exe' }
if (-not (Test-Path -LiteralPath $nshExe)) {
  $nshExe = (Get-Command nsh -ErrorAction Stop).Source
}
$nshHome = Split-Path -Parent (Split-Path -Parent $nshExe)
if (-not $env:NSH_RUNTIME) {
  $env:NSH_RUNTIME = Join-Path $nshHome 'runtime'
}

if (-not $OutputDir) {
  $OutputDir = Join-Path $root ".nsh/out/windows-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')"
}
$output = (New-Item -ItemType Directory -Force -Path $OutputDir).FullName
$config = Get-Content -Raw -Encoding UTF8 'nsh.json' | ConvertFrom-Json
$appName = $config.name

& $nshExe package --target windows --out $output .
if ($LASTEXITCODE -ne 0) { throw 'NSH packaging failed' }

$appDir = Join-Path $output $appName
$licenses = Join-Path $appDir 'licenses'
$upstreamLicenses = Join-Path $licenses 'hongguo'
New-Item -ItemType Directory -Force -Path $upstreamLicenses | Out-Null
Copy-Item LICENSE (Join-Path $licenses 'PROJECT-LICENSE')
Copy-Item (Join-Path $nshHome 'LICENSE-APACHE') (Join-Path $licenses 'NSH-LICENSE-APACHE')
foreach ($name in @('LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md')) {
  Copy-Item "service/vendor/hongguo/$name" $upstreamLicenses
}

$zipOut = Join-Path $output 'hg-drama-nsh-windows-x64.zip'
[System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($appDir, $zipOut)
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipOut)
try {
  foreach ($entry in @("$appName.exe", 'nsh/bundle.nshc')) {
    if (-not $archive.GetEntry($entry)) { throw "Missing ZIP entry: $entry" }
  }
  foreach ($entry in $archive.Entries) {
    if ($entry.Name -in @('node.exe', 'Node-LICENSE') -or $entry.FullName.StartsWith('backend/')) {
      throw "Unexpected Node backend in ZIP: $($entry.FullName)"
    }
  }
} finally {
  $archive.Dispose()
}
Write-Host "Portable Windows package: $zipOut"
