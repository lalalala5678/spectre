/**
 * CS3-N1: normTitle 标点剥离行为锁定——tools.mjs 的字符类转义错误
 * ([\] 失转义致字符类提前闭合)曾让它静默失效两轮审计。实现与
 * tools.mjs buildIntelTools.normTitle 同源; 改动须两侧同步。
 */
import { finish } from './helpers.mjs';

const NORM_RE = /[\s·,。,.;:;:()[\]()（）【】《》""''-]/g;
const norm = s => String(s ?? '').toLowerCase().replace(NORM_RE, '');

function ck(label, ok) {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
}

ck('标点/空白剥离', norm('a b.c,d;e(f)g') === 'abcdefg');
ck('中文标点剥离', norm('XSS（反射） · 存储型') === 'xss反射存储型');
ck('连字符剥离', norm('OGSL-CVE-2026') === 'ogslcve2026');
ck('大小写归一', norm('MiXeD CaSe') === 'mixedcase');
finish();
