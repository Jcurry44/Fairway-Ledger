param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$NodePath = "node",
  [string]$EnvFile = "",
  [switch]$PublishOnly,
  [switch]$Offline,
  [switch]$ForceLive
)

$ErrorActionPreference = "Stop"

$logDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$defaultEnvFile = Join-Path (Split-Path $ProjectRoot -Parent) "MLB Betting Framework\.env"
if (-not $EnvFile -and (Test-Path -LiteralPath $defaultEnvFile)) {
  $EnvFile = $defaultEnvFile
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDir "golf-lab-refresh-$stamp.log"
$scriptPath = Join-Path $ProjectRoot "scripts\golf-lab-refresh-public.js"

$arguments = @($scriptPath)
if ($PublishOnly) { $arguments += "--publish-only" }
if ($Offline) { $arguments += "--offline" }
if ($ForceLive) { $arguments += "--force-live" }
if ($EnvFile) {
  $arguments += "--env-file"
  $arguments += $EnvFile
}

Push-Location $ProjectRoot
try {
  $started = Get-Date -Format o
  "[$started] Golf Lab public refresh starting" | Tee-Object -FilePath $logFile
  "ProjectRoot=$ProjectRoot" | Tee-Object -FilePath $logFile -Append
  "NodePath=$NodePath" | Tee-Object -FilePath $logFile -Append

  & $NodePath @arguments 2>&1 | Tee-Object -FilePath $logFile -Append
  $exitCode = if ($LASTEXITCODE -eq $null) { 0 } else { $LASTEXITCODE }

  $finished = Get-Date -Format o
  "[$finished] Golf Lab public refresh finished with exit code $exitCode" | Tee-Object -FilePath $logFile -Append
  exit $exitCode
}
finally {
  Pop-Location
}
