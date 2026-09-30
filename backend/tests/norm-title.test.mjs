/**
 * CS3-N1/CS5-N6: normTitle 标点剥离行为锁定——字符类转义错误曾静默
 * 失效两轮审计。CS4-M5 起 import tools.mjs 导出的真实现(单一事实源,
 * 实现回归即红)。
 */
import { finish } from './helpers.mjs';

// CS4-M5: import 真实现(此前锁的是逐字副本——实现回归测试仍绿)
import { normTitle as norm } from '../src/tools.mjs';

function ck(label, ok) {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
}

ck('标点/空白剥离', norm('a b.c,d;e(f)g') === 'abcdefg');
ck('中文标点剥离', norm('XSS（反射） · 存储型') === 'xss反射存储型');
ck('连字符剥离', norm('OGSL-CVE-2026') === 'ogslcve2026');
ck('大小写归一', norm('MiXeD CaSe') === 'mixedcase');
finish();
