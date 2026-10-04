/** loop22-#1: 官方 read 负路径人话化——pi read 对 ENOENT reject
 * undefined(pi 内部吞错), adapter 兜底渲染。确定性直测 adapter。 */
import { adaptHarnessTool } from '../src/sandbox/harness-adapter.mjs';
import { createReadTool } from '@earendil-works/pi-agent-core';
import { ck, finish } from './helpers.mjs';

const env = {
  absolutePath: p => p,
  readFile: async () => { const e = new Error("ENOENT: no such file or directory, open '/x/probe.txt'"); e.code = 'ENOENT'; throw e; },
};
const tool = adaptHarnessTool(createReadTool(), env);
const inv = { invocationId: 'i', operationId: 'o', turnId: 't', getMemo: async () => {}, setMemo: async () => {} };
// adaptHarnessTool 的 execute 签名: (toolCallId, params, signal, onUpdate)
const out = await tool.execute('t1', { path: '/x/probe.txt' }, null, () => {});

ck('回执 isError', out.isError === true);
const text = out.content?.[0]?.text ?? '';
ck('含人话 not_found', text.includes('read 失败:not_found'));
ck('含文件路径', text.includes('/x/probe.txt'));
ck('含补救指引', text.includes('bash ls'));
ck('不再 [object Object]', !text.includes('[object Object]'));

finish();
