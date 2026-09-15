---
name: web-login-brute
description: 需要对 Web 登录面做弱口令爆破(含传输算法逆向:哈希/AES/DES/自定义混淆,验证码处理,防锁定)时使用
---

# Web 登录爆破

## 1. 协议逆向(先于一切尝试)
1. 抓登录页与 JS:定位提交函数与密码处理
2. 常见传输形态识别:
   - 明文 / base64(一眼)
   - MD5/SHA1/SHA256(pw) 或 MD5(pw+salt)——32/40/64 hex 特征,JS 里找 hex 函数
   - AES/DES:JS 里 CryptoJS.enc.Utf8.parse 的 key/iv(常硬编码);RSA:公钥模数
   - 自定义混淆(如强智 scode#sxh 掺盐):JS 逐行还原成 python
3. python 复刻:/opt/tools/py 的 pycryptodome;hashlib/hmac 标准库
4. 会话绑定:部分系统(强智)绑定 TCP 连接——requests Session 单连接 keep-alive,
   勿用多连接复刻(实测 http.client 双连失败 requests 成功)

## 2. 验证码策略(阶梯)
无验证码 > 纯前端校验(直接绕)> 答案可读接口(如 pay session.jsp)>
tesseract OCR(已装 /opt/tools/py,44x18 小图先二值化)> 声明边界放弃

## 3. 防锁定与预言机
- 先单账号错 3-5 次观察锁定/验证码升级;锁定阈值内行动
- 成功预言机:302 Location / 响应长度差 / set-cookie 变化 / 报文文案
- admin/系统账号默认口令 > 用户名模式(学号/工号+123456 等) > weakpass 52 表

## 4. JWT 认证面
```bash
PYTHONPATH=/opt/tools/py python3 /opt/tools/jwt_tool/jwt_tool.py <token> -C -d \
  /opt/tools/wordlists/rockyou.txt  # weak secret 爆破
```


## 5. 上下文语义种子规则法(中强密码的主战法)
纯字典顺序扫对"字典外中强密码"零命中。方法论:
1. **种子采集(每面必做)**:从登录页上下文提语义种子——产品名/系统名(title、footer、
   PowerBy)/主机名/端口身份(redis/minio/mysql)/页面 JS 里的提示词/组织名
2. **变异模板库**(种子×模板笛卡尔):
   - 后缀:123 2024 2025 2026 2026! # @ ! 666 888 -pass _key
   - 包装:Api#<Seed>2026 / <Seed>@2026# / <Seed>2026! / S<seed>cret 风格字符替换(a→@ i→1 e→3 o→0 s→$)
   - 大小写:首字母大写/全大写
3. **用户名二维法(先定位用户,再扩密码)**:seclists/Usernames/xato-net-10-million
   × top-1000 密码面先行——命中有效用户名后再对该用户名扩密码;无枚举差异时
   以"用户名存在→错误响应稳定无变化"为前提全表扫(错密码不会锁,见锁定探测)
4. 密码命中后立即横穿复用(同环境同套凭证设计概率高)

## 6. 复合模板与回退矩阵(语义全空时)
- 复合模板(双分隔符,实战高频):Seed@YYYY# / Seed@YYYY! / Seed#YYYY@ /
  Seed-YYYY_key / S<seed>cret! / <Seed>Key! / ChinaYYYY#(地域词)
- 回退顺序:语义矩阵空 → 用户全集(xato 英文词过滤)×rockyou 全量分段 →
  用户×用户名自身变体(用户名+123/用户名@YYYY) → 跨面横穿已命中凭据
- 凭据设计同源性:同环境多面共用一套设计语言——一面命中后把其"形态"
  (大小写/分隔/年份)套到其余面的种子上再扫一轮
