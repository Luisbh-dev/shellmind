import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, Image as ImageIcon } from 'lucide-react';
import { useT, type TranslateFn } from '@/i18n';

// Markdown of AI answers (text between code blocks). AI output is untrusted:
// only http(s) and mailto links survive, they open outside the app, images
// are never fetched (shown as a link with their URL), and raw HTML is shown
// as text (react-markdown's default without rehype-raw).

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function safeUrl(url: string): string {
    const trimmed = url.trim();
    return SAFE_URL.test(trimmed) ? trimmed : '';
}

function SafeLink({ href, children, title }: { href?: string; children: ReactNode; title?: string }) {
    if (!href) return <span className="text-zinc-300">{children}</span>;
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={title ?? href}
            className="inline-flex items-baseline gap-0.5 text-brand-300 underline decoration-brand-500/40 underline-offset-2 hover:text-brand-200 hover:decoration-brand-300 focus-ring rounded-sm"
        >
            {children}
            <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0 self-center opacity-70" />
        </a>
    );
}

type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

// The look of a heading follows its Markdown depth...
const HEADING_STYLES: Record<HeadingDepth, string> = {
    1: 'mb-1.5 mt-3 text-[15px] font-semibold text-zinc-100 first:mt-0',
    2: 'mb-1.5 mt-3 text-[14px] font-semibold text-zinc-100 first:mt-0',
    3: 'mb-1 mt-2.5 text-[13px] font-semibold text-zinc-100 first:mt-0',
    4: 'mb-1 mt-2 text-[13px] font-semibold text-zinc-200 first:mt-0',
    5: 'mb-1 mt-2 text-[13px] font-semibold text-zinc-200 first:mt-0',
    6: 'mb-1 mt-2 text-[13px] font-medium text-zinc-300 first:mt-0'
};

// ...its level the outline: the chat panel's title is an h2, so the topmost
// heading of an answer is an h3 and the others follow it without skipping.
const PANEL_HEADING_LEVEL = 2;

function headingComponent(depth: HeadingDepth, topDepth: number) {
    const first = PANEL_HEADING_LEVEL + 1;
    const level = Math.min(6, Math.max(first, first + depth - (topDepth || 1)));
    const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
    return function Heading({ children }: { children?: ReactNode }) {
        return <Tag className={HEADING_STYLES[depth]}>{children}</Tag>;
    };
}

function buildComponents(t: TranslateFn, topHeading: number): Components {
    return {
        a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
        img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src : '';
            const label = alt?.trim() || t('chat.markdown.image');
            return (
                <span className="inline-flex flex-wrap items-baseline gap-1 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[12px] text-zinc-400">
                    <ImageIcon aria-hidden="true" className="h-3 w-3 self-center" />
                    <span>{label}</span>
                    {url && (
                        <SafeLink href={url} title={t('chat.markdown.imageTitle', { url })}>
                            <span className="break-all font-mono text-[11px]">{url}</span>
                        </SafeLink>
                    )}
                </span>
            );
        },
        h1: headingComponent(1, topHeading),
        h2: headingComponent(2, topHeading),
        h3: headingComponent(3, topHeading),
        h4: headingComponent(4, topHeading),
        h5: headingComponent(5, topHeading),
        h6: headingComponent(6, topHeading),
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children, className }) => (
            <ul className={className?.includes('contains-task-list') ? 'my-1.5 space-y-1 pl-1' : 'my-1.5 list-disc space-y-1 pl-5 marker:text-zinc-500'}>{children}</ul>
        ),
        ol: ({ children, start }) => <ol start={start} className="my-1.5 list-decimal space-y-1 pl-5 marker:text-zinc-500">{children}</ol>,
        li: ({ children, className }) => <li className={className?.includes('task-list-item') ? 'flex list-none items-start gap-1.5' : 'pl-0.5'}>{children}</li>,
        input: ({ checked }) => (
            <input type="checkbox" checked={Boolean(checked)} disabled readOnly className="mt-1 h-3 w-3 shrink-0 accent-brand-500" />
        ),
        blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-brand-500/40 pl-3 text-zinc-400">{children}</blockquote>,
        hr: () => <hr className="my-3 border-white/10" />,
        strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
        em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
        del: ({ children }) => <del className="text-zinc-500">{children}</del>,
        code: ({ children }) => <code className="rounded bg-white/[0.07] px-1 py-0.5 font-mono text-[12px] text-brand-100">{children}</code>,
        pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg border border-white/10 bg-ink-900 p-2.5 font-mono text-xs leading-relaxed text-zinc-200 scrollbar-thin [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-zinc-200">
                {children}
            </pre>
        ),
        table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto rounded-lg border border-white/10 scrollbar-thin">
                <table className="w-full border-collapse text-left text-[12px]">{children}</table>
            </div>
        ),
        thead: ({ children }) => <thead className="bg-white/[0.04] text-zinc-200">{children}</thead>,
        th: ({ children, style }) => <th style={style} className="border-b border-white/10 px-2.5 py-1.5 font-semibold">{children}</th>,
        td: ({ children, style }) => <td style={style} className="border-t border-white/5 px-2.5 py-1.5 align-top">{children}</td>
    };
}

const REMARK_PLUGINS = [remarkGfm];

// `topHeading`: the depth of the topmost heading of the whole answer (it can
// be rendered in several parts), 0 when it has none.
export const Markdown = memo(function Markdown({ text, topHeading = 0 }: { text: string; topHeading?: number }) {
    const t = useT();
    const components = useMemo(() => buildComponents(t, topHeading), [t, topHeading]);
    return (
        <div className="min-w-0 break-words text-[13px] leading-relaxed text-zinc-300 [overflow-wrap:anywhere]">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={safeUrl}>
                {text}
            </ReactMarkdown>
        </div>
    );
});
