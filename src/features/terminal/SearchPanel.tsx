import { useEffect, useId, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useT } from '@/i18n';
import { Popover } from './Popover';

export type SearchStats = { index: number; count: number };

// Find in the terminal's scrollback. Focus stays in the box while it is open
// (typing here never reaches the shell); Escape closes it and returns focus
// to the terminal.
export function SearchPanel({
    value,
    stats,
    shortcut,
    onChange,
    onNext,
    onPrevious,
    onClose
}: {
    value: string;
    stats: SearchStats;
    shortcut: string;
    onChange: (value: string) => void;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
}) {
    const t = useT();
    const inputRef = useRef<HTMLInputElement>(null);
    const inputId = useId();

    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, []);

    const status = !value.trim()
        ? t('terminal.search.empty')
        : stats.count > 0
            ? t('terminal.search.matches', { index: stats.index >= 0 ? stats.index + 1 : 0, count: stats.count })
            : t('terminal.search.noMatches');

    return (
        <Popover title={t('terminal.search.title')} subtitle={shortcut} closeLabel={t('terminal.search.close')} onClose={onClose} width="w-[20rem]">
            <div className="space-y-2 p-3" role="search">
                <label htmlFor={inputId} className="sr-only">{t('terminal.search.label')}</label>
                <input
                    ref={inputRef}
                    id={inputId}
                    type="search"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            if (event.shiftKey) onPrevious();
                            else onNext();
                        }
                    }}
                    placeholder={t('terminal.search.placeholder')}
                    className="w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500/70"
                />
                <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-400">
                    <span aria-live="polite">{status}</span>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={onPrevious}
                            aria-label={t('terminal.search.previous')}
                            title={t('terminal.search.previous')}
                            className="rounded-lg border border-white/10 px-2 py-1 text-zinc-300 hover:bg-white/5 focus-ring"
                        >
                            <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                            type="button"
                            onClick={onNext}
                            aria-label={t('terminal.search.next')}
                            title={t('terminal.search.next')}
                            className="rounded-lg border border-white/10 px-2 py-1 text-zinc-300 hover:bg-white/5 focus-ring"
                        >
                            <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
                <p className="text-[11px] text-zinc-400">{t('terminal.search.help')}</p>
            </div>
        </Popover>
    );
}
