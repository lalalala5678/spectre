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
 */
export function Markdown({ children }: { children: string }) {
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
        {children}
      </ReactMarkdown>
    </div>
  );
}
