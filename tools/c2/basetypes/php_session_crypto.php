<?php
// 加密会话型骨架(AES 交互)
$k = "3c6e0b8a9c15224a";
$d = openssl_decrypt($_POST['data'] ?? '', "AES-128-ECB", $k);
if ($d) { echo $d; } else { echo "SPECTRE-MARK-SESSION"; }
?>
