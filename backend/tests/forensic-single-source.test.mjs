/**
 * forensic-single-source(用户令: 取证纪律/禁拖库全仓有且仅有一条表述)
 *
 * 对抗性机锁——三条独立防线, 任一被绕过即红:
 *  A. 唯一表述: pi.mjs 中规则家族关键词(同义网见 FAMILY_RE)只允许出现在
 *     FORENSIC_LEAK_RULE 常量块内部; 块外(含注释外正文/字符串)任何命中
 *     = 有人复述了纪律(提示词污染回归)。
 *  B. 注入恰一次: ORCHESTRATOR_PROMPT(主控)与 STAGE_PROMPT(全员)各包含
 *     且仅包含一次规则——缺=对应席位失明; 多=重复注入回归; 常量引用数
 *     锁 3(1 声明+2 注入), 防第三注入点。
 *  C. 全仓扫毒: 所有提示词供给面(backend 源码/技能文档/deploy 播种/工具/
 *     网关/前端源码)零命中——技能文档不得自带本纪律的任何变体。
 *     (README 战绩叙述不是提示词供给面, 不在扫描范围。)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORCHESTRATOR_PROMPT, STAGE_PROMPT } from '../src/pi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULE_SIGNATURE = '【取证纪律·敏感数据泄露';
/** 同义网: 本纪律的一切已知措辞。新增变体须入网——网眼即对抗面;
 * (?!\d) 防 '≤100' 这类数值误报。 */
const FAMILY_RE
  = /拖库|全量下载|全量导出|导出到磁盘|导出全量|全量数据文件|数据本体|零取证|硬上限|≤\s*10(?!\d)|不超过\s*10(?!\d)|小于\s*10(?!\d)|10\s*条样本/g;

const piPath = join(ROOT, 'backend', 'src', 'pi.mjs');
const piSrc = readFileSync(piPath, 'utf8');
const block = piSrc.match(/const FORENSIC_LEAK_RULE = \[[\s\S]*?\]\.join\(' '\);/);
/** 注释不进提示词, 扫正文前剥离(防本测试自身说明文字误报) */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('A. 唯一表述: FORENSIC_LEAK_RULE 常量块外零命中', () => {
  assert.ok(block, 'FORENSIC_LEAK_RULE 常量块缺失——权威表述被删?');
  assert.ok(FAMILY_RE.test(block[0]), '常量块内未命中同义网——规则实质内容丢失');
  FAMILY_RE.lastIndex = 0; // .test 带 /g 会推进 lastIndex
  const outside = stripComments(piSrc.replace(block[0], ''));
  const hits = outside.match(FAMILY_RE) ?? [];
  assert.deepEqual(hits, [], `常量块外出现纪律措辞(复述=提示词污染): ${hits.join(', ')}`);
});

test('B. 注入恰一次: 主控与全员各见且仅见一次', () => {
  for (const [name, prompt] of [['ORCHESTRATOR_PROMPT', ORCHESTRATOR_PROMPT], ['STAGE_PROMPT', STAGE_PROMPT]]) {
    const n = prompt.split(RULE_SIGNATURE).length - 1;
    assert.equal(n, 1, `${name} 规则签名出现 ${n} 次, 须恰 1 次`);
    assert.ok(prompt.includes('禁止拖库'), `${name} 缺禁拖库实体条款`);
    assert.ok(prompt.includes('不超过 10 条样本'), `${name} 缺采样上限实体条款`);
  }
  const refs = piSrc.match(/FORENSIC_LEAK_RULE/g) ?? [];
  assert.equal(refs.length, 3, `FORENSIC_LEAK_RULE 出现 ${refs.length} 次, 须恰 3 次(1 声明+2 注入)`);
});

/** 递归收集提示词供给面文本文件(排除 node_modules/.git/__pycache__/dist/
 * backend tests 自身——测试文件含本机锁的同义网样张)。 */
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '__pycache__', 'dist', 'tests'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(mjs|md|py|sh|map|ts|tsx|json|ya?ml|txt)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

test('C. 全仓扫毒: 提示词供给面零命中(技能/源码/播种/工具)', () => {
  const dirs = ['backend/src', 'docs', 'deploy', 'gateway', 'console/src', 'plugins', 'tools']
    .map((d) => join(ROOT, d));
  const files = [];
  for (const d of dirs) { try { walk(d, files); } catch { /* 目录不存在则跳过 */ } }
  // backend 根层 .mjs(agent-runtime.mjs 等聚合文件)
  for (const f of readdirSync(join(ROOT, 'backend'))) {
    if (f.endsWith('.mjs')) files.push(join(ROOT, 'backend', f));
  }
  const offenders = [];
  for (const f of files) {
    if (f === piPath) continue; // pi.mjs 由防线 A 单独治理
    let text = readFileSync(f, 'utf8');
    // 代码注释不进提示词——.mjs/.ts/.tsx 只扫字符串字面量正文;
    // .md/.py/.sh 等原文扫(agent 可读其全文, 纪律变体无处藏)。
    if (/\.(mjs|ts|tsx)$/.test(f)) text = stripComments(text);
    const hits = text.match(FAMILY_RE);
    if (hits) offenders.push(`${f}: ${[...new Set(hits)].join(',')}`);
  }
  assert.deepEqual(offenders, [], `供给面发现纪律复述: \n${offenders.join('\n')}`);
});
