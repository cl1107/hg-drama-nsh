param(
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $NodeExe) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
  $fallbackNode = 'C:\Users\xiaomo\ai\node-v24.22.1-win-x64\node.exe'
  if (Test-Path $fallbackNode) { $NodeExe = $fallbackNode }
}
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
  throw "Node.js 24+ not found. Pass -NodeExe <path-to-node.exe> or add Node 24+ to PATH."
}

$nodeMajor = [int](& $NodeExe -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 24) {
  throw "Node.js 24+ is required (found v$nodeMajor at $NodeExe)."
}

$nodeLicense = Join-Path (Split-Path -Parent $NodeExe) 'LICENSE'
if (-not (Test-Path $nodeLicense)) {
  throw "Node LICENSE file not found next to $NodeExe"
}

$nshExe = Join-Path $root '.tools\nsh\bin\nsh.exe'
if (-not (Test-Path $nshExe)) {
  $nshCmd = Get-Command nsh -ErrorAction SilentlyContinue
  if ($nshCmd) { $nshExe = $nshCmd.Source }
}
if (-not (Test-Path $nshExe)) {
  $fallbackNsh = Join-Path $env:LOCALAPPDATA 'nsh\bin\nsh.exe'
  if (Test-Path $fallbackNsh) { $nshExe = $fallbackNsh }
}
if (-not (Test-Path $nshExe)) {
  throw "nsh.exe not found. Run: irm https://nsh.dev/install.ps1 | iex"
}
$nshLicense = Join-Path (Split-Path -Parent (Split-Path -Parent $nshExe)) 'LICENSE-APACHE'

New-Item -ItemType Directory -Force -Path "$root\.tmp", "$root\.nsh\out" | Out-Null
$stage = Join-Path $root ".tmp\win-package-$(Get-Random)"
$outRoot = Join-Path $root '.nsh\out'
New-Item -ItemType Directory -Force -Path $stage, "$stage\.tmp" | Out-Null

