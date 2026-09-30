package javax.servlet;
import java.io.IOException;
public interface Filter {
    void doFilter(ServletRequest req, ServletResponse res, FilterChain fc) throws IOException;
}
