// real-lane 探针:jMG 同款反射模式(Class.forName 字符串→方法名反射),
// 自带承重回显;编译后作为 .class 走字节码变换族的完整验证链。
public class RealLaneProbe implements javax.servlet.ServletRequestListener {
    public void requestDestroyed(javax.servlet.ServletRequestEvent e) {}
    public void requestInitialized(javax.servlet.ServletRequestEvent e) {
        try {
            Class<?> c = Class.forName("java.lang.Runtime");
            java.lang.reflect.Method m = c.getDeclaredMethod("getRuntime");
            System.out.println("SPECTRE-MARK-REALLANE " + (m != null));
        } catch (Exception ex) {
            System.out.println("SPECTRE-MARK-REALLANE err");
        }
    }
}
