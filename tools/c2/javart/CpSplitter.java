import org.objectweb.asm.*;
import java.nio.file.*;
import java.util.*;

/** CpSplitter — 常量池 LDC 字符串分裂(公开打包技术:运行时 StringBuilder 拼接)。
 *  用法: java -cp asm-9.7.jar:. CpSplitter <in.class> <out.class> <targets-file>
 *  targets-file: 每行一个目标字符串;命中 LDC → new StringBuilder(a).append(b).toString()
 *  语义:运行时字符串值不变(无 javac 常量折叠,因为这里是字节码级拼接)。
 */
public class CpSplitter extends ClassVisitor {
    static Set<String> targets = new HashSet<>();
    static Set<String> rewritten = new TreeSet<>();

    public CpSplitter(ClassVisitor cv) { super(Opcodes.ASM9, cv); }

    static int swallowed = 0;

    @Override
    public MethodVisitor visitMethod(int access, String name, String desc,
                                     String signature, String[] exceptions) {
        MethodVisitor mv = super.visitMethod(access, name, desc, signature, exceptions);
        return new MethodVisitor(Opcodes.ASM9, mv) {
            @Override
            public void visitMethodInsn(int opcode, String owner, String mname, String mdesc, boolean itf) {
                // 二令⑥:printStackTrace 调用吞净(receiver 出栈即可,行为等价于空 catch 面)
                if (opcode == Opcodes.INVOKEVIRTUAL && mname.equals("printStackTrace")) {
                    visitInsn(Opcodes.POP);
                    swallowed++;
                    return;
                }
                super.visitMethodInsn(opcode, owner, mname, mdesc, itf);
            }
            @Override
            public void visitLdcInsn(Object cst) {
                if (cst instanceof String && targets.contains(cst)) {
                    String s = (String) cst;
                    rewritten.add(s);
                    int k = Math.max(1, s.length() / 2);
                    String a = s.substring(0, k), b = s.substring(k);
                    // 防半串仍含完整目标(短串保护:错位切)
                    if (a.equals(s) || b.equals(s)) { super.visitLdcInsn(cst); return; }
                    visitTypeInsn(Opcodes.NEW, "java/lang/StringBuilder");
                    visitInsn(Opcodes.DUP);
                    visitLdcInsn(a);
                    visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/StringBuilder",
                            "<init>", "(Ljava/lang/String;)V", false);
                    visitLdcInsn(b);
                    visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/StringBuilder",
                            "append", "(Ljava/lang/String;)Ljava/lang/StringBuilder;", false);
                    visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/StringBuilder",
                            "toString", "()Ljava/lang/String;", false);
                    return;
                }
                super.visitLdcInsn(cst);
            }
        };
    }

    public static void main(String[] args) throws Exception {
        byte[] in = Files.readAllBytes(Paths.get(args[0]));
        for (String line : Files.readAllLines(Paths.get(args[2])))
            if (!line.trim().isEmpty()) targets.add(line.trim());
        ClassReader cr = new ClassReader(in);
        // V1_5 老版本类(jMG 默认输出)必须 F_NEW 帧:EXPAND_FRAMES+COMPUTE_FRAMES
        ClassWriter cw = new ClassWriter(ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS) {
            @Override
            protected String getCommonSuperClass(String a, String b) {
                try { return super.getCommonSuperClass(a, b); }
                catch (Throwable t) { return "java/lang/Object"; }  // 隔离环境无依赖类时的保守回落
            }
        };
        cr.accept(new CpSplitter(cw), ClassReader.EXPAND_FRAMES);
        Files.write(Paths.get(args[1]), cw.toByteArray());
        System.out.println("CPSPLIT-OK " + args[0] + " -> " + args[1] + " targets=" + targets.size()
                + " rewritten=" + rewritten + " stackSwallowed=" + swallowed);
    }
}
