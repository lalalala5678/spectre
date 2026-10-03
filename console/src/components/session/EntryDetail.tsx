import { useEffect, useMemo, useState } from 'react';
import { CornerUpLeft, History, Loader2, PencilLine, SendHorizontal } from 'lucide-react';

import {
  api, foldEntries, reviseEntryDirect, reviseEntryViaAgent, subscribeBus,
  type ApiBusEvent,
} from '../../api/client';
import { Markdown } from './Markdown';
import { SeverityBadge, StatusBadge } from './VulnPanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input, Textarea, Select, Label } from '../ui/Input';
import { cn } from '../../utils/cn';
import { stripEventTitle } from './eventTitle';

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const STATUSES = ['success', 'partial', 'failed', 'no-result'] as const;

/**
 * Entry detail view (漏洞 / 情报 / 任务报告). Shows the CURRENT version
 * (folds the revision chain — newest revision wins, originals stay
 * auditable). Two user revision paths:
 *   · dialog — natural-language instruction routed to the writer
 *     (vulns → the ORIGINAL writer session; notes/reports → fresh writer)
 *   · direct edit — form edit, human is the final authority, lands now
 */
export function EntryDetail({ event, onBack, onOpenSession }: {
  event: ApiBusEvent;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const isReport = event.type === 'task-report';
  const isNote = event.type === 'intel-note';
  const isVuln = !isReport && !isNote;

  // Live revision chain: refetch on any bus event that revises this seq.
  const [chain, setChain] = useState<ApiBusEvent[]>([]);
  const [dialogText, setDialogText] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [writerSessionId, setWriterSessionId] = useState<string | null>(null);
  const [dialogDone, setDialogDone] = useState('');
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);

  // R16-F1: 孤儿条目(原始已被 journal 裁剪, 面板折叠推送的是修订自身,
  // revises=原seq)——锚定 event.seq 只命中自己, 同源兄弟修订全漏(修
  // 订历史永不渲染+SSE 不刷新)。统一锚 rootSeq。
  const rootSeq = event.revises ?? event.seq;
  const loadChain = async () => {
    try {
      const all = await api<ApiBusEvent[]>('/bus'
        + (event.workSessionId ? `?ws=${event.workSessionId}` : ''));
      setChain(all.filter(e => e.seq === rootSeq || e.revises === rootSeq));
    } catch { /* SSE will heal */ }
  };
  // loadChain 每渲染新引用; 语义=根 seq 变化重取修订链
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadChain(); }, [rootSeq]);
  useEffect(() => subscribeBus((name, raw) => {
    if (name !== 'bus') return;
    const e = raw as ApiBusEvent;
    if (e.revises === rootSeq) {
      void loadChain();
      setDialogDone(`修订已落账（第 ${e.revision?.n ?? '?'} 次）`);
      setDialogBusy(false);
    }
  // 同上(loadChain 闭包)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rootSeq]);

  const folded = useMemo(
    () => foldEntries(chain)[0] ?? { ...event, current: event, revisedCount: 0 },
    [chain, event]);
  /** R16-F2: 孤儿=原始条目已随 journal 裁剪(foldEntries 标记或修订
   * 事件直入)——后端 revise 系按 !e.revises 找原始, 恒 404。 */
  const isOrphan = folded.orphaned === true || event.revises != null;
  const current = folded.current;
  const severity = current.severity ?? 'info';
  const title = current.title
    ?? stripEventTitle(current.summary, Infinity);  // CS44-F9: 单源(详情不截)
  const revisions = useMemo(
    () => chain.filter(e => e.revises === rootSeq)
      .sort((a, b) => (b.revision?.n ?? 0) - (a.revision?.n ?? 0)),
    [chain, rootSeq]);

  const submitDialog = async () => {
    if (!dialogText.trim() || dialogBusy) return;  // FEBUGS-P2-3: Enter 绕过 busy 守卫可重复提交
    setDialogBusy(true); setDialogDone('');
    try {
      const r = await reviseEntryViaAgent(event.seq, dialogText.trim());
      setDialogDone(`已提交报告智能体，撰写中…（落账后自动刷新；若被驳回，` +
        `点此查看撰写对话的判定理由）`);
      setWriterSessionId(r.sessionId);
      // R3-4: 拒绝路径解除——后端 revise-request 只回 202, writer 驳回
      // 不产生修订事件(原实现仅靠 revises SSE 解除 busy, 驳回=永久旋转)。
      // 轮询 writer 会话: 回合结束(busy=false)且修订未落账 → 提示判定。
      void (async () => {
        const sid = r.sessionId;
        for (let i = 0; i < 30; i++) {
          await new Promise(rr => setTimeout(rr, 4000));
          try {
            const st = await api<{ busy: boolean }>(`/sessions/${sid}`);
            if (!st.busy) {
              setDialogBusy(false);
              setDialogDone(prev => prev.includes('已提交报告智能体')
                ? `${prev}\n撰写回合已结束——若上方条目未更新即被驳回, 点开撰写对话查看判定理由`
                : prev);
              return;
            }
          } catch { /* 会话读取失败继续轮询 */ }
        }
        setDialogBusy(false);  // 120s 兜底解除
      })();
    } catch (err) {
      setDialogDone(`提交失败:${String(err)}`);
      setDialogBusy(false);
    }
  };
  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col gap-2">
      <Button onClick={onBack} variant="secondary" size="sm" className="w-fit">
        <CornerUpLeft className="h-3.5 w-3.5" /> 返回对话
      </Button>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border border-line bg-bg p-4">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          {isReport && <StatusBadge status={current.status ?? 'no-result'} />}
          {isNote && (
            <Badge tone="info">情报</Badge>
          )}
          {isVuln && <SeverityBadge severity={severity} />}
          <h2 className={cn('text-[15px] font-semibold text-primary', folded.current.void && 'text-tertiary line-through')}>
            {isReport ? `任务报告 · ${title}` : isNote ? `情报 · ${title}` : title}
          </h2>
          {Boolean(folded.current.void) && (
            <Badge tone="neutral" className="line-through">已作废</Badge>
          )}
          {folded.revisedCount > 0 && (
            <Badge tone="info" className="tabular-nums">⟳ 已修订 {folded.revisedCount} 次</Badge>
          )}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-3 border-b border-line pb-2 font-mono text-xs tabular-nums text-tertiary">
          <span>seq={event.seq}</span>
          <span>{current.ts.replace('T', ' ').slice(0, 19)}</span>
          <span>from: {current.from}</span>
          {current.author && (
            <span title={current.author.treePath}>
              {current.author.name}（{current.author.typeLabel} · L{current.author.depth}）
            </span>
          )}
          {current.engagement && <span>{current.engagement}</span>}
          {current.payloadRef && <span>{current.payloadRef}</span>}
          {current.requester && (
            <span title={current.requester.treePath}>
              发现者: {current.requester.name}（{current.requester.typeLabel}）
            </span>
          )}
        </div>

        {isVuln && current.payloadRef?.startsWith('sess:') && onOpenSession && (
          <Button
            onClick={() => onOpenSession(current.payloadRef!.slice(5))}
            variant="secondary"
            size="sm"
            className="w-fit"
          >
            查看撰写对话（思考 · 工具调用 · 验证过程）
          </Button>
        )}

        {/* revision history */}
        {revisions.length > 0 && (
          <details className="rounded-lg border border-info-line bg-info-bg">
            <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-info-text">
              <History className="h-3 w-3" /> 修订历史（{revisions.length}）
            </summary>
            <div className="space-y-2 border-t border-info-line px-3 py-2">
              {revisions.map(r => (
                <div key={r.seq} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums text-tertiary">
                    <span>第 {r.revision?.n ?? '?'} 次 · {r.ts.replace('T', ' ').slice(5, 16)}</span>
                    {r.revision?.requestedBy && (
                      <span>申请: {r.revision.requestedBy.name}</span>
                    )}
                    {r.revision?.approvedBy && (
                      <span>核准: {r.revision.approvedBy.name}</span>
                    )}
                  </div>
                  {r.revision?.reason && (
                    <p className="mt-0.5 text-xs text-tertiary">
                      理由:{r.revision.reason}
                    </p>
                  )}
                  <p className="mt-0.5 truncate text-[13px] text-secondary">
                    现行标题:《{r.title ?? ''}》
                    {r.severity ? ` · ${r.severity}` : r.status ? ` · ${r.status}` : ''}
                  </p>
                </div>
              ))}
              <details className="px-1">
                <summary className="cursor-pointer text-xs text-tertiary">
                  原始版本（seq={event.seq}）
                </summary>
                <div className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] leading-relaxed text-tertiary">
                  《{event.title ?? event.summary}》
                  {event.detail ? `\n\n${event.detail}` : ''}
                </div>
              </details>
            </div>
          </details>
        )}

        {editing ? (
          <EditForm
            kind={isReport ? 'report' : isNote ? 'note' : 'vuln'}
            current={current}
            busy={editBusy}
            onCancel={() => setEditing(false)}
            onSave={async fields => {
              setEditBusy(true);
              try {
                // FEVERIFY-C3(P2-4): 直接编辑基于打开时快照——并发修订后
                // 旧快照整包保存会静默覆盖他人版本。保存前拉链比对基线
                // revision.n, 落后即阻断提示。
                const baseN = current.revision?.n ?? 0;
                const fresh = await api<ApiBusEvent[]>('/bus'
                  + (event.workSessionId ? `?ws=${event.workSessionId}` : ''));
                const freshChain = fresh.filter((e: ApiBusEvent) =>
                  e.seq === rootSeq || e.revises === rootSeq);
                const latest = freshChain.reduce((m: number, e: ApiBusEvent) =>
                  Math.max(m, e.revision?.n ?? 0), 0);
                if (latest > baseN) {
                  alert(`该条目已被并发修订(当前 v${latest}, 你基于 v${baseN})——关闭编辑重新打开后再改`);
                  setEditing(false);
                  return;
                }
                await reviseEntryDirect(event.seq, fields,
                  '用户直接编辑', current.workSessionId ?? null);
                setEditing(false);
              } catch (err) {
                alert(`保存失败:${String(err)}`);
              } finally {
                setEditBusy(false);
              }
            }}
          />
        ) : (
          <>
            {current.detail
              ? <Markdown>{current.detail}</Markdown>
              : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-secondary">
                  {current.summary}
                </p>
              )}
            {!isOrphan && (
              <Button onClick={() => setEditing(true)} variant="secondary" size="sm" className="mt-1 w-fit">
                <PencilLine className="h-3 w-3" /> 直接编辑
              </Button>
            )}
            {isOrphan && (
              // R16-F2: 孤儿(原始已被裁剪)的后端 revise 恒 404——不渲染
              // 死按钮, 给一行诊断(拒则短痛)。
              <p className="mt-1 text-xs text-tertiary">
                原始条目已随消息日志裁剪, 修订链已封存(仅存档审计)
              </p>
            )}
          </>
        )}

        {/* dialog revision */}
        {isOrphan ? (
          <div className="mt-2 rounded-lg border border-line bg-surface p-3">
            <p className="text-xs text-tertiary">修订对话框不可用——原始条目已裁剪, 修订链封存(仅存档审计)</p>
          </div>
        ) : (
        <div className="mt-2 rounded-lg border border-line bg-surface p-3">
          <p className="mb-1.5 text-xs font-medium text-secondary">
            修订对话框 → 报告智能体{isVuln ? '（原撰写者审核）' : ''}
          </p>
          <div className="flex gap-2">
            <Input
              value={dialogText}
              onChange={e => setDialogText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitDialog(); }}
              placeholder="描述如何更改,如:severity 改为 high,补充 PoC 步骤…"
              className="min-w-0 flex-1"
            />
            <Button
              onClick={() => void submitDialog()}
              disabled={dialogBusy || !dialogText.trim()}
              variant="primary"
              size="sm"
            >
              {dialogBusy
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <SendHorizontal className="h-3 w-3" />}
              {dialogBusy ? '撰写中' : '提交'}
            </Button>
          </div>
          {dialogDone && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
              <p className={cn(dialogDone.includes('失败') ? 'text-danger-text' : 'text-info-text')}>
                {dialogDone}
              </p>
              {writerSessionId && onOpenSession && (
                <Button
                  onClick={() => onOpenSession(writerSessionId)}
                  variant="secondary"
                  size="sm"
                >
                  打开撰写对话
                </Button>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function EditForm({ kind, current, busy, onCancel, onSave }: {
  kind: 'vuln' | 'note' | 'report';
  current: ApiBusEvent;
  busy: boolean;
  onCancel: () => void;
  onSave: (fields: { title?: string; severity?: string; status?: string; text?: string }) => void;
}) {
  const [title, setTitle] = useState(current.title ?? '');
  const [severity, setSeverity] = useState(String(current.severity ?? 'info'));
  const [status, setStatus] = useState(String(current.status ?? 'success'));
  const [text, setText] = useState(current.detail ?? current.summary ?? '');
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <label className="block">
        <Label className="mb-1 block">标题</Label>
        <Input
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
      </label>
      <div className="flex gap-3">
        {kind === 'vuln' && (
          <label className="block">
            <Label className="mb-1 block">severity</Label>
            <Select
              value={severity}
              onChange={e => setSeverity(e.target.value)}
            >
              {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </label>
        )}
        {kind === 'report' && (
          <label className="block">
            <Label className="mb-1 block">status</Label>
            <Select
              value={status}
              onChange={e => setStatus(e.target.value)}
            >
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </label>
        )}
      </div>
      <label className="block">
        <Label className="mb-1 block">正文（markdown）</Label>
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={12}
          className="font-mono"
        />
      </label>
      <div className="flex gap-2">
        <Button
          onClick={() => onSave({
            // R2-F4: 原样透传——`|| undefined` 把刻意清空(空串)静默
            // 转成'保持原值', 终审路径无法清空字段(redact 场景尤甚)。
            title,
            ...(kind === 'vuln' ? { severity } : {}),
            ...(kind === 'report' ? { status } : {}),
            text,
          })}
          disabled={busy}
          variant="primary"
          size="sm"
        >
          {busy ? '保存中…' : '保存修订'}
        </Button>
        <Button
          onClick={onCancel}
          disabled={busy}
          variant="secondary"
          size="sm"
        >
          取消
        </Button>
      </div>
    </div>
  );
}
