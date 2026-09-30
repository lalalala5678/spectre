// Spring Controller 注入位(@RequestMapping 动态注册模式)
public class CtrlMemshell {
    @org.springframework.web.bind.annotation.RequestMapping("/api/log/report")
    @org.springframework.web.bind.annotation.ResponseBody
    public String handle(java.util.Map<String,String> params) {
        String val = params.getOrDefault("log_id", "SPECTRE-MARK");
        return "{\"code\":0,\"msg\":\"ok\",\"data\":\"" + val + "-CTRL\",\"request_id\":\"" + java.util.UUID.randomUUID() + "\"}";
    }
}
