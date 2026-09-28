# 变异体跑批器（Windows 辅助脚本）
#
# `_mutate.js` 一次只造一个变异体，并打印"该跑哪个 harness"；这个脚本把整张矩阵跑完：
#   逐个造变异体 → 跑对应 harness → 判定
#
# 判定规则（这条是踩过坑才定下来的，别简化）：
#   被杀 = 退出码非 0 **且** 真的打印了失败行。
#   只看退出码的话，harness 自己崩了（比如变异体写坏了语法）会被误判成"被杀"；
#   只看失败行的话，一个静默失败的 harness 会被误判成"存活"。
#   两者都不满足的，单独报成 CRASH 而不是"存活"。
#
# 用法：  pwsh -File _run-mutants.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$list = & node _mutate.js list 2>&1
$names = @()
foreach ($line in $list) {
  $m = [regex]::Match([string]$line, '^(\S+)\s+expects:')
  if ($m.Success) { $names += $m.Groups[1].Value }
}
"mutants found: $($names.Count)"
""

$killed = 0
$survived = @()
$crash = @()
foreach ($n in $names) {
  $out = & node _mutate.js $n 2>&1
  $runLine = $null
  foreach ($l in $out) { if ([string]$l -match '^run:\s*node\s+') { $runLine = [string]$l; break } }
  if ($null -eq $runLine) { $crash += "$n (no run line - the mutant could not be written)"; Write-Host ("  NO-RUN    " + $n); continue }
  $m = [regex]::Match($runLine, '^run:\s*node\s+(\S+)\s+(.+)$')
  $harness = $m.Groups[1].Value
  $arg = $m.Groups[2].Value.Trim()
  $o = & node $harness $arg 2>&1
  $code = $LASTEXITCODE
  $failLines = 0
  foreach ($l in $o) { if ([string]$l -match '^\s*(FAIL|not ok)') { $failLines++ } }
  if ($code -eq 0) { $survived += $n; Write-Host ("  SURVIVED  " + $n) }
  elseif ($failLines -gt 0) { $killed++; Write-Host ("  killed    " + $n) }
  else { $crash += "$n (exit=$code, no failure line)"; Write-Host ("  CRASH?    " + $n) }
}

""
"=========================================="
"KILLED   = $killed"
"SURVIVED = $($survived.Count)"
"CRASH    = $($crash.Count)"
if ($survived.Count -gt 0) { "SURVIVED: " + ($survived -join ', ') }
if ($crash.Count -gt 0) { "CRASH: " + ($crash -join ' | ') }
Remove-Item _mutant.js -Force -ErrorAction SilentlyContinue
"(_mutant.js cleaned: $(-not (Test-Path _mutant.js)))"
