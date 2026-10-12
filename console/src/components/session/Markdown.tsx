import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * R23-F2: react-markdown v10 无 rehype-raw 时 mdast html 节点(含内部
 * 文本)被整体静默丢弃——助记消息含 <details>/<b> 等原始 HTML 时内容
 * 显示丢失。本插件把 html 节点改写为 text 节点: 标签按字面显示、
 * React 渲染自动转义, 不执行(XSS 面与默认行为一致; 启用 rehype-raw
 * 会重开已收敛的 XSS 面, 明确排除)。
 */
function remarkHtmlAsText() {
  return (tree: unknown) => {
    const walk = (node: any) => {
      if (Array.isArray(node.children)) node.children.forEach(walk);
      if (node.type === 'html') {
        node.type = 'text';
        node.value = String(node.value ?? '');
        delete node.children;
      }
    };
    walk(tree);
  };
}

/**
 * Markdown renderer with SPECTRE's void theme (tables, code, lists).
 * Used for assistant replies — streamed partial markdown renders fine.
 *
 * 2026-10-11 性能修复(用户令: 详情点击卡数秒):
 * ① memo 化——detail 字符串不变时跳过整个 ReactMarkdown 重解析
 *   (返回列表再进同一条秒开; SSE 重渲也不再重复付费)。
 * ② 渐进渲染 ProgressiveBody——长 detail(>CHUNK_CHARS)首帧只解析
 *   首 CHUNK_CHARS 字符(标题/概述立即可见), 其余按块在 rIC/timeout
 *   分片补全。实测 4x 节流下 srm 级大报告 1399ms → 首帧 <300ms。
 *   大表格跨块边界会短暂截断显示, 随后块到达自动补全(可接受)。
 */

const CHUNK_CHARS = 2500;
const CHUNK_DELAY_MS = 32;

function ProgressiveBody({ text }: { text: string }) {
  const total = text.length;
  const [shown, setShown] = useState(() => Math.min(CHUNK_CHARS, total));
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    setShown(Math.min(CHUNK_CHARS, total));
    if (total <= CHUNK_CHARS) return;
    let cancelled = false;
    const pump = () => {
      if (cancelled) return;
      setShown(prev => {
        const next = Math.min(prev + CHUNK_CHARS, total);
        if (next < total) rafRef.current = (requestIdleCallback
          ?? ((cb: () => void) => setTimeout(cb, CHUNK_DELAY_MS)))(pump as any);
        return next;
      });
    };
    rafRef.current = (requestIdleCallback
      ?? ((cb: () => void) => setTimeout(cb, CHUNK_DELAY_MS)))(pump as any);
    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        (cancelIdleCallback ?? clearTimeout)(rafRef.current as number);
      }
    };
  }, [total]);
  const slice = text.slice(0, shown);
  return (
    <>
      <MarkdownCore text={slice} />
      {shown < total && (
        <div className="my-1 text-xs text-tertiary">… 渲染中({shown}/{total} 字符)</div>
      )}
    </>
  );
}

const MarkdownCore = memo(function MarkdownCore({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkHtmlAsText, {}]]}
        components={{
          h1: p => <h1 className="mb-1.5 mt-2 text-[15px] font-bold text-primary" {...p} />,
          h2: p => <h2 className="mb-1.5 mt-2 text-[14px] font-bold text-primary" {...p} />,
          h3: p => <h3 className="mb-1 mt-1.5 text-[13px] font-semibold text-primary" {...p} />,
          p: p => <p className="mb-1.5 last:mb-0" {...p} />,
          ul: p => <ul className="mb-1.5 list-disc space-y-0.5 pl-4" {...p} />,
          ol: p => <ol className="mb-1.5 list-decimal space-y-0.5 pl-4" {...p} />,
          li: p => <li className="pl-0.5" {...p} />,
          strong: p => <strong className="font-semibold text-primary" {...p} />,
          em: p => <em className="italic text-secondary" {...p} />,
          a: p => (
            <a className="text-accent-text underline decoration-line underline-offset-2 hover:decoration-accent-text" {...p} />
          ),
          blockquote: p => (
            <blockquote
              className="mb-1.5 border-l-2 border-line-strong pl-2 text-secondary"
              {...p}
            />
          ),
          hr: () => <hr className="my-2 border-line" />,
          // R23-F1: 无语言围栏块不产出 language- class, 此前被误判为
          // 行内 chip 且外层裸 pre 无滚动——块级样式整体搬 pre, code 只
          // 承载行内样式, pre 内 code 以任意变体中和。
          code: ({ children: c, ...rest }) => (
            <code
              className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[13px] text-secondary"
              {...rest}
            >
              {c}
            </code>
          ),
          pre: p => (
            <pre
              className="mb-1.5 overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-[13px] text-primary [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
              {...p}
            />
          ),
          table: p => (
            <div className="mb-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...p} />
            </div>
          ),
          thead: p => <thead className="bg-surface-2" {...p} />,
          th: p => (
            <th className="border border-line px-1.5 py-1 text-left font-medium text-secondary" {...p} />
          ),
          td: p => (
            <td className="border border-line px-1.5 py-1 align-top text-secondary" {...p} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  if (children.length <= CHUNK_CHARS) return <MarkdownCore text={children} />;
  return <ProgressiveBody text={children} />;
});
