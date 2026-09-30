// jakarta(Tomcat10)Servlet 注入位(冰蝎协议兼容骨架)
public class BehinderShell extends jakarta.servlet.http.HttpServlet {
    String k = "e45e329feb5d925b"; // md5("rebeyond")[:16] 公开默认
    public void doPost(jakarta.servlet.http.HttpServletRequest req,
            jakarta.servlet.http.HttpServletResponse res) {
        try {
            javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES");
            String out = "SPECTRE-MARK-SERVLET";
            res.getWriter().write(out);
        } catch (Exception e) {}
    }
}
