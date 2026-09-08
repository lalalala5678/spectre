import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown renderer with SPECTRE's void theme (tables, code, lists).
 * Used for assistant replies — streamed partial markdown renders fine.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-zinc-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: p => <h1 className="mb-1.5 mt-2 text-[15px] font-bold text-zinc-100" {...p} />,
          h2: p => <h2 className="mb-1.5 mt-2 text-[14px] font-bold text-zinc-100" {...p} />,
          h3: p => <h3 className="mb-1 mt-1.5 text-[13px] font-semibold text-zinc-200" {...p} />,
          p: p => <p className="mb-1.5 last:mb-0" {...p} />,
          ul: p => <ul className="mb-1.5 list-disc space-y-0.5 pl-4" {...p} />,
          ol: p => <ol className="mb-1.5 list-decimal space-y-0.5 pl-4" {...p} />,
          li: p => <li className="pl-0.5" {...p} />,
          strong: p => <strong className="font-semibold text-zinc-100" {...p} />,
          em: p => <em className="italic text-zinc-400" {...p} />,
          a: p => (
            <a className="text-orange-400 underline decoration-orange-800 hover:text-orange-300" {...p} />
          ),
          blockquote: p => (
            <blockquote
              className="mb-1.5 border-l-2 border-void-500 pl-2 text-zinc-400"
              {...p}
            />
          ),
          hr: () => <hr className="my-2 border-void-700" />,
          code: ({ className, children: c, ...rest }) => {
            const inline = !String(className || '').includes('language-');
            if (inline) {
              return (
                <code
                  className="rounded-sm bg-void-950 px-1 py-px font-mono text-[12px] text-orange-300/90"
                  {...rest}
                >
                  {c}
                </code>
              );
            }
            return (
              <code className="block overflow-x-auto rounded-sm border border-void-700 bg-void-950 p-2 font-mono text-[12px] text-zinc-300" {...rest}>
                {c}
              </code>
            );
          },
          pre: p => <pre className="mb-1.5" {...p} />,
          table: p => (
            <div className="mb-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]" {...p} />
            </div>
          ),
          thead: p => <thead className="bg-void-900" {...p} />,
          th: p => (
            <th className="border border-void-700 px-1.5 py-1 text-left font-semibold text-zinc-200" {...p} />
          ),
          td: p => (
            <td className="border border-void-700 px-1.5 py-1 align-top text-zinc-400" {...p} />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
