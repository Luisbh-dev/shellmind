// The welcome screen's "Needs attention" card: the servers the fleet checks
// found in trouble, most urgent first, or that all is well, or (before any
// check) an invitation to set the checks up.
import { useMemo } from 'react';
import { ArrowRight, CheckCircle2, HeartPulse } from 'lucide-react';
import type { ServerSummary } from '@shared/types';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/appStore';
import { useFleetStore } from './feed';
import { agoText, attentionRows, fleetRows, isStale, namesOf, opensRejectedLogin, stateName, stateReason } from './model';
import { FLEET_ACTION_ID } from './notifications';
import { STATE_STYLE, stateIcon } from './StateBadge';

const MAX_ROWS = 5;

export function AttentionCard({ servers, now = Date.now() }: { servers: ServerSummary[]; now?: number }) {
    const t = useT();
    const language = useLanguage();
    const settings = useFleetStore((state) => state.settings);
    const snapshots = useFleetStore((state) => state.snapshots);
    const rows = useMemo(() => fleetRows(servers, snapshots), [servers, snapshots]);
    const attention = useMemo(() => attentionRows(rows), [rows]);
    const names = useMemo(() => namesOf(servers), [servers]);

    if (!settings || rows.length === 0) return null;
    const openBoard = () => useAppStore.getState().openAction(FLEET_ACTION_ID);
    const checked = rows.filter((row) => row.snapshot?.checkedAt).length;

    if (checked === 0) {
        return (
            <section aria-labelledby="welcome-attention">
                <button
                    type="button"
                    onClick={openBoard}
                    className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-ink-850/60 p-3 text-left shadow-soft transition-colors hover:border-white/20 hover:bg-ink-800 focus-ring"
                >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25">
                        <HeartPulse className="h-[18px] w-[18px]" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span id="welcome-attention" className="block text-sm font-medium text-zinc-100">{t('welcome.attention.setupTitle')}</span>
                        <span className="block text-xs text-zinc-400">{t('welcome.attention.setupText')}</span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-brand-300">{t('welcome.attention.setup')}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
                </button>
            </section>
        );
    }

    if (attention.length === 0) {
        return (
            <section aria-labelledby="welcome-attention" className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                <h2 id="welcome-attention" className="min-w-0 flex-1 text-sm text-zinc-200">
                    {checked === 1 ? t('welcome.attention.allGoodOne') : t('welcome.attention.allGood', { count: checked })}
                </h2>
                <button type="button" onClick={openBoard} className="rounded text-xs font-medium text-brand-300 hover:underline focus-ring">
                    {t('welcome.attention.open')}
                </button>
            </section>
        );
    }

    const shown = attention.slice(0, MAX_ROWS);
    const hidden = attention.length - shown.length;
    return (
        <section aria-labelledby="welcome-attention">
            <div className="mb-3 flex items-center gap-3">
                <h2 id="welcome-attention" className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    {t('welcome.attention.title')}{' '}
                    <span className="ml-1.5 rounded-full bg-rose-500/15 px-1.5 py-px font-mono text-[10px] text-rose-200">{attention.length}</span>
                </h2>
                <button type="button" onClick={openBoard} className="ml-auto inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:underline focus-ring">
                    {t('welcome.attention.open')}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2">
                {shown.map((row) => {
                    const style = STATE_STYLE[row.state];
                    const Icon = stateIcon(row.state, row.snapshot);
                    const reason = stateReason(t, language, row.snapshot, 2, names);
                    const stale = isStale(row.snapshot, settings, now);
                    const state = stateName(t, row);
                    return (
                        <li key={row.server.id}>
                            <button
                                type="button"
                                // Opening a server whose login was just rejected would log in
                                // again: the board shows how to fix it instead.
                                onClick={() => (opensRejectedLogin(row.snapshot) ? openBoard() : useAppStore.getState().requestServerTab(row.server.id, 'status'))}
                                title={reason || state}
                                className={cn(
                                    'group flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05] focus-ring',
                                    style.tint
                                )}
                            >
                                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.text)} aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                    <span className="flex min-w-0 items-baseline gap-2">
                                        <span className="truncate text-sm font-medium text-zinc-100">{row.server.name}</span>
                                        <span className={cn('shrink-0 text-[11px] font-medium', style.text)}>{state}</span>
                                    </span>
                                    {reason && <span className="block truncate text-xs text-zinc-300">{reason}</span>}
                                    {row.snapshot?.checkedAt && (
                                        <span className={cn('block text-[11px]', stale ? 'text-amber-300' : 'text-zinc-400')}>
                                            {t('welcome.attention.checked', { when: agoText(row.snapshot.checkedAt, now, t, language) })}
                                        </span>
                                    )}
                                </span>
                            </button>
                        </li>
                    );
                })}
                {hidden > 0 && (
                    <li>
                        <button
                            type="button"
                            onClick={openBoard}
                            className="flex h-full w-full items-center justify-center rounded-xl border border-dashed border-white/10 px-3 py-2.5 text-xs font-medium text-zinc-300 hover:bg-white/[0.04] focus-ring"
                        >
                            {t('welcome.attention.more', { count: hidden })}
                        </button>
                    </li>
                )}
            </ul>
        </section>
    );
}
