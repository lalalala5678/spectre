import { ScopeAuthCard } from './ScopeAuthCard';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Loader2, User, X, TriangleAlert } from 'lucide-react';

import {
  api,
  subscribeSse,
  type ApiMessage,
  type ApiSessionDetail,
  type ApiSessionEvent,
} from '../../api/client';
import { ChatInput } from './ChatInput';
import { Markdown } from './Markdown';
import { cn } from '../../utils/cn';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

/**
 * Live pi session view (controlled): the workspace owns which session is
 * open; this component renders it, streams journal events via SSE, and
 * sends prompts / steering messages.
 */
export function LiveSession({ agentKey, sessionId, onGone, heading }: {
  agentKey: string;
  sessionId: string | null;
  onGone?: () => void;
  heading?: string;  // EQ-10: 语义标题(替代裸 sess-xxx id)
}) {
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const lastSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Infinite-scroll window state — declared early: handleScroll (below)
  // freezes the start index when the user leaves the bottom.
  const [startIdx, setStartIdx] = useState<number | null>(null);
  const messagesLenRef = useRef(0);
  messagesLenRef.current = messages.length;  // react/refs 豁免: 渲染期写 ref 服务 SSE 闭包最新值(lint-exemptions 记档)
  // Follow intent: the USER decides. At the bottom → stick; scrolled up
  // to read → release; scrolled back down → re-stick. Scroll events are
  // the only source of truth — never a distance probe at event-arrival
  // time (the old followIfNearBottom ran BEFORE React committed the new
  // content, so its scrollHeight was stale and any single commit growing
  // past the 120px threshold — thinking panel first appearance is 224px
  // capped — detached the follow permanently with no way back).
  const stickToBottom = useRef(true);
  // 用户令: 拖到上方阅读时几秒后被拉回底部——程序性 pin(布局补偿/RO
  // re-pin)会触发 scroll 事件, 该事件里 nearBottom 误判为真把 stick
  // 翻回 true, 下一次内容提交即强拉底部。pin 后 300ms 内的 scroll 事
  // 件一律视为程序回声, 不评估意图。
  const pinGuard = useRef(0);
  const pinToBottom = (el: HTMLElement) => {
    pinGuard.current = Date.now();
    el.scrollTop = el.scrollHeight;
  };

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() - pinGuard.current < 300) {
      // 程序回声豁免只吞"仍在底部"的 pin 回声——流式高频 pin 期间
      // 用户向上拖(已离开底部)必须生效, 否则 busy 时滚动条锁死在底
      // (用户实测思考中竖条拖不上去)。
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottom.current = nearBottom;
    // Freeze the window start the moment the user leaves the bottom:
    // streaming arrivals then extend the tail instead of shifting the
    // history being read (tail-window drift fix). Returning to the
    // bottom re-enters tail-follow mode (null state is a no-op there).
    setStartIdx(prev => {
      // r50d 断环: 底部**不重置**窗口——nearBottom 曾把冻结起点清回
      // null(尾 30), 顶部 sentinel 随即链式补载回全量, scroll 再触发
      // 重置……滚动条五阶梯循环(用户实测 1-2s/轮)的闭环即此。向上
      // 滚动才冻结; 回到底部保持已加载的历史不动。
      if (nearBottom) return prev;
      if (prev !== null) return prev;
      return Math.max(0, messagesLenRef.current - 30);
    });
  }, []);

  // Follow AFTER commit: this effect runs with the laid-out DOM (and
  // pre-paint via useLayoutEffect, so there is no visible jump). Every
  // committed growth — deltas, thinking panel, tool cards, injected
  // messages — is followed as long as the user's intent says stick.
  useLayoutEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) pinToBottom(el);
  }, [messages, busy, loaded, error]);

  // FE-B1(用户报): 思考流期间拖到底部会"抽搐"——每次 delta 提交先 pin
  // 一次, 但内容异步再变高(语法高亮换行/字体就位)时视口又高于底,
  // 下一提交再 pin = 来回跳。ResizeObserver 在 stick 期间对内容高度
  // 变化即时 re-pin(overflow-anchor:none 已关浏览器原生锚定与手动
  // pin 的互相拉扯)。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // FEVERIFY-C2: 旧重挂链在尾子被 React 替换(而非追加)时断裂
    // (verify 实测 +300px 不回钉)——改 MutationObserver 跟 childList
    // 变化重挂尾子, 与 RO 组合。
    let lastH = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      // r50c: 高度环自激保险——变化 <2px(如滚动条互扰)不 re-pin
      if (Math.abs(el.scrollHeight - lastH) < 2) return;
      lastH = el.scrollHeight;
      if (stickToBottom.current) pinToBottom(el);
    });
    const observeTail = () => {
      const cur = el.lastElementChild as HTMLElement | null;
      if (cur) ro.observe(cur);
    };
    observeTail();
    const mo = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          // 子集变化: 全量重挂(observe 幂等, 断链不可能)。
          ro.disconnect();
          observeTail();
        })
      : null;
    mo?.observe(el, { childList: true, subtree: false });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => {
    // R8-F2: 会话切换(非空→非空)同样清场——switchSession 直换 id 不经
    // null, 旧转录在 fetch 期间乃至失败后残留在新 id 下, 脏 busy 把新
    // 消息误路由为 steer(违反本 effect 自述的 skeleton-not-stale)。
    setMessages([]);
    setLoaded(false);
    setBusy(false);
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    setLoaded(false);
    // A fresh session starts in follow mode (also re-arms after the user
    // scrolled up in the PREVIOUS session).
    stickToBottom.current = true;
    setError('');  // stale errors must never follow the user across sessions
    (async () => {
      try {
        const detail = await api<ApiSessionDetail>(`/sessions/${sessionId}`);  // CS68-F5: 单源
        if (cancelled) return;
        setMessages(detail.messages);
        setBusy(detail.busy);
        setWsId(detail.workSessionId ?? null);
        // SSE cursor starts AFTER the fetched history — replaying it would
        // duplicate every message on screen.
        lastSeq.current = detail.lastSeq ?? 0;
        setLoaded(true);
        scrollToBottom();
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
        // The runtime is in-memory (known limitation #1): a restart kills
        // every session id this browser still holds. Report upward so the
        // workspace re-bootstraps instead of showing a permanent error.
        // CS2-#3: 判 status 而非文案——错误文案中文化(A1)曾击穿此处
        // 正则, 恢复路径死代码化(错误文案也是一种跨层契约)。
        if ((err as { status?: number }).status === 404) {
          onGone?.();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, scrollToBottom, onGone]);

  useEffect(() => {
    if (!sessionId || !loaded) return;
    const reconcile = async () => {
      // FEBUGS-P1-2: 断流重连后拉详情对账——SSE 可能永久漏尾(半开
      // 连接), 以服务端真值覆盖本地(含 busy 真值), 消息按 seq 去重合并。
      try {
        const d = await api<ApiSessionDetail>(`/sessions/${sessionId}`);
        setMessages(prev => {
          const seen = new Set(prev.map(x => x.ts));
          const merged = [...prev];
          for (const m2 of d.messages) if (!seen.has(m2.ts)) merged.push(m2);
          return merged;
        });
        setBusy(d.busy);
        lastSeq.current = Math.max(lastSeq.current, d.lastSeq ?? 0);
        // 用户令(10s 重置): 断流重连对账曾无条件拉底——EventSource 周期
        // 重连(~10s)即周期性拽回, 拖上去看历史每十秒被打断一次。
        // 只在用户仍处于跟随模式时钉底。
        if (stickToBottom.current) scrollToBottom();
      } catch { /* 对账失败: 下次重连再试 */ }
    };
    const off = subscribeSse(
      `/sessions/${sessionId}/events`,
      (name, raw) => {
        if (name !== 'session') return;
        const ev = raw as ApiSessionEvent;
        if (ev.seq <= lastSeq.current) return;
        lastSeq.current = ev.seq;
        const patchStreaming = (
          patch: (m: ApiMessage) => ApiMessage,
        ) => {
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
              next[next.length - 1] = patch(last);
            } else {
              next.push(patch({
                role: 'assistant', ts: Date.now(),
                text: '', thinking: '', streaming: true,
              }));
            }
            return next;
          });
        };
        if (ev.type === 'delta' && typeof ev.data?.delta === 'string') {
          // Text phase: extend the trailing bubble, demote thinking panel.
          patchStreaming(m => ({
            ...m,
            text: m.text + ev.data.delta,
            streamingThinking: false,
          }));
        } else if (ev.type === 'thinking' && typeof ev.data?.delta === 'string') {
          // Thinking phase: stream into the highlighted panel.
          patchStreaming(m => ({
            ...m,
            thinking: (m.thinking ?? '') + ev.data.delta,
            streamingThinking: true,
          }));
        } else if (ev.type === 'message' && ev.data?.role) {
          // CS41-C5/CS42-F2: 全字段透传(此前白名单重建丢 thinking/toolCalls/
          // toolCallId/tokens/stopReason/error——实时视图回归); role 已由
          // 分支条件守卫, ts/text 兜底。
          const msg = { ...ev.data, role: ev.data.role!, ts: ev.data.ts ?? Date.now(), text: ev.data.text ?? '' } as ApiMessage;
          setMessages(prev => {
            // Final assistant text replaces its streaming placeholder.
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].role === 'assistant' && next[i].streaming) {
                next[i] = msg;
                return next;
              }
            }
            // R23-F4: echo 只消费带乐观标记的气泡——纯文本等值去重
            // 会吞掉 steer 等合法重复消息(与任一历史用户消息同文即
            // 被整条丢弃, 实时转录缺失, 重载才恢复)。匹配即清除标记。
            if (msg.role === 'user') {
              const i = next.findIndex(m =>
                m.role === 'user' && m.text === msg.text && m.__optimistic);
              if (i >= 0) {
                const copy = [...next];
                delete copy[i].__optimistic;
                return copy;
              }
            }
            return next.concat(msg);
          });
        } else if (ev.type === 'agent_start') {
          setBusy(true);
        } else if (ev.type === 'agent_end') {
          setBusy(false);
        } else if (ev.type === 'error') {
          setError(String(ev.data?.message ?? 'agent error'));
        }
      },
      () => lastSeq.current,
      reconcile,
    );
    return off;
  }, [sessionId, loaded, scrollToBottom]);

  const send = async (text: string, mode: 'prompt' | 'steer') => {
    if (!sessionId) return;
    setError('');
    const opTs = Date.now();
    if (mode === 'prompt') {
      setMessages(prev => [...prev, { role: 'user', ts: opTs, text, __optimistic: true }]);
    }
    try {
      const resp = await api<{ ok: boolean; message?: { role: 'user'; ts: number; text: string; source?: ApiMessage['source'] } }>(
        `/sessions/${sessionId}/${mode === 'prompt' ? 'messages' : 'steer'}`, {
        method: 'POST',
        json: { text },
      });
      // 方案A(乐观根治): 服务器回执带真实消息对象(服务端 ts)——立即
      // 转正乐观条, 不再单通道依赖 SSE 回显认领(SSE 断流窗口曾致
      // 乐观+真实双条, 用户实测)。
      if (mode === 'prompt' && resp?.message?.ts) {
        setMessages(prev => prev.map(m =>
          (m.role === 'user' && m.ts === opTs && m.text === text && m.__optimistic)
            ? { role: 'user', ts: resp.message!.ts, text, source: resp.message!.source }
            : m));
      }
    } catch (err) {
      // R8-F3: 回滚乐观气泡——失败的消息从未入账, 残留即转录造假。
      setMessages(prev => prev.filter(m =>
        !(m.role === 'user' && m.ts === opTs && m.text === text)));
      setError(String(err));
    }
  };

  const placeholder = agentKey === 'autopwn'
    ? '对 AutoPwn 编排器下令(可调度子智能体)…'
    : agentKey === '__child__'
      ? '向该子智能体插话(steering)…'
      : `对 ${agentKey} 下令…`;

  // First-paint batching + infinite scroll: a long transcript (80+
  // messages, 285KB detail) rendered in ONE synchronous commit blocked
  // the main thread for seconds. The window anchors at START-INDEX (not
  // the tail): streaming arrivals extend the tail without shifting the
  // history the user is reading (the old tail-window made the viewport
  // jump one slot per streamed message while reading up).
  //  - null  = tail-follow mode (newest WINDOW, streaming follows)
  //  - number= frozen start (user scrolled up; older history prepends
  //             via the sentinel's IntersectionObserver, anchored)
  useEffect(() => { setStartIdx(null); }, [sessionId]);
  const effectiveStart = startIdx ?? Math.max(0, messages.length - 30);
  // R23-F5: 起点落在 assistant(toolCalls) 与 toolResult 之间时配对
  // 断裂渲染成孤立'工具'步骤——回退越过前导 toolResult 使配对的
  // assistant 进入窗口。
  // 内部机理消息(系统一次性注入规则等)不进前端时间线——开源工具
  // 的注入管线对用户不可见(用户令)。API 侧仍可审计。
  const visible = useMemo(() => {
    const shown = messages.filter(m => m.source !== 'system-internal');
    let start = Math.max(0, effectiveStart - (messages.length - shown.length));
    while (start > 0 && shown[start]?.role === 'toolResult') start -= 1;
    return shown.slice(start);
  }, [messages, effectiveStart]);
  const olderCount = messages.filter(m => m.source !== 'system-internal').length - visible.length;
  // Hot path: streaming deltas patch `messages` every chunk — the item
  // rebuild is memoized and the bubbles below are memo'd so history
  // entries skip re-render; only the trailing streaming bubble re-renders.
  const items = useMemo(() => buildItems(visible, busy), [visible, busy]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const olderCountRef = useRef(0);
  olderCountRef.current = olderCount;  // react/refs 豁免: 渲染期写 ref 服务 SSE 闭包最新值
  const effectiveStartRef = useRef(0);
  effectiveStartRef.current = effectiveStart;  // react/refs 豁免: 渲染期写 ref 服务 SSE 闭包最新值

  // Prepend older history: freeze the viewport via the height-anchor so
  // the content the user is looking at does not move, then fill-check —
  // if the sentinel is still on screen (60 short messages may not fill
  // the viewport), keep loading until it is pushed out or exhausted.
  const loadOlder = useCallback(() => {
    if (olderCountRef.current <= 0) return;
    const el = scrollRef.current;
    const anchor = el ? el.scrollHeight - el.scrollTop : 0;
    setStartIdx(Math.max(0, effectiveStartRef.current - 60));
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2 && anchor > 0) el2.scrollTop = el2.scrollHeight - anchor;
      const s = sentinelRef.current;
      if (s && s.getBoundingClientRect().top < window.innerHeight) {
        loadOlder();  // fill-check loop (bounded by olderCount)
      }
    });
  }, []);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;  // react/refs 豁免: 渲染期写 ref 服务 SSE 闭包最新值

  // Sentinel: fires ~600px BEFORE the top edge is reached — the load is
  // done by the time the user gets there (imperceptible).
  useEffect(() => {
    const s = sentinelRef.current;
    const root = scrollRef.current;
    if (!s || !root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) loadOlderRef.current();
    }, { root, rootMargin: '600px 0px 0px 0px' });
    io.observe(s);
    return () => io.disconnect();
  }, [sessionId, loaded]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="truncate text-xs font-medium text-secondary" title={sessionId ?? undefined}>
          {heading ?? sessionId ?? '会话'}
        </span>
        <span className={cn(
          'flex items-center gap-1.5 text-xs',
          busy ? 'text-warning-text' : 'text-tertiary',
        )}>
          <span className={cn(
            'h-1.5 w-1.5 rounded-full',
            busy ? 'animate-pulse bg-warning-text' : 'bg-faint',
          )} />
          {busy ? '运行中' : '空闲'}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden rounded-lg border border-line bg-bg p-3 [overflow-anchor:none]"  /* r50c: 横向禁滚——横条出现/消失改 clientHeight 与 RO re-pin 自激(滚动条秒级抖动) */
      >
        {!loaded && !error && (
          <div className="flex flex-col items-center gap-2 py-10">
            <Skeleton className="h-4 w-40" />
            <p className="text-[13px] text-tertiary">正在载入项目内容…</p>
          </div>
        )}
        <div ref={sentinelRef} className="py-0.5 text-center">
          {olderCount > 0 ? (
            <button
              onClick={() => loadOlderRef.current()}
              className="w-full rounded-md px-2 py-1 text-xs text-tertiary hover:text-tertiary"
            >
              ↑ 还有 {olderCount} 条更早消息（滚动自动加载）
            </button>
          ) : loaded && messages.length > 30 ? (
            <span className="text-xs text-tertiary">已到最早消息</span>
          ) : null}
        </div>
        {loaded && messages.length === 0 && (
          <EmptyState
            icon={Bot}
            title="会话已就绪"
            hint="向该智能体下达指令"
          />
        )}
        {items.map((item, i) => item.kind === 'bubble' ? (
          <MessageBubble key={`b-${item.message.ts}-${i}`} message={item.message} />
        ) : (
          <ToolTimeline key={`t-${item.steps[0]?.key}-${i}`} steps={item.steps} />
        ))}
        {/* 用户令(r47c): 授权确认卡=会话消息流内的交互消息(非页面横幅) */}
        {agentKey === 'autopwn' && <ScopeAuthCard wsId={wsId} />}
        {busy && (
          <div className="flex items-center gap-2 px-1 text-[13px] text-tertiary">
            <Bot className="h-4 w-4 animate-pulse" />
            {/* FE-B2(用户报): 多工具并行期恒显"思考中"像卡死——按尾块
                分相: 尾块为含在途步骤的活动块时显示工具进度 n/m(步骤
                行内已有各自 spinner), 否则才是思考中。 */}
            <span className="animate-pulse">
              {(() => {
                const tail = items[items.length - 1];
                if (tail?.kind === 'activity') {
                  const done = tail.steps.filter(st => st.result).length;
                  const total = tail.steps.length;
                  if (done < total) return `执行工具中 ${done}/${total}…`;
                }
                return '思考中…';
              })()}
            </span>
          </div>
        )}
        {error && (
          <p className="rounded-md border border-danger-line bg-danger-bg px-2 py-1 text-[13px] text-danger-text">
            {error}
          </p>
        )}
      </div>

      <ChatInput placeholder={placeholder} busy={busy} onSend={send} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool activity rendering: ONE generic pattern for every tool, present and
