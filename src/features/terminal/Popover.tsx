import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

// The floating panels of a terminal (search, history, quick commands):
// a labelled region at the top right of the terminal; Escape inside it
// closes it.
export function Popover({
    title,
    subtitle,
    closeLabel,
    onClose,
    width = 'w-[22rem]',
    children
}: {
    title: string;
    subtitle?: string;
    closeLabel: string;
    onClose: () => void;
    width?: string;
    children: ReactNode;
}) {
    const titleId = useId();
    const rootRef = useRef<HTMLElement>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onCloseRef.current();
        };
        root.addEventListener('keydown', onKeyDown);
        return () => root.removeEventListener('keydown', onKeyDown);
    }, []);

    return (
        <section
            ref={rootRef}
            aria-labelledby={titleId}
            className={cn(
                'absolute right-3 top-2 z-40 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-xl border border-white/10 bg-ink-800 shadow-panel animate-slide-up',
                width
            )}
        >
            <header className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="min-w-0">
                    <h2 id={titleId} className="text-xs font-bold uppercase tracking-wider text-zinc-200">{title}</h2>
                    {subtitle && <p className="mt-0.5 text-[11px] text-zinc-400">{subtitle}</p>}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={closeLabel}
                    title={closeLabel}
                    className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-ring"
                >
                    <X className="h-4 w-4" />
                </button>
            </header>
            {children}
        </section>
    );
}
