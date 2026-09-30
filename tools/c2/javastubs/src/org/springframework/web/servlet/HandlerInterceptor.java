package org.springframework.web.servlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
public interface HandlerInterceptor {
    boolean preHandle(HttpServletRequest r, HttpServletResponse r2, Object h) throws Exception;
}
