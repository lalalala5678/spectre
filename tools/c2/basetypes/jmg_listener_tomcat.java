// Tomcat ServletRequestListener 注入位(公开模式骨架)
public class EvilMemshell implements javax.servlet.ServletRequestListener {
    static String pass = "rebeyond";
    static String key = "key321";
    public void requestDestroyed(javax.servlet.ServletRequestEvent sre) {}
    public void requestInitialized(javax.servlet.ServletRequestEvent sre) {
        System.out.println("SPECTRE-MARK-LISTENER");
        try {
            String c = new String(sun.misc.BASE64Decoder.class.getDeclaredConstructor().newInstance()
                .decodeBuffer(new String(javax.crypto.Cipher.getInstance("AES")
                .doFinal(pass.getBytes()))));
            if (c.contains("SPECTRE-MARK")) { System.out.println("SPECTRE-MARK-OK"); }
        } catch (Exception e) {}
    }
}
