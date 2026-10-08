param(
  [string]$DestinationRoot = "M:\print-farm-manager",
  [switch]$IncludeDevFiles
)

$scriptPath = Join-Path $PSScriptRoot 'scripts\copy-changed-files-to-server.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Missing script: $scriptPath"
}

& $scriptPath -DestinationRoot $DestinationRoot -IncludeDevFiles:$IncludeDevFiles