// future — zero per-tool frontend code. Consecutive calls+results collapse
// into a timeline strip (方案B); each step expands in place (方案A).
// ---------------------------------------------------------------------------

interface ToolStep {
  key: string;
  name: string;
  args?: unknown;
  result?: ApiMessage;
  running: boolean;
}

type RenderItem =
  | { kind: 'bubble'; message: ApiMessage }
  | { kind: 'activity'; steps: ToolStep[] };

/** Group consecutive tool calls/results into activity blocks; pair results
 *  to their calls by toolCallId. Narrative text / user / DM messages break
 *  the group and render as ordinary bubbles. */
function buildItems(messages: ApiMessage[], busy: boolean): RenderItem[] {
  const items: RenderItem[] = [];
  // R23-F3: 前沿索引=最后一个非 toolResult 消息——尾部始终延伸,
  // 只有前沿的未配对调用才真正在途。
  let frontierIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'toolResult') { frontierIdx = i; break; }
  }
  let steps: ToolStep[] | null = null;
  const flush = () => {
    if (steps && steps.length) items.push({ kind: 'activity', steps });
    steps = null;
  };
  messages.forEach((m, idx) => {
    if (m.role === 'toolResult') {
      const call = steps?.find(s => !s.result && s.key.endsWith(`#${m.toolCallId}`));
      if (call) {
        call.result = m;
        call.running = false;
      } else {
        (steps ??= []).push({
          key: `r-${m.ts}-${idx}`, name: '工具', result: m, running: false,
        });
      }
      return;
    }
    if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) {
      // Narrative + calls in one message: the text is its own bubble first.
      if ((m.text ?? '').trim() || m.streaming) {
        flush();
        items.push({ kind: 'bubble', message: m });
      }
      for (const tc of m.toolCalls ?? []) {
        (steps ??= []).push({
          key: `${m.ts}#${tc.id ?? tc.name ?? idx}`,
          name: tc.name ?? '工具',
          args: tc.args,
          // R23-F3: running=前沿派生——此前全局 busy 让历史残留的
          // 未配对调用在新运行时全部复活转圈(空闲时亦然)。
          running: busy && idx === frontierIdx,
        });
      }
      return;
    }
    flush();
    items.push({ kind: 'bubble', message: m });
  });
  flush();
  return items;
}

