// The Markdown renderer of AI answers (react-markdown, remark-gfm and their
// dependencies, about 150 KB) loads with the first answer that needs it, not
// with the chat panel, which is on screen from the start. Until then, and if
// it cannot be loaded, the text shows as it is; once loaded it renders
// synchronously.
import { memo, useEffect, useReducer } from 'react';
import { importWithRetry } from '@/lib/lazy';

type MarkdownComponent = typeof import('./Markdown').Markdown;

let Loaded: MarkdownComponent | null = null;
let loading: Promise<void> | null = null;

export function preloadMarkdown(): Promise<void> {
    loading ??= importWithRetry(() => import('./Markdown')).then(
        (module) => {
            Loaded = module.Markdown;
        },
        (error: unknown) => {
            loading = null;
            throw error;
        }
    );
    return loading;
}

// `topHeading` as Markdown takes it (the heading levels of the whole answer).
export const LazyMarkdown = memo(function LazyMarkdown({ text, topHeading }: { text: string; topHeading?: number }) {
    const [, loaded] = useReducer((count: number) => count + 1, 0);
    useEffect(() => {
        if (!Loaded) preloadMarkdown().then(loaded, () => undefined);
    }, []);
    if (Loaded) return <Loaded text={text} topHeading={topHeading} />;
    return (
        <div className="min-w-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-300 [overflow-wrap:anywhere]">{text}</div>
    );
});
