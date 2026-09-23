---
name: file-ops
description: 文件操作——读取·凭据搜索·投递
---

# 文件操作(线二)
读取:shell read_file(绝对路径);大文件 head -c 分段。
凭据搜索(只记录位置+指纹,不外传内容):
`grep -rniE "password|passwd|secret|token|api[_-]?key|jdbc|redis://" 
 /etc /opt/*/*/conf* --include="*.{conf,properties,yml,yaml}" 2>/dev/null | head -50`
投递(写):伪装名+隐蔽路径(/tmp/.fontconfig 型)+事后登记;
内容传输走 base64 分段,禁明文中转。
