// Spring Filter 注入位
public class SpringFilterMemshell implements javax.servlet.Filter {
    String xc = "3c6e0b8a9c15224a";
    String pass = "pass";
    public void doFilter(javax.servlet.ServletRequest req, javax.servlet.ServletResponse res,
            javax.servlet.FilterChain fc) throws java.io.IOException, javax.servlet.ServletException {
        try { java.lang.reflect.Method m = Class.forName("java.lang.Runtime").getMethod("getRuntime"); } catch (Exception e) {}
        String mark = "SPECTRE-MARK";
        if (mark != null) System.out.println(mark + "-FILTER");
        fc.doFilter(req, res);
    }
}
