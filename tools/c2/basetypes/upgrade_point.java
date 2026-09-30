// Upgrade/协议升级 注入位(三令·新注入点#2:HttpUpgradeHandler,厂商研究覆盖低)
public class UpgradePoint extends javax.servlet.http.HttpServlet {
    public void doGet(javax.servlet.http.HttpServletRequest req, javax.servlet.http.HttpServletResponse res)
            throws java.io.IOException, javax.servlet.ServletException {
        req.upgrade(UpgradeSession.class);
    }
    public static class UpgradeSession implements javax.servlet.http.HttpUpgradeHandler {
        public void init(javax.servlet.http.WebConnection wc) {
            System.out.println("SPECTRE-MARK-UPGRADE");
            try { wc.close(); } catch (Exception e) {}
        }
        public void destroy() {}
    }
}
