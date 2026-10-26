import { Sparkles, Trash2 } from 'lucide-react';
import { useT } from '@/i18n';

export function ChatHeader({ onClear, canClear }: { onClear: () => void; canClear: boolean }) {
    const t = useT();
    return (
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-ink-850/70 pl-4 pr-3">
            <h2 className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-200">
                <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-brand-400" />
                <span className="truncate">{t('chat.title')}</span>
            </h2>
            <button
                type="button"
                onClick={onClear}
                disabled={!canClear}
                aria-label={t('chat.clear.label')}
                title={t('chat.clear.label')}
                className="shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 focus-ring disabled:opacity-30"
            >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}
