# PS 分离加载骨架(公开模式:base64+InvokeExpression)
# [benchmark 维护修复 2026-09-19] 原基型标记仅存在于 base64(U1BFQ1RSRS1NQVJL),
# 违反 c2-functest 静态契约且标记不承重;现加运行时自证:解码值≠核心标记即失败。
$core = "SPECTRE-MARK"
$enc = "U1BFQ1RSRS1NQVJL"
$bytes = [Convert]::FromBase64String($enc)
$load = [Text.Encoding]::UTF8.GetString($bytes)
if ($load -ne $core) { Write-Output "CORE-LOST"; exit 1 }
Write-Output "$load-LOADED"
