rule Memshell_Smoke_Test {
  strings:
    $pass = "rebeyond"
    $cls = "EvilMemshell"
  condition:
    any of them
}
