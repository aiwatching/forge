'use client';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="text-base font-bold text-[var(--text-primary)] mt-3 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-sm font-bold text-[var(--text-primary)] mt-3 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-xs font-bold text-[var(--text-primary)] mt-2 mb-1">{children}</h3>,
        p: ({ children }) => <p className="text-xs text-[var(--text-primary)] mb-1.5 leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="text-xs text-[var(--text-primary)] mb-1.5 ml-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="text-xs text-[var(--text-primary)] mb-1.5 ml-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
        em: ({ children }) => <em className="italic text-[var(--text-secondary)]">{children}</em>,
        a: ({ href, children }) => <a href={href} className="text-[var(--accent)] hover:underline" target="_blank" rel="noopener">{children}</a>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-[var(--accent)]/40 pl-3 my-1.5 text-[var(--text-secondary)] text-xs italic">{children}</blockquote>,
        code: ({ className, children, node, ...props }) => {
          // Block code: has language class OR parent is <pre> (checked via node)
          const isBlock = !!className?.includes('language-');

          if (isBlock) {
            const lang = className?.replace('language-', '') || '';
            return (
              <div className="my-2 rounded border border-[var(--border)] overflow-hidden max-w-full">
                {lang && (
                  <div className="px-3 py-1 bg-[var(--bg-tertiary)] border-b border-[var(--border)] text-[9px] text-[var(--text-secondary)] font-mono">
                    {lang}
                  </div>
                )}
                <pre className="p-3 bg-[var(--bg-tertiary)] overflow-x-auto max-w-full">
                  <code className="text-[12px] font-mono text-[var(--text-primary)] whitespace-pre leading-[1.4]" style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace' }}>{children}</code>
                </pre>
              </div>
            );
          }
          return (
            <code className="text-[11px] font-mono bg-[var(--bg-tertiary)] text-[var(--accent)] px-1 py-0.5 rounded">
              {children}
            </code>
          );
        },
        pre: ({ children, ...props }) => {
          // If code child already rendered as block (has language-), just pass through
          // Otherwise wrap plain code blocks (no language) with proper styling
          const child = (children as any)?.props;
          if (child?.className?.includes('language-')) return <>{children}</>;
          return (
            <div className="my-2 rounded border border-[var(--border)] overflow-hidden max-w-full">
              <pre className="p-3 bg-[var(--bg-tertiary)] overflow-x-auto max-w-full">
                <code className="text-[12px] font-mono text-[var(--text-primary)] whitespace-pre leading-[1.4]" style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace' }}>{child?.children || children}</code>
              </pre>
            </div>
          );
        },
        hr: () => <hr className="my-3 border-[var(--border)]" />,
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="text-xs border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-[var(--border)] px-3 py-1.5 bg-[var(--bg-tertiary)] text-left font-semibold text-[11px] whitespace-nowrap">{children}</th>,
        td: ({ children }) => <td className="border border-[var(--border)] px-3 py-1.5 text-[11px]">{children}</td>,
      }}
    >
      {content}
    </Markdown>
  );
}
