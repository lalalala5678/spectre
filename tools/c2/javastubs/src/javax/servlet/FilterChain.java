package javax.servlet;
import java.io.IOException;
public interface FilterChain {
    void doFilter(ServletRequest req, ServletResponse res) throws IOException;
}
