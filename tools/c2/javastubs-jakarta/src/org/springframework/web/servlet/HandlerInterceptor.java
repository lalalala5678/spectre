package org.springframework.web.servlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
public interface HandlerInterceptor {
    boolean preHandle(HttpServletRequest r, HttpServletResponse r2, Object h) throws Exception;
}
