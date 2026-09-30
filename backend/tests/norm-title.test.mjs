/**
 * CS3-N1/CS5-N6: normTitle 标点剥离行为锁定——字符类转义错误曾静默
 * 失效两轮审计。CS4-M5 起 import tools.mjs 导出的真实现(单一事实源,
 * 实现回归即红)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normTitle as norm } from '../src/tools.mjs';

test('标点/空白剥离', () => assert.equal(norm('a b.c,d;e(f)g'), 'abcdefg'));
test('中文标点剥离', () => assert.equal(norm('XSS（反射） · 存储型'), 'xss反射存储型'));
test('连字符剥离', () => assert.equal(norm('OGSL-CVE-2026'), 'ogslcve2026'));
test('大小写归一', () => assert.equal(norm('MiXeD CaSe'), 'mixedcase'));
