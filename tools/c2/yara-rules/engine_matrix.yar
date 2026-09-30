/* 模拟引擎矩阵(20 特征,benchmark 用;覆盖公开工具特征词面) */
rule ENG01_Behinder_DefaultKey {
  strings: $a = "e45e329feb5d925b" condition: $a
}
rule ENG02_Rebeyond_Pass {
  strings: $a = "rebeyond" condition: $a
}
rule ENG03_Godzilla_Markers {
  strings: $a = "pass" $b = "key" $c = "md5" condition: all of them
}
rule ENG04_AES_Cipher_Import {
  strings: $a = "javax.crypto.Cipher" condition: $a
}
rule ENG05_Runtime_Reflect {
  strings: $a = "java.lang.Runtime" condition: $a
}
rule ENG06_Base64_Decode_Java {
  strings: $a = "decodeBuffer" condition: $a
}
rule ENG07_Listener_Memshell_Shape {
  strings: $a = "ServletRequestListener" condition: $a
}
rule ENG08_Filter_Memshell_Shape {
  strings: $a = "doFilter" $b = "xc" condition: all of them
}
rule ENG09_Servlet_DoPost_Shape {
  strings: $a = "HttpServlet" $b = "doPost" condition: all of them
}
rule ENG10_HandlerInterceptor_Shape {
  strings: $a = "HandlerInterceptor" condition: $a
}
rule ENG11_PHP_Assert_Backdoor {
  strings: $a = "assert(" $b = "$_REQUEST" condition: all of them
}
rule ENG12_PHP_Callback_Shutdown {
  strings: $a = "register_shutdown_function" condition: $a
}
rule ENG13_PHP_Openssl_Crypt {
  strings: $a = "openssl_decrypt" $b = "$_POST" condition: all of them
}
rule ENG14_PS_Invocation {
  strings: $a = "FromBase64String" $b = "UTF8.GetString" condition: all of them
}
rule ENG15_JS_ADODBStream {
  strings: $a = "ADODB.Stream" condition: $a
}
rule ENG16_RequestMapping_Dynamic {
  strings: $a = "RequestMapping" condition: $a
}
rule ENG17_SunMisc_Base64 {
  strings: $a = "sun.misc.BASE64Decoder" condition: $a
}
rule ENG18_GetWriter_Echo {
  strings: $a = "getWriter().write" condition: $a
}
rule ENG19_ActiveX_Create {
  strings: $a = "new ActiveXObject" condition: $a
}
rule ENG20_FilterChain_Shape {
  strings: $a = "FilterChain" condition: $a
}
