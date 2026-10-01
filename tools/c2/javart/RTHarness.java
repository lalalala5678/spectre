import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;
import javax.servlet.ServletContainerInitializer;
import javax.servlet.ServletContext;
import javax.servlet.ServletRegistration;
import javax.servlet.FilterRegistration;
import java.util.Set;
import java.io.*;
import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.net.*;
import java.nio.file.*;

/** RTHarness — Java 内存马运行时桩(嵌入式 Tomcat 9,公开 embed API)。
 *  功能从"编译过"升"运行过":真 register + 真 HTTP 触发 + echo 断言。
 *  用法:
 *    java [-cp tomcat-embed-core.jar:stubs:variant-classes] [--patch-module jdk.unsupported=...] \
 *         RTHarness <listener|filter|servlet|annotation|load> <className> [expectedMarker]
 *  判定:RT-RESULT: OK = 注册成功+请求触发+标记在(捕获 stdout ∪ 响应体);exit 0
 *        否则 FAIL + exit 3(标记缺失/异常/响应 5xx)
 */
public class RTHarness {
    static final ByteArrayOutputStream cap = new ByteArrayOutputStream();
    static PrintStream orig = System.out;

    public static void main(String[] args) {
        String mode = args[0], className = args[1];
        String expected = args.length > 2 ? args[2] : "";
        PrintStream tee = new PrintStream(new OutputStream() {
            public void write(int b) { orig.write(b); cap.write(b); }
        }, true);
        System.setOut(tee);
        String detail = "not-run";
        try {
            switch (mode) {
                case "listener": detail = rtListener(className); break;
                case "filter":   detail = rtFilter(className); break;
                case "servlet":  detail = rtServlet(className); break;
                case "annotation": detail = rtAnnotation(className); break;
                case "load":     detail = rtLoad(className); break;
                case "valve":    detail = rtValve(className); break;
                case "upgrade":  detail = rtUpgrade(className); break;
                default: detail = "unknown-mode:" + mode;
            }
        } catch (Throwable t) {
            detail = "RT-EXCEPTION:" + t;
        }
        boolean captured = expected.isEmpty() || cap.toString().contains(expected) || detail.contains(expected);
        boolean ok = detail.startsWith("OK") && captured;
        orig.println("RT-RESULT: " + (ok ? "OK" : "FAIL") + " mode=" + mode + " captured=" + captured
                + " detail=" + detail.replace('\n', '|'));
        System.exit(ok ? 0 : 3);
    }

    static int freePort() throws Exception {
        try (ServerSocket s = new ServerSocket(0)) { return s.getLocalPort(); }
    }

    static File tmpDir() throws Exception {
        File d = Files.createTempDirectory("rtharness").toFile();
        d.deleteOnExit();
        return d;
    }