try {
  Copy-Item "$root\App.tsx", "$root\nsh.json" $stage
  Copy-Item -Recurse "$root\src", "$root\assets" $stage
  Set-Content -Encoding ASCII -Path "$stage\.tmp\service-config.ts" -Value 'export const serviceConfig = { baseUrl: "", token: "" };'

  & $NodeExe -e "
    const fs = require('node:fs');
    const file = process.argv[1];
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.capabilities = {
      application: true,
      network: { hosts: ['*'] },
      clipboard: true,
      statusBar: true,
      process: { env: ['HG_NSH_SERVICE_URL', 'HG_NSH_SERVICE_TOKEN'] },
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  " "$stage\nsh.json"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to configure the NSH package' }
  $appName = (Get-Content -Raw -Encoding UTF8 "$stage\nsh.json" | ConvertFrom-Json).name

  $output = Join-Path $outRoot "windows-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  New-Item -ItemType Directory -Force -Path $output | Out-Null

  Push-Location $stage
  try {
    & $nshExe package --target windows --out $output .
    if ($LASTEXITCODE -ne 0) { throw 'NSH packaging failed' }
  } finally {
    Pop-Location
  }

  $appDir = Join-Path $output $appName
  $launcherExe = Join-Path $appDir "$appName.exe"
  $uiExePath = Join-Path $appDir 'nsh-ui.exe'
  Move-Item -LiteralPath $launcherExe -Destination $uiExePath

  # Bundle Node 24 + backend service
  $backend = Join-Path $appDir 'backend'
  New-Item -ItemType Directory -Force -Path "$backend\service\vendor\hongguo", "$backend\src\media", "$backend\src\providers" | Out-Null
  foreach ($f in @('auth', 'danmaku', 'discover', 'downloads', 'keychain', 'keep-awake', 'playback', 'range', 'server', 'transport')) {
    Copy-Item "$root\service\$f.cjs" "$backend\service\"
  }
  Copy-Item "$root\service\vendor\hongguo\*.js", "$root\service\vendor\hongguo\LICENSE", "$root\service\vendor\hongguo\NOTICE", "$root\service\vendor\hongguo\THIRD-PARTY-NOTICES.md" "$backend\service\vendor\hongguo\"
  Copy-Item "$root\src\media\cenc.cjs" "$backend\src\media\"
  Copy-Item "$root\src\providers\catalog.ts" "$backend\src\providers\"
  Copy-Item "$root\LICENSE" "$backend\LICENSE"
  Copy-Item $nodeLicense "$appDir\Node-LICENSE"
  Copy-Item $nshLicense "$appDir\NSH-LICENSE-APACHE"
  Copy-Item $NodeExe "$appDir\node.exe"
  & "$appDir\node.exe" -e 'require(process.argv[1])' "$backend\service\server.cjs"
  if ($LASTEXITCODE -ne 0) { throw 'The packaged playback service could not be loaded' }

  # Compile native GUI launcher exe (no console window, double-click ready)
  $csSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class Program {
    [STAThread]
    static int Main(string[] args) {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string nodeExe = Path.Combine(appDir, "node.exe");
        string serverJs = Path.Combine(appDir, "backend", "service", "server.cjs");
        string uiExe = Path.Combine(appDir, "nsh-ui.exe");

        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string downloadDir = Path.Combine(localAppData, "com.hgdrama.nsh", "downloads");
        string launchDir = Path.Combine(Path.GetTempPath(), "hg-nsh-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(launchDir);
        string launchFile = Path.Combine(launchDir, "connection");

        Process svc = null;
        try {
            var svcInfo = new ProcessStartInfo {
                FileName = nodeExe,
                Arguments = "\"" + serverJs + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            svcInfo.EnvironmentVariables["HG_NSH_DOWNLOAD_DIR"] = downloadDir;
            svcInfo.EnvironmentVariables["HG_NSH_LAUNCH_FILE"] = launchFile;
            svc = Process.Start(svcInfo);

            for (int i = 0; i < 150; i++) {
                if (File.Exists(launchFile)) break;
                if (svc.HasExited) {
                    MessageBox.Show("Local playback service exited unexpectedly.", "HG Drama NSH", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                Thread.Sleep(100);
            }

            if (!File.Exists(launchFile)) {
                MessageBox.Show("Local playback service startup timed out.", "HG Drama NSH", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            string[] parts = File.ReadAllText(launchFile).Trim().Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) {
                MessageBox.Show("Invalid service connection info.", "HG Drama NSH", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            var uiInfo = new ProcessStartInfo {
                FileName = uiExe,
                WorkingDirectory = appDir,
                UseShellExecute = false
            };
            uiInfo.EnvironmentVariables["HG_NSH_SERVICE_URL"] = parts[0];
            uiInfo.EnvironmentVariables["HG_NSH_SERVICE_TOKEN"] = parts[1];
            using (var ui = Process.Start(uiInfo)) {
                ui.WaitForExit();
                return ui.ExitCode;
            }
        } finally {
            try { if (svc != null && !svc.HasExited) svc.Kill(); } catch {}
            try { if (Directory.Exists(launchDir)) Directory.Delete(launchDir, true); } catch {}
        }
    }
}
'@
  Add-Type -TypeDefinition $csSource -Language CSharp -OutputAssembly $launcherExe -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms

  $zipOut = Join-Path $output 'hg-drama-nsh-windows-x64.zip'
  if (Test-Path $zipOut) { Remove-Item -Force $zipOut }
  & tar.exe -a -cf $zipOut -C $appDir .
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the portable ZIP' }

  Write-Host "==> Portable Windows package ready!"
  Write-Host "Dir: $appDir"
  Write-Host "Exe: $launcherExe"
  Write-Host "Zip: $zipOut"
} finally {
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
}
