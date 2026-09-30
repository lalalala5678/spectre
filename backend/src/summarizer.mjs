/**
 * Session title + rolling brief generator.
 *
 * Uses the SAME model/provider as the agent conversations (CONFIG single
 * source) — this is an open-source project; secondary "cheap model"
 * assumptions are forbidden. Cost is bounded by policy instead:
 *
 *   - low-signal gate: greetings never trigger a call
 *   - one-shot title after the first exchange
 *   - rolling brief only at agent_end, throttled by message delta or idle
 *   - input truncated, output capped via stream maxTokens
 *   - single in-flight job per session, no retry storms
 *
 * Calls run as throwaway pi Agents — side-channel, never inside the
 * user-facing conversation transcript.
 */

import { Agent } from '@earendil-works/pi-agent-core';

import { CONFIG } from './config.mjs';
import { normalizeMessage } from './pi.mjs';

const GREETING_RE = /^(你好|您好|hi|hello|hey|ok|okay|好的|收到|嗯+|test|在吗|在不在)[!。.!?\s]*$/i;

const TITLE_SYSTEM = [
  '为 <user> 中的任务写一个 3-8 词的简短标题(使用对话的主要语言)。',
  '只输出 <title></title> 包裹的标题,前后不得有任何其他内容。',
  '专有名词与技术术语必须逐字照抄,不得改写。若只是寒暄或尚无具体任务,输出 <title/>。',
  '示例:',
  '<user>login button is broken on mobile, fix it</user>',
  '<title>Fix login button on mobile</title>',
  '<user>hey</user>',
  '<title/>',
].join('\n');

const BRIEF_SYSTEM = [
  '你在维护一个渗透测试会话的简述(1-2 句,使用对话的主要语言)。',
  '输入包含【当前简述】与【新增内容】。输出更新后的简述:概括会话至今的目标、进展与关键结论。',
  '只输出简述正文,不要任何前缀、解释或引号。不超过 60 字。',
].join('\n');

const TITLE_TAG_RE = /<title>([\s\S]*?)<\/title>|<title\/>/i;

function extractTitle(raw) {
  const text = String(raw || '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .trim();
  const m = text.match(TITLE_TAG_RE);
  if (!m || m[1] === undefined) return null;
  const title = (m[1] ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!title || /^(none|null|无)$/i.test(title)) return null;
  // R28-N5: 32 字硬截断会切断 ASCII 连续 token(NDAY-R32D28→NDAY-R3,
  // 全局搜索按完整串找不到)。词边界截断, 超长才回退硬切, 上限 60。
  if (title.length <= 60) return title;
  const hard = title.slice(0, 60);
  const cut = hard.match(/^[\s\S]*[\s-]/);  // 空格或连字符(NDAY-R32D28 类 token 的自然边界)
  return (cut && cut[0].trim().length >= 20) ? cut[0].trim() : hard;
}

/** pi transcript slice as flat text, newest last, bounded by chars. */
function transcriptText(record, fromIndex, maxChars) {
  const messages = record.agent.state.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(fromIndex);
  const lines = messages.map(m => {
    const norm = normalizeMessage(m);
    return `${norm.role === 'user' ? '用户' : '智能体'}: ${(norm.text || '').slice(0, 400)}`;
  });
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(-maxChars);
  return text;
}

export class Summarizer {
  /**
   * @param {{model: object, streamFn: Function}} deps same model as chats
   */
  constructor({ model, streamFn }) {
    this.model = model;
    this.streamFn = streamFn;
  }

  /** One-shot side-channel LLM call with hard output cap. */
  async _call(systemPrompt, userText, maxTokens) {
    const capped = (m, ctx, opts = {}) =>
      this.streamFn(m, ctx, { ...opts, maxTokens });
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.model,
        tools: [],
        thinkingLevel: 'low',
      },
      streamFn: capped,
    });
    await agent.prompt(userText.slice(0, 3000));
    const last = [...agent.state.messages].reverse()
      .find(m => m.role === 'assistant');
    const norm = last ? normalizeMessage(last) : null;
    return norm?.text ?? '';
  }

  /** pi-style low-signal gate on the first user text. */
  static isLowSignal(record) {
    const first = record.agent.state.messages.find(m => m.role === 'user');
    if (!first) return true;
    const norm = normalizeMessage(first);
    const text = (norm.text || '').trim();
    return !text || text.length < 4 || GREETING_RE.test(text);
  }

  /** Generate the one-shot title after the first exchange. */
  async generateTitle(record) {
    if (record.title || Summarizer.isLowSignal(record)) return null;
    const first = normalizeMessage(
      record.agent.state.messages.find(m => m.role === 'user') ?? {},
    );
    const reply = record.agent.state.messages.find(m => m.role === 'assistant');
    const replyText = reply ? normalizeMessage(reply).text.slice(0, 400) : '';
    const raw = await this._call(
      TITLE_SYSTEM,
      `<user>${first.text}${replyText ? `\n(助手首轮:${replyText})` : ''}</user>`,
      1024,
    );
    const title = extractTitle(raw);
    if (title) record.title = title;
    return title;
  }

  /** Refresh the rolling brief; policy decided by shouldRefreshBrief. */
  async refreshBrief(record) {
    const raw = await this._call(
      BRIEF_SYSTEM,
      `【当前简述】${record.brief ?? '(无)'}\n【新增内容】\n${transcriptText(record, record.briefUpTo ?? 0, 2400)}`,
      768,
    );
    const brief = raw.replace(/^(简述|摘要)[:：]\s*/, '').trim().slice(0, 80);
    if (brief) {
      record.brief = brief;
      record.briefUpTo = record.agent.state.messages.length;
      return brief;
    }
    return null;
  }

  static shouldRefreshBrief(record, cfg) {
    const msgs = record.agent.state.messages.length;
    const delta = msgs - (record.briefUpTo ?? 0);
    if (delta < cfg.minDelta) return false;
    const idleMs = Date.now() - (record.lastActivityTs ?? 0);
    return delta >= cfg.eagerDelta || idleMs >= cfg.idleMs;
  }
}
