// jakarta(Tomcat10)Filter 注入位
public class SpringFilterMemshell implements jakarta.servlet.Filter {
    String xc = "3c6e0b8a9c15224a";
    String pass = "pass";
    public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res,
            jakarta.servlet.FilterChain fc) throws java.io.IOException, jakarta.servlet.ServletException {
        try { java.lang.reflect.Method m = Class.forName("java.lang.Runtime").getMethod("getRuntime"); } catch (Exception e) {}
        String mark = "SPECTRE-MARK";
        if (mark != null) System.out.println(mark + "-FILTER");
        fc.doFilter(req, res);
    }
}