    static String one(int port, String method) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/").openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(3000); c.setReadTimeout(3000);
            c.setDoOutput("POST".equals(method));
            if ("POST".equals(method)) { c.setFixedLengthStreamingMode(0); c.getOutputStream().close(); }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[2048]; int n;
            if (in != null) while ((n = in.read(b)) > 0) o.write(b, 0, n);
            return method + "=" + code + " " + new String(o.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return method + "-error:" + e;
        }
    }

    static String httpGet(int port) {  // 探针:GET+POST(servlet 的 doPost 才是触发面)
        return one(port, "GET") + " || " + one(port, "POST");
    }

    interface Reg { void reg(Context ctx) throws Exception; }

    static javax.servlet.ServletContext scOf(Context ctx) throws Exception {
        // 通过一次性 SCI 拿 ServletContext 不可行——直接用 ctx 的 ServletContext
        return ctx.getServletContext();
    }

    static String rtTomcat(Reg reg) throws Exception { return rtTomcat(reg, "both"); }

    static String rtTomcat(Reg reg, String probe) throws Exception {
        Tomcat t = new Tomcat();
        int port = freePort();
        t.setPort(port);
        t.setBaseDir(tmpDir().getAbsolutePath());
        t.getConnector();
        Context ctx = t.addContext("", tmpDir().getAbsolutePath());
        ctx.setParentClassLoader(RTHarness.class.getClassLoader());
        reg.reg(ctx);
        t.start();
        String http = "get".equals(probe) ? one(port, "GET") : httpGet(port);
        try { t.stop(); t.destroy(); } catch (Exception ignore) {}
        boolean okCode = !http.contains("=5") && !http.contains("-error:");  // 5xx/连接错误才 BAD;404/405=合法(无 doGet/无映射)
        return (okCode ? "OK " : "BAD ") + http;
    }

    // 注册走 Servlet 3.0 SCI 程序化 API——与真实内存马注入路径同源(sc.addFilter/addServlet/addListener)
    static String rtViaSci(String cn, String kind) throws Exception { return rtViaSci(cn, kind, "both"); }

    static String rtViaSci(String cn, String kind, String probe) throws Exception {
        return rtTomcat(ctx -> ctx.addServletContainerInitializer(new ServletContainerInitializer() {
            @Override
            public void onStartup(Set<Class<?>> c, ServletContext sc) {
                switch (kind) {
                    case "listener":
                        sc.addListener(cn);
                        break;
                    case "filter": {
                        // 宿主 servlet:Tomcat 过滤链只对命中 servlet 的请求执行(公开行为),
                        // harness 提供最小落点让 /* 过滤链真实跑起来
                        sc.addServlet("rthost", HostServlet.class.getName()).addMapping("/");
                        FilterRegistration.Dynamic fr = sc.addFilter("rtfilter", cn);
                        fr.addMappingForUrlPatterns(null, false, "/*");
                        break;
                    }
                    case "servlet": {
                        ServletRegistration.Dynamic sr = sc.addServlet("rtservlet", cn);
                        sr.addMapping("/");
                        break;
                    }
                    case "upgrade": {
                        ServletRegistration.Dynamic sr = sc.addServlet("rtup", cn);
                        sr.addMapping("/");
                        break;
                    }
                }
            }
        }, null), probe);
    }

    static String rtListener(String cn) throws Exception { return rtViaSci(cn, "listener"); }

    static String rtValve(String cn) throws Exception {          // 三令新位#1:Pipeline 真挂阀
        return rtTomcat(ctx -> {
            Object v = Class.forName(cn).getDeclaredConstructor().newInstance();
            ((org.apache.catalina.core.StandardContext) ctx).getPipeline().addValve((org.apache.catalina.Valve) v);
        });
    }

    static String rtUpgrade(String cn) throws Exception {        // 三令新位#2:协议升级通道(SCI 注册)
        return rtViaSci(cn, "upgrade", "get");   // 101 切换后只探 GET
    }
    static String rtFilter(String cn) throws Exception { return rtViaSci(cn, "filter"); }
    static String rtServlet(String cn) throws Exception { return rtViaSci(cn, "servlet"); }

    public static class HostServlet extends javax.servlet.http.HttpServlet {
        @Override
        protected void doGet(javax.servlet.http.HttpServletRequest req,
                             javax.servlet.http.HttpServletResponse res) throws java.io.IOException {
            res.setContentType("text/plain");
            res.getWriter().write("RT-HOST-OK");
        }
        @Override
        protected void doPost(javax.servlet.http.HttpServletRequest req,
                              javax.servlet.http.HttpServletResponse res) throws java.io.IOException {
            doGet(req, res);
        }
    }

    static String rtAnnotation(String cn) throws Exception {
        Class<?> c = Class.forName(cn);
        @SuppressWarnings("unchecked")
        Class<? extends Annotation> ann =
                (Class<? extends Annotation>) Class.forName("org.springframework.web.bind.annotation.RequestMapping");
        Class<? extends Annotation> body =
                (Class<? extends Annotation>) Class.forName("org.springframework.web.bind.annotation.ResponseBody");
        boolean clsAnn = c.isAnnotationPresent(ann);
        int mAnn = 0, mBody = 0;
        for (Method m : c.getDeclaredMethods()) {
            if (m.isAnnotationPresent(ann)) mAnn++;
            if (m.isAnnotationPresent(ann) && m.isAnnotationPresent(body)) mBody++;
        }
        // 二令⑦+返工项4:回显方法须 @ResponseBody(直回显可达)+ RUNTIME 可见
        boolean ok = (clsAnn || mAnn > 0) && (mAnn == 0 || mBody == mAnn);
        return (ok ? "OK " : "BAD ") + "classAnn=" + clsAnn + " methodAnn=" + mAnn + " methodBodyAnn=" + mBody;
    }

    static String rtLoad(String cn) throws Exception {
        // 加载级验证:解析+链接但不初始化(格式/校验器过;类目录需在 -cp 上)
        Class<?> c = Class.forName(cnFor(cn), false, RTHarness.class.getClassLoader());
        return "OK loaded=" + c.getName() + " methods=" + c.getDeclaredMethods().length;
    }

    static String cnFor(String s) { return s.contains("/") ? s.replace('/', '.') : s; }
}
