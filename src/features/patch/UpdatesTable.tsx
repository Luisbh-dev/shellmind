import { useId, useMemo, useState } from 'react';
import { PackageCheck, Search, ShieldAlert } from 'lucide-react';
import type { PendingUpdate } from '@shared/patch';
import { Button, Checkbox, EmptyState, Input } from '@/components/ui';
import { useT } from '@/i18n';
import { Dash } from './bits';
import { filterUpdates } from './model';

// A server's pending updates: package (with its architecture and
// repository), installed and available versions and the security flag,
// filterable, security ones first. Long lists show a page first. Windows
// updates have no installed version: their KB articles are what is listed.

const PAGE = 300;

export function UpdatesTable({ updates, total, securityKnown }: { updates: readonly PendingUpdate[]; total: number; securityKnown: boolean }) {
    const t = useT();
    const id = useId();
    const [query, setQuery] = useState('');
    const [securityOnly, setSecurityOnly] = useState(false);
    const [limit, setLimit] = useState(PAGE);
    const shown = useMemo(() => filterUpdates(updates, query, securityOnly), [updates, query, securityOnly]);
    const windows = updates.length > 0 && updates.every((update) => update.current === null && update.arch === null);

    if (!updates.length) {
        return <EmptyState icon={<PackageCheck className="h-5 w-5" />} title={t('patch.updates.empty')} description={t('patch.updates.emptyText')} />;
    }

    return (
        <section aria-labelledby={`${id}-title`} className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 id={`${id}-title`} className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('patch.updates.title')}</h3>
                <span className="text-[11px] tabular-nums text-zinc-500">{t('patch.updates.shown', { shown: Math.min(shown.length, limit), total })}</span>
                <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
                    {securityKnown && (
                        <Checkbox checked={securityOnly} onChange={setSecurityOnly} label={<span className="text-xs">{t('patch.updates.securityOnly')}</span>} className="items-center" />
                    )}
                    <div className="relative min-w-[10rem] max-w-[16rem] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                        <Input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            aria-label={t('patch.updates.search')}
                            placeholder={t('patch.updates.searchPlaceholder')}
                            maxLength={200}
                            className="h-8 pl-8 text-xs"
                        />
                    </div>
                </div>
            </div>
            {!shown.length ? (
                <p className="rounded-lg border border-white/5 px-3 py-4 text-center text-xs text-zinc-400">{t('patch.updates.noMatch')}</p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-white/5 scrollbar-thin">
                    <table className="w-full min-w-[30rem] table-fixed text-left text-xs">
                        <caption className="sr-only">{t('patch.updates.title')}</caption>
                        <thead className="bg-white/[0.02] text-[11px] uppercase tracking-wider text-zinc-400">
                            <tr>
                                <th scope="col" className="px-3 py-2 font-medium">{t('patch.updates.package')}</th>
                                {!windows && <th scope="col" className="w-[28%] px-2 py-2 font-medium">{t('patch.updates.installed')}</th>}
                                <th scope="col" className="w-[28%] px-2 py-2 font-medium">{t('patch.updates.available')}</th>
                                <th scope="col" className="w-[7.25rem] px-2 py-2 font-medium">{t('patch.updates.security')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.slice(0, limit).map((update) => {
                                const where = [update.arch, update.repository].filter(Boolean).join(' · ');
                                return (
                                    <tr key={`${update.name}:${update.arch ?? ''}:${update.available}`} className="border-t border-white/5 align-top hover:bg-white/[0.02]">
                                        <td className="min-w-0 px-3 py-1.5">
                                            <span className={windows ? 'block break-words text-zinc-100' : 'block truncate font-mono text-zinc-100'} title={update.name}>{update.name}</span>
                                            {where && <span className="block truncate text-[11px] text-zinc-500" title={where}>{where}</span>}
                                        </td>
                                        {!windows && (
                                            <td className="px-2 py-1.5 font-mono text-zinc-400">
                                                {update.current
                                                    ? <span className="block break-all">{update.current}</span>
                                                    : <span className="rounded bg-sky-500/10 px-1 font-sans text-[10px] font-medium text-sky-300">{t('patch.updates.newPackage')}</span>}
                                            </td>
                                        )}
                                        <td className="px-2 py-1.5 font-mono text-zinc-200"><span className="block break-all">{update.available}</span></td>
                                        <td className="px-2 py-1.5">
                                            {update.security ? (
                                                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-200" title={update.severity ?? t('patch.updates.securityBadge')}>
                                                    <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                                                    {update.severity
                                                        ? <span className="truncate">{update.severity}</span>
                                                        : <span className="sr-only">{t('patch.updates.securityBadge')}</span>}
                                                </span>
                                            ) : update.security === null ? <Dash label={t('patch.values.noSecurityInfo')} /> : null}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {shown.length > limit && (
                <Button variant="ghost" size="sm" onClick={() => setLimit(shown.length)}>{t('patch.updates.showAll', { count: shown.length })}</Button>
            )}
        </section>
    );
}