const ToolTimeline = memo(function ToolTimeline({ steps }: { steps: ToolStep[] }) {
  const errorSteps = steps.filter(s => s.result?.isError);
  const anyRunning = steps.some(s => s.running && !s.result);
  const [open, setOpen] = useState(errorSteps.length > 0);
  const [detail, setDetail] = useState<string | null>(errorSteps[0]?.key ?? null);

  const counts = new Map<string, number>();
  steps.forEach(s => counts.set(s.name, (counts.get(s.name) ?? 0) + 1));
  const summary = [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');

  return (
    <div className="max-w-[92%]">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left transition-colors',
          errorSteps.length
            ? 'border-danger-line bg-danger-bg hover:brightness-95'
            : 'border-line-strong bg-surface hover:border-accent',
        )}
      >
        {anyRunning
          ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-warning-text" />
          : errorSteps.length
            ? <X className="h-4 w-4 shrink-0 text-danger-text" />
            : <Check className="h-4 w-4 shrink-0 text-success-text" />}
        <span className="shrink-0 text-[13px] text-secondary">
          工具执行 · {steps.length} 步
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
          {summary}
        </span>
        {errorSteps.length > 0 && (
          <span className="shrink-0 rounded-md border border-danger-line bg-danger-bg px-1 text-xs text-danger-text">
            {errorSteps.length} 错误
          </span>
        )}
        <ChevronDown className={cn(
          'h-4 w-4 shrink-0 text-faint transition-transform',
          open && 'rotate-180',
        )} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="relative ml-2.5 mt-1 flex flex-col gap-0.5 border-l border-line pl-4">
            {steps.map(s => (
              <ToolStepRow
                key={s.key}
                step={s}
                open={detail === s.key}
                onToggle={() => setDetail(detail === s.key ? null : s.key)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

function ToolStepRow({ step, open, onToggle }: {
  step: ToolStep;
  open: boolean;
  onToggle: () => void;
}) {
  const err = step.result?.isError;
  const pending = step.running;  // R23-F3: 行级 pending 由前沿派生(running 非 optional, ?? 右臂死——CS3-N20)
  const firstLine = (step.result?.text ?? '')
    .split('\n').find(l => l.trim()) ?? '';
  const argsJson = step.args != null && typeof step.args === 'object'
    && Object.keys(step.args as object).length > 0
    ? JSON.stringify(step.args, null, 1) : null;

  return (
    <div className="relative">
      <span className={cn(
        'absolute -left-[21px] top-[9px] h-1.5 w-1.5 rounded-full ring-2 ring-bg',
        pending ? 'animate-pulse bg-warning-text' : err ? 'bg-danger-text' : 'bg-success-text',
      )} />
      <button
        onClick={onToggle}
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
      >
        {pending
          ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-warning-text" />
          : err
            ? <X className="h-4 w-4 shrink-0 text-danger-text" />
            : <Check className="h-4 w-4 shrink-0 text-success-text" />}
        <span className={cn(
          'shrink-0 font-mono text-xs',
          err ? 'text-danger-text' : 'text-primary',
        )}>
          {step.name}
        </span>
        {pending && (
          <span className="shrink-0 text-xs text-warning-text">运行中…</span>
        )}
        {!open && firstLine && (
          <span className="min-w-0 flex-1 truncate text-[13px] text-tertiary">
            {firstLine}
          </span>
        )}
        <ChevronDown className={cn(
          'ml-auto h-4 w-4 shrink-0 text-faint transition-transform',
          open && 'rotate-180',
        )} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="mb-1 ml-1 rounded-md border border-line bg-bg p-2">
            {argsJson && (
              <pre className="mb-1.5 overflow-x-auto whitespace-pre-wrap break-all border-b border-line pb-1.5 font-mono text-xs leading-relaxed text-tertiary">
                {argsJson.slice(0, 600)}
              </pre>
            )}
            <div className="max-h-64 overflow-y-auto text-sm leading-relaxed text-secondary">
              {step.result
                ? <Markdown>{step.result.text || '(空)'}</Markdown>
                : <span className="text-xs text-tertiary">等待结果…</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

type MessageKind = 'user' | 'dm' | 'system' | 'assistant';

const DM_PREFIX_RE = /^\[DM from ([a-z0-9_-]+)\]\s*/;

/** Legacy transcripts (pre-source-tagging): recognize system injections
 *  by our own emission prefixes so old sessions also render correctly. */
const SYSTEM_INJECT_RE = /^\[engagement |^【系统要求】|^【派生任务|^【AutoPwn 任务/;

function classify(message: ApiMessage): MessageKind {
  if (message.role === 'user') {
    // Origin metadata first — a system-injected user-role turn must never
    // render as the human user ("why is the agent talking as me" bug).
    if (message.source === 'agent') return 'dm';
    if (message.source === 'system') return 'system';
    if (message.source === 'user') return 'user';
    if (DM_PREFIX_RE.test(message.text)) return 'dm';
    if (SYSTEM_INJECT_RE.test(message.text)) return 'system';
    return 'user';
  }
  if (message.role === 'assistant') {
    return 'assistant';
  }
  return 'system';
}

const MessageBubble = memo(function MessageBubble({ message }: { message: ApiMessage }) {
  const kind = classify(message);

  if (kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-line bg-accent-subtle px-3 py-2">
          <div className="mb-0.5 flex items-center justify-end gap-1 text-xs text-tertiary">
            <span>you</span>
            <User className="h-3 w-3" />
          </div>
          <div className="text-sm text-primary">
            <Markdown>{message.text}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // agent ⇄ agent DM: left side, info accent
  if (kind === 'dm') {
    const from = message.text.match(DM_PREFIX_RE)?.[1] ?? 'agent';
    const body = message.text.replace(DM_PREFIX_RE, '');
    return (
      <div className="max-w-[92%]">
        <div className="rounded-lg border border-info-line bg-info-bg px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-xs text-info-text">
            <span className="h-1 w-1 rounded-full bg-info-text" />
            {from} ⇄ 本智能体
          </div>
          <div className="text-sm text-primary">
            <Markdown>{body}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // R32D44-P1-2: LLM 失败回合可见化——后端把 fail-fast(未配置大模型)
  // 与流异常放在 assistant.error/stopReason=error, 此前全仓无渲染点,
  // 用户只看到空气泡+空闲。红色横幅给出可行动错误。
  if (message.error) {
    const errMsg = message.error;
    return (
      <div className="max-w-[92%]">
        <div className="rounded-lg border border-danger-line bg-danger-bg px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-danger-text">
            <TriangleAlert className="h-4 w-4" /> 本轮失败
          </div>
          <div className="text-[13px] leading-relaxed text-danger-text">{errMsg}</div>
          {/* R32D46-NEW-1: 入口无条件——pi-ai 把连接错/HTTP 5xx 转成流
              error 事件而非异常, 后端 thrown 注解对这些通道不可达(断供应
              商场景此前零入口); 任何失败回合都给设置页指路。 */}
          <a href="#settings" className="mt-1.5 inline-block text-[13px] text-accent-text underline underline-offset-2">
            检查大模型配置(设置页) →
          </a>
        </div>
      </div>
    );
  }

  // system injections (engagement lifecycle, nudges, spawn tasks):
  // left side, dashed neutral — never rendered as the human user
  if (kind === 'system') {
    return (
      <div className="max-w-[92%]">
        <div className="rounded-lg border border-dashed border-line bg-surface px-3 py-2">
          <div className="mb-0.5 text-xs text-tertiary">
            系统
          </div>
          <div className="text-[13px] text-secondary">
            <Markdown>{message.text}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // Thinking-only phase(部分厂商如 GLM streams reasoning BEFORE any text): the
  // reply box would sit empty for the entire thinking duration — reads
  // as "content missing". The thinking panel + footer pulse already
  // express the state; the box appears when the first text delta lands.
  if (message.streaming && message.streamingThinking === true && !message.text) {
    return (
      <div className="max-w-[92%]">
        <ThinkingBlock thinking={message.thinking} active />
      </div>
    );
  }

  // assistant reply
  return (
     <div className="max-w-[92%]">
       <ThinkingBlock
         thinking={message.thinking}
         active={message.streamingThinking === true}
       />
       <div className="rounded-lg border border-line bg-surface px-3 py-2">
        <div className="mb-0.5 flex items-center gap-1 text-xs text-tertiary">
          <Bot className="h-3 w-3" /> agent
          {message.tokens !== undefined && !message.streaming && (
            <span className="ml-1 font-mono tabular-nums">{message.tokens} tok</span>
          )}
          {message.streaming && (
            <span className="ml-1 animate-pulse font-mono text-accent-text/70">
              ▍streaming
            </span>
          )}
        </div>
        <Markdown>
          {message.text + (message.streaming ? ' ▍' : '')}
        </Markdown>
      </div>
    </div>
  );
});

/**
 * Reasoning panel: fully expanded while streaming (no height cap — a
 * 10k-line think shows everything, only the page scroll limits it), and
 * AUTO-COLLAPSES to the summary line when the stream ends
 * (`open={open || active}`: active goes false → details closes unless
 * the user re-opens it afterwards). Hook order: useState must run before
 * the early return (a thinking='' → 'text' transition would otherwise
 * change the hook count mid-instance).
 */
function ThinkingBlock({ thinking, active }: { thinking?: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  if (!thinking) return null;
  return (
    <details
      open={open || active}
      onToggle={e => setOpen((e as React.SyntheticEvent<HTMLDetailsElement>).currentTarget.open)}
      className="mb-1 rounded-md border border-line bg-surface-2"
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1 px-2.5 py-1 text-xs text-tertiary">
        <ChevronDown className={cn('h-4 w-4 transition-transform', (open || active) && 'rotate-180')} />
        思考过程 {active ? '· streaming' : ''}
      </summary>
      <div className="whitespace-pre-wrap border-t border-line px-2.5 py-1.5 text-[13px] leading-relaxed text-secondary">
        {thinking}
      </div>
    </details>
  );
}
