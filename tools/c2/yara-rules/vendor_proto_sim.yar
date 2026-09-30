/* 厂商拟态规则集(四令·协议选新令验证):模拟厂商对经典协议(Godzilla/冰蝎/Suo5)
   的公开特征规则。用途:证明自研 AOQ/1.0 天然不命中经典协议特征面。
   阳性对照:qa/ctrl/*.sample 必须命中;阴性:AOQ 载荷与流量样本不得命中。 */
rule VSIM01_Godzilla_Form_Params {
  strings: $a = "pass=" $b = "&key=" $c = "md5(md5" condition: 2 of them
}
rule VSIM02_Godzilla_Traffic_Face {
  strings: $a = "application/x-www-form-urlencoded" $b = "PHPSESSID" $c = "test" condition: all of them and filesize > 60
}
rule VSIM03_Behinder_Default_Material {
  strings: $a = "e45e329feb5d925b" $b = "rebeyond" condition: any of them
}
rule VSIM04_Behinder_AES_ECB_Openssl {
  strings: $a = "openssl_encrypt" $b = "AES-128" condition: all of them
}
rule VSIM05_Behinder_Package {
  strings: $a = "net.rebeyond" $b = "behinder" condition: all of them
}
rule VSIM06_Suo5_Tunnel_Markers {
  strings: $a = "suo5" $b = "channel" condition: all of them
}
rule VSIM07_Suo5_OctetStream {
  strings: $a = "Content-Type: application/octet-stream" $b = "X-Suo5" condition: all of them
}
rule VSIM08_Classic_Exec_Param {
  strings: $a = "\"cmd\"" $b = "\"argv\"" condition: all of them
}
rule VSIM09_Behinder2_Raw_AES_Body {
  strings: $a = "AES/ECB/NoPadding" $b = "PKCS5Padding" condition: all of them
}
rule VSIM10_Godzilla_Java_Class {
  strings: $a = "ServletOutputStream" $b = "pageContext" $c = "md5.substring(0,16)" condition: 2 of them
}
