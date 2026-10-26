import { useEffect, useRef } from 'react';
import { Play, Star, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ui/Confirm';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { selectFavorites, selectHistory, useCommandHistory, type FavoriteEntry, type HistoryEntry } from './history';
import { Popover } from './Popover';

const LABEL_CHARS = 60;

// The command a row's buttons act on, as screen readers announce it.
function labelParams(command: string) {
    const oneLine = command.replace(/\s+/g, ' ').trim();
    return { command: oneLine.length > LABEL_CHARS ? `${oneLine.slice(0, LABEL_CHARS).trimEnd()}…` : oneLine };
}

// Commands run in this server's terminals, with favorites on top. Entries
// can be run again, starred or deleted one by one.
export function HistoryPanel({
    serverId,
    serverName,
    onRun,
    onRunFavorite,
    onNotice,
    onClose
}: {
    serverId: number;
    serverName: string;
    onRun: (entry: HistoryEntry) => void;
    onRunFavorite: (entry: FavoriteEntry) => void;
    onNotice: (message: string) => void;
    onClose: () => void;
}) {
    const t = useT();
    const language = useLanguage();
    const confirm = useConfirm();
    const history = useCommandHistory(selectHistory(serverId));
    const favorites = useCommandHistory(selectFavorites(serverId));
    const { load, remove, clear, toggleFavorite } = useCommandHistory.getState();
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        load(serverId);
        const frame = requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
        return () => cancelAnimationFrame(frame);
    }, [serverId, load]);

    const isFavorite = (command: string) => favorites.some((entry) => entry.command === command);
    const toggle = (command: string) => {
        const wasFavorite = isFavorite(command);
        toggleFavorite(serverId, command);
        onNotice(t(wasFavorite ? 'terminal.notices.favoriteRemoved' : 'terminal.notices.favoriteAdded'));
    };
    const clearAll = async () => {
        const ok = await confirm({
            title: t('terminal.history.clearTitle'),
            message: t('terminal.history.clearText', { count: history.length, name: serverName }),
            confirmLabel: t('terminal.history.clear'),
            tone: 'danger'
        });
        if (!ok) return;
        clear(serverId);
        onNotice(t('terminal.notices.historyCleared'));
    };
    const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });

    return (
        <Popover title={t('terminal.history.title')} subtitle={t('terminal.history.subtitle')} closeLabel={t('terminal.history.close')} onClose={onClose}>
            <div ref={listRef} className="max-h-[340px] space-y-3 overflow-y-auto p-2 scrollbar-thin">
                {favorites.length > 0 && (
                    <div>
                        <h3 className="px-1 pb-1 text-[11px] uppercase tracking-wider text-zinc-400">{t('terminal.history.favorites')}</h3>
                        <ul className="space-y-1">
                            {favorites.map((entry) => (
                                <li key={entry.id} className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                                    <button
                                        type="button"
                                        onClick={() => onRunFavorite(entry)}
                                        className="min-w-0 flex-1 rounded text-left focus-ring"
                                    >
                                        <span className="block whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-200">{entry.command}</span>
                                        <span className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-300/90">
                                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                            {t('terminal.history.runFavorite')}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => toggle(entry.command)}
                                        aria-label={t('terminal.history.removeFavoriteEntry', labelParams(entry.command))}
                                        title={t('terminal.history.removeFavorite')}
                                        className="rounded-lg border border-amber-500/30 px-2 py-1 text-amber-300 hover:bg-amber-500/10 focus-ring"
                                    >
                                        <Star className="h-4 w-4 fill-current" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div>
                    {favorites.length > 0 && history.length > 0 && (
                        <h3 className="px-1 pb-1 text-[11px] uppercase tracking-wider text-zinc-400">{t('terminal.history.recent')}</h3>
                    )}
                    {history.length === 0 ? (
                        <p className="rounded-lg border border-white/5 bg-black/30 px-3 py-4 text-xs text-zinc-400">{t('terminal.history.empty')}</p>
                    ) : (
                        <ul className="space-y-1">
                            {history.map((entry) => {
                                const favorite = isFavorite(entry.command);
                                return (
                                    <li key={entry.id} className="flex items-start gap-2 rounded-lg border border-white/5 bg-black/30 px-3 py-2 transition-colors hover:border-white/10 hover:bg-white/5">
                                        <button
                                            type="button"
                                            onClick={() => onRun(entry)}
                                            className="min-w-0 flex-1 rounded text-left focus-ring"
                                        >
                                            <span className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                                                <span className="uppercase tracking-wider">{t(`terminal.history.sources.${entry.source}`)}</span>
                                                <span>{time(entry.timestamp)}</span>
                                            </span>
                                            <span className="mt-1 block whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-200">{entry.command}</span>
                                            <span className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400">
                                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                                {t('terminal.history.run')}
                                            </span>
                                        </button>
                                        <div className="flex flex-col gap-1">
                                            <button
                                                type="button"
                                                onClick={() => toggle(entry.command)}
                                                aria-pressed={favorite}
                                                aria-label={t(favorite ? 'terminal.history.removeFavoriteEntry' : 'terminal.history.addFavoriteEntry', labelParams(entry.command))}
                                                title={t(favorite ? 'terminal.history.removeFavorite' : 'terminal.history.addFavorite')}
                                                className={cn(
                                                    'rounded-lg border px-2 py-1 transition-colors focus-ring',
                                                    favorite
                                                        ? 'border-amber-500/30 text-amber-300 hover:bg-amber-500/10'
                                                        : 'border-white/10 text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                                                )}
                                            >
                                                <Star className={cn('h-4 w-4', favorite && 'fill-current')} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => remove(serverId, entry.id)}
                                                aria-label={t('terminal.history.removeEntry', labelParams(entry.command))}
                                                title={t('terminal.history.remove')}
                                                className="rounded-lg border border-white/10 px-2 py-1 text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300 focus-ring"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
            {history.length > 0 && (
                <footer className="flex justify-end border-t border-white/5 px-3 py-2">
                    <button
                        type="button"
                        onClick={() => void clearAll()}
                        className="rounded-lg px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-rose-500/10 hover:text-rose-300 focus-ring"
                    >
                        {t('terminal.history.clear')}
                    </button>
                </footer>
            )}
        </Popover>
    );
}
