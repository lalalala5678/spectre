import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Loader2, User, X } from 'lucide-react';

import {
  api,
  subscribeSse,
  type ApiMessage,
  type ApiSessionEvent,
} from '../../api/client';
import { ChatInput } from './ChatInput';
import { Markdown } from './Markdown';
import { cn } from '../../utils/cn';

/**
 * Live pi session view (controlled): the workspace owns which session is
 * open; this component renders it, streams journal events via SSE, and
 * sends prompts / steering messages.
 */
export function LiveSession({ agentKey, sessionId, onGone }: {
  agentKey: string;
  sessionId: string | null;
  onGone?: () => void;
}) {
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const lastSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Infinite-scroll window state — declared early: handleScroll (below)
  // freezes the start index when the user leaves the bottom.
  const [startIdx, setStartIdx] = useState<number | null>(null);
  const messagesLenRef = useRef(0);
  messagesLenRef.current = messages.length;
  // Follow intent: the USER decides. At the bottom → stick; scrolled up
  // to read → release; scrolled back down → re-stick. Scroll events are
  // the only source of truth — never a distance probe at event-arrival
  // time (the old followIfNearBottom ran BEFORE React committed the new
  // content, so its scrollHeight was stale and any single commit growing
  // past the 120px threshold — thinking panel first appearance is 224px
  // capped — detached the follow permanently with no way back).
  const stickToBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottom.current = nearBottom;
    // Freeze the window start the moment the user leaves the bottom:
    // streaming arrivals then extend the tail instead of shifting the
    // history being read (tail-window drift fix). Returning to the
    // bottom re-enters tail-follow mode (null state is a no-op there).
    setStartIdx(prev => {
      if (nearBottom) return null;
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
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, loaded, error]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (!sessionId) {
      // Project switch stage: clear the previous project's transcript so
      // the skeleton (not stale content) shows while bootstrapping.
      setMessages([]);
      setLoaded(false);
      setBusy(false);
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
        const detail = await api<{
          messages: ApiMessage[]; busy: boolean; lastSeq?: number;
        }>(`/sessions/${sessionId}`);
        if (cancelled) return;
        setMessages(detail.messages);
        setBusy(detail.busy);
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
        if (/no such session/i.test(String(err))) {
          onGone?.();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, scrollToBottom, onGone]);

  useEffect(() => {
    if (!sessionId || !loaded) return;
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
          const msg = ev.data as unknown as ApiMessage;
          setMessages(prev => {
            // Final assistant text replaces its streaming placeholder.
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].role === 'assistant' && next[i].streaming) {
                next[i] = msg;
                return next;
              }
            }
            // Optimistically-shown user prompts arrive once via SSE;
            // drop the echo so they never display twice.
            if (msg.role === 'user' && next.some(
              m => m.role === 'user' && m.text === msg.text,
            )) {
              return next;
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
    );
    return off;
  }, [sessionId, loaded]);

  const send = async (text: string, mode: 'prompt' | 'steer') => {
    if (!sessionId) return;
    setError('');
    if (mode === 'prompt') {
      setMessages(prev => [...prev, { role: 'user', ts: Date.now(), text }]);
    }
    try {
      await api(`/sessions/${sessionId}/${mode === 'prompt' ? 'messages' : 'steer'}`, {
        method: 'POST',
        json: { text },
      });
    } catch (err) {
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
  const olderCount = effectiveStart;
  const visible = useMemo(() => messages.slice(effectiveStart),
    [messages, effectiveStart]);
  // Hot path: streaming deltas patch `messages` every chunk — the item
  // rebuild is memoized and the bubbles below are memo'd so history
  // entries skip re-render; only the trailing streaming bubble re-renders.
  const items = useMemo(() => buildItems(visible, busy), [visible, busy]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const olderCountRef = useRef(0);
  olderCountRef.current = olderCount;
  const effectiveStartRef = useRef(0);
  effectiveStartRef.current = effectiveStart;

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
  loadOlderRef.current = loadOlder;

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
        <span className="truncate font-mono text-[10px] text-zinc-600">
          {sessionId ?? 'no session'}
        </span>
        <span className={cn(
          'flex items-center gap-1.5 text-[10px]',
          busy ? 'text-orange-400' : 'text-zinc-600',
        )}>
          <span className={cn(
            'h-1.5 w-1.5 rounded-full',
            busy ? 'animate-pulse bg-orange-400' : 'bg-zinc-700',
          )} />
          {busy ? '运行中' : '空闲'}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded border border-void-700 bg-void-950 p-3"
      >
        {!loaded && !error && (
          <div className="flex flex-col items-center gap-2 py-10">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
            <p className="animate-pulse text-[11.5px] text-zinc-500">正在载入项目内容…</p>
          </div>
        )}
        <div ref={sentinelRef} className="py-0.5 text-center">
          {olderCount > 0 ? (
            <button
              onClick={() => loadOlderRef.current()}
              className="w-full rounded-sm px-2 py-1 text-[10.5px] text-zinc-600 hover:text-zinc-400"
            >
              ↑ 还有 {olderCount} 条更早消息（滚动自动加载）
            </button>
          ) : loaded && messages.length > 30 ? (
            <span className="text-[10px] text-zinc-700">已到最早消息</span>
          ) : null}
        </div>
        {loaded && messages.length === 0 && (
          <p className="py-8 text-center text-[11px] text-zinc-700">
            会话已就绪 — 向该智能体下达指令
          </p>
        )}
        {items.map((item, i) => item.kind === 'bubble' ? (
          <MessageBubble key={`b-${item.message.ts}-${i}`} message={item.message} />
        ) : (
          <ToolTimeline key={`t-${item.steps[0]?.key}-${i}`} steps={item.steps} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 px-1 text-[11px] text-zinc-600">
            <Bot className="h-3 w-3 animate-pulse" />
            <span className="animate-pulse">思考中…</span>
          </div>
        )}
        {error && (
          <p className="rounded-sm border border-red-900 bg-red-950/30 px-2 py-1 text-[11px] text-red-400">
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
          running: busy,
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
            ? 'border-red-900/60 bg-red-950/15 hover:border-red-700'
            : 'border-void-700 bg-void-900/60 hover:border-void-500',
        )}
      >
        {anyRunning
          ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-orange-400" />
          : errorSteps.length
            ? <X className="h-3 w-3 shrink-0 text-red-400" />
            : <Check className="h-3 w-3 shrink-0 text-emerald-500/90" />}
        <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">
          工具执行 · {steps.length} 步
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
          {summary}
        </span>
        {errorSteps.length > 0 && (
          <span className="shrink-0 rounded-sm border border-red-800 px-1 font-mono text-[9px] text-red-300">
            {errorSteps.length} 错误
          </span>
        )}
        <ChevronDown className={cn(
          'h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform',
          open && 'rotate-180',
        )} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="relative ml-2.5 mt-1 flex flex-col gap-0.5 border-l border-void-700 pl-4">
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
  const pending = !step.result;
  const firstLine = (step.result?.text ?? '')
    .split('\n').find(l => l.trim()) ?? '';
  const argsJson = step.args != null && typeof step.args === 'object'
    && Object.keys(step.args as object).length > 0
    ? JSON.stringify(step.args, null, 1) : null;

  return (
    <div className="relative">
      <span className={cn(
        'absolute -left-[21px] top-[9px] h-1.5 w-1.5 rounded-full ring-2 ring-void-950',
        pending ? 'animate-pulse bg-orange-400' : err ? 'bg-red-500' : 'bg-emerald-500/80',
      )} />
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-void-800/60"
      >
        {pending
          ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-orange-400/80" />
          : err
            ? <X className="h-3 w-3 shrink-0 text-red-400/90" />
            : <Check className="h-3 w-3 shrink-0 text-emerald-500/70" />}
        <span className={cn(
          'shrink-0 font-mono text-[11px]',
          err ? 'text-red-300' : 'text-zinc-300',
        )}>
          {step.name}
        </span>
        {pending && (
          <span className="shrink-0 font-mono text-[9.5px] text-orange-400/80">运行中…</span>
        )}
        {!open && firstLine && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600">
            {firstLine}
          </span>
        )}
        <ChevronDown className={cn(
          'ml-auto h-3 w-3 shrink-0 text-zinc-700 transition-transform',
          open && 'rotate-180',
        )} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="mb-1 ml-1 rounded-sm border border-void-800 bg-void-950/70 p-2">
            {argsJson && (
              <pre className="mb-1.5 overflow-x-auto whitespace-pre-wrap break-all border-b border-void-800 pb-1.5 font-mono text-[10.5px] leading-relaxed text-orange-200/50">
                {argsJson.slice(0, 600)}
              </pre>
            )}
            <div className="max-h-64 overflow-y-auto text-[12px] leading-relaxed text-zinc-400">
              {step.result
                ? <Markdown>{step.result.text || '(空)'}</Markdown>
                : <span className="font-mono text-[11px] text-zinc-600">等待结果…</span>}
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
        <div className="max-w-[85%] rounded-sm border border-void-500 bg-void-800 px-3 py-2">
          <div className="mb-0.5 flex items-center justify-end gap-1 text-[9.5px] text-zinc-600">
            <span className="font-mono uppercase tracking-widest">you</span>
            <User className="h-2.5 w-2.5" />
          </div>
          <div className="text-[13px] text-zinc-200">
            <Markdown>{message.text}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // agent ⇄ agent DM: left side, sky accent
  if (kind === 'dm') {
    const from = message.text.match(DM_PREFIX_RE)?.[1] ?? 'agent';
    const body = message.text.replace(DM_PREFIX_RE, '');
    return (
      <div className="max-w-[92%]">
        <div className="rounded-sm border border-sky-800/70 bg-sky-950/20 px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-widest text-sky-400/80">
            <span className="h-1 w-1 rounded-full bg-sky-500" />
            {from} ⇄ 本智能体
          </div>
          <div className="text-[13px] text-zinc-300">
            <Markdown>{body}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // system injections (engagement lifecycle, nudges, spawn tasks):
  // left side, dashed neutral — never rendered as the human user
  if (kind === 'system') {
    return (
      <div className="max-w-[92%]">
        <div className="rounded-sm border border-dashed border-zinc-700 bg-void-900/60 px-3 py-2">
          <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-widest text-zinc-500">
            系统
          </div>
          <div className="text-[12.5px] text-zinc-400">
            <Markdown>{message.text}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  // Thinking-only phase (GLM streams reasoning BEFORE any text): the
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
       <div className="rounded-sm border border-void-600 bg-void-900 px-3 py-2">
        <div className="mb-0.5 flex items-center gap-1 text-[9.5px] text-zinc-600">
          <Bot className="h-2.5 w-2.5" /> agent
          {message.tokens !== undefined && !message.streaming && (
            <span className="ml-1 font-mono">{message.tokens} tok</span>
          )}
          {message.streaming && (
            <span className="ml-1 animate-pulse font-mono text-orange-400/70">
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
      className="mb-1 rounded-sm border border-orange-900/40 bg-orange-950/10"
    >
      <summary className="cursor-pointer select-none px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-widest text-orange-400/70">
        思考过程 {active ? '· streaming' : ''}
      </summary>
      <div className="whitespace-pre-wrap border-t border-orange-900/30 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-orange-200/40">
        {thinking}
      </div>
    </details>
  );
}
