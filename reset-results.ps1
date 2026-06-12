param(
  [switch]$IncludeReports
)

$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Clear-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $resolvedRoot = [System.IO.Path]::GetFullPath($RootDir)
  $resolvedTarget = [System.IO.Path]::GetFullPath($TargetPath)
  if (-not $resolvedTarget.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear path outside workspace: $resolvedTarget"
  }

  if (-not (Test-Path -LiteralPath $resolvedTarget)) {
    Write-Host "[skip] $Label not found: $resolvedTarget"
    return
  }

  Get-ChildItem -LiteralPath $resolvedTarget -Force | Remove-Item -Recurse -Force
  Write-Host "[ok] cleared $Label: $resolvedTarget"
}

Clear-DirectoryContents -TargetPath (Join-Path $RootDir 'Dreamina/0.0.3/results') -Label 'Dreamina results'
Clear-DirectoryContents -TargetPath (Join-Path $RootDir 'Dreamina/0.0.3/batch-results') -Label 'Dreamina batch-results'
Clear-DirectoryContents -TargetPath (Join-Path $RootDir 'Dreamina/0.0.3/session-records') -Label 'Dreamina session-records'
Clear-DirectoryContents -TargetPath (Join-Path $RootDir 'output') -Label 'root output'

if ($IncludeReports) {
  Clear-DirectoryContents -TargetPath (Join-Path $RootDir 'test-results') -Label 'test-results'
  Clear-DirectoryContents -TargetPath (Join-Path $RootDir 'playwright-report') -Label 'playwright-report'
} else {
  Write-Host '[skip] test-results/playwright-report; pass -IncludeReports to clear them'
}

Write-Host '[done] reset complete'
