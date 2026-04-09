param(
  [switch]$IncludeReports
)

$ErrorActionPreference = 'Stop'

$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $BaseDir 'config.json'

function Remove-ContentsSafely {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $TargetPath)) {
    Write-Host "[skip] $Label 不存在：$TargetPath"
    return
  }

  Get-ChildItem -LiteralPath $TargetPath -Force | Remove-Item -Recurse -Force
  Write-Host "[ok] 已清空 $Label：$TargetPath"
}

$resultsDirName = 'results'
if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.resultsDir) {
      $resultsDirName = [string]$config.resultsDir
    }
  } catch {
    Write-Host "[warn] 读取 config.json 失败，继续使用默认 results 目录：$($_.Exception.Message)"
  }
}

$resultsDir = Join-Path $BaseDir $resultsDirName
$screenshotsDir = Join-Path $BaseDir 'screenshots'
$storageDir = Join-Path $BaseDir 'storage'
$testResultsDir = Join-Path $BaseDir 'test-results'
$playwrightReportDir = Join-Path $BaseDir 'playwright-report'

Write-Host '[info] 开始清理运行产物（不会删除 accounts.txt / proxies.txt / config.json / 源代码）'
Remove-ContentsSafely -TargetPath $resultsDir -Label 'results'
Remove-ContentsSafely -TargetPath $screenshotsDir -Label 'screenshots'
Remove-ContentsSafely -TargetPath $storageDir -Label 'storage'

if ($IncludeReports) {
  Remove-ContentsSafely -TargetPath $testResultsDir -Label 'test-results'
  Remove-ContentsSafely -TargetPath $playwrightReportDir -Label 'playwright-report'
} else {
  Write-Host '[skip] 默认不清理 test-results / playwright-report；如需清理，请使用 -IncludeReports'
}

Write-Host '[done] 清理完成，可以重新开跑。'
