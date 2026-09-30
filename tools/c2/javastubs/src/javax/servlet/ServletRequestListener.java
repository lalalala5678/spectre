package javax.servlet;
public interface ServletRequestListener extends java.util.EventListener {
    void requestInitialized(ServletRequestEvent sre);
    void requestDestroyed(ServletRequestEvent sre);
}
