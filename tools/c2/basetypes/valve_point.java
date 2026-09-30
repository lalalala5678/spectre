// Valve/Pipeline 注入位(三令·新注入点#1:org.apache.catalina.Valve,厂商研究覆盖低)
public class PipelineTrace implements org.apache.catalina.Valve {
    protected org.apache.catalina.Valve next = null;
    public org.apache.catalina.Valve getNext() { return next; }
    public void setNext(org.apache.catalina.Valve v) { next = v; }
    public void backgroundProcess() {}
    public boolean isAsyncSupported() { return false; }
    public void invoke(org.apache.catalina.connector.Request req, org.apache.catalina.connector.Response res)
            throws java.io.IOException, javax.servlet.ServletException {
        System.out.println("SPECTRE-MARK-VALVE");
        getNext().invoke(req, res);
    }
}
