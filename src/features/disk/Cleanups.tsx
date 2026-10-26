import { useMemo, useState } from 'react';
import {
    AlertTriangle, Archive, Box, CheckCircle2, ChevronRight, Clock, Container, Eraser, FileClock, Layers, Package, RefreshCw, Recycle, ScrollText, Trash2, Wrench, type LucideIcon
} from 'lucide-react';
import { CLEANUP_PARAM_RULES, type CleanupId, type CleanupParams, type CleanupPreview, type DiskActionResult } from '@shared/disk';
import type { OpsPlatform } from '@shared/ops';
import { Badge, Button, Modal, Select, useToast } from '@/components/ui';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { EmptyState, ErrorNotice } from '@/features/ops/ui';
import { errorText } from '@/features/ops/errors';
import { useRemote } from '@/features/ops/useRemote';
import { diskApi } from './api';
import { Notice, bytes, estimateText, fileDate } from './ui';

// The known cleanups of the server: what each would free (measured now, on
// which filesystem), reviewed in a dialog that lists what goes, then run
// after a confirmation. The result is the change of free space the backend
// measured around the command (and what the tool itself said).

const ICONS: Record<CleanupId, LucideIcon> = {
    journal: ScrollText,
    'package-cache': Package,
    'rotated-logs': Archive,
    tmp: Clock,
    'core-dumps': FileClock,
    'docker-dangling': Layers,
    'docker-unused': Layers,
    'docker-build-cache': Wrench,
    'docker-containers': Container,
    'win-temp': Clock,
    'win-update-cache': RefreshCw,
    'win-recycle-bin': Recycle,
    'win-component-store': Box
};

type CleanupsProps = {
    serverId: number;
    platform: OpsPlatform;
    mount: string;
    enabled: boolean;
    onChanged: () => void;
};

// The parameters a cleanup shows: "files older than 7 days", "keep 200 MB".
function paramSummary(t: TranslateFn, language: string, preview: CleanupPreview): string | null {
    const { days, keepMB, keepDays } = preview.params;
    if (keepMB !== undefined) {
        const size = formatBytes(keepMB * 1024 * 1024, language);
        return keepDays ? t('disk.cleanup.params.keepBoth', { size, days: keepDays }) : t('disk.cleanup.params.keep', { size });
    }
    if (days === undefined) return null;
    return days === 0 ? t('disk.cleanup.params.allAges') : t(days === 1 ? 'disk.cleanup.params.olderOne' : 'disk.cleanup.params.older', { days });
}

function reasonText(t: TranslateFn, preview: CleanupPreview, platform: OpsPlatform): string {
    const code = preview.reason?.code ?? 'NOT_FOUND';
    return t(code === 'NOT_ELEVATED' && platform === 'windows' ? 'disk.cleanup.reason.NOT_ELEVATED_WINDOWS' : `disk.cleanup.reason.${code}`);
}

export function Cleanups({ serverId, platform, mount, enabled, onChanged }: CleanupsProps) {
    const t = useT();
    const language = useLanguage();
    const [reviewing, setReviewing] = useState<CleanupPreview | null>(null);
    const overview = useRemote((signal) => diskApi.cleanups(serverId, signal), `cleanups:${serverId}`, enabled);

    // The ones that free space on the filesystem on screen first, then
    // those with something to free, the largest first.
    const sorted = useMemo(() => [...(overview.data ?? [])].sort((a, b) => {
        const here = (preview: CleanupPreview) => (preview.mounts.includes(mount) ? 0 : 1);
        const state = (preview: CleanupPreview) => ({ ready: 0, analyze: 1, nothing: 2, unavailable: 3 })[preview.status];
        return here(a) - here(b) || state(a) - state(b) || (b.bytes ?? 0) - (a.bytes ?? 0);
    }), [overview.data, mount]);
    const reclaimable = sorted.filter((preview) => preview.status === 'ready' && preview.mounts.includes(mount)).reduce((sum, preview) => sum + (preview.bytes ?? 0), 0);
    // None can run, for want of rights the login user does not have.
    const locked = sorted.length > 0 && sorted.every((preview) => preview.status !== 'ready' && preview.status !== 'analyze') && sorted.some((preview) => preview.reason?.code === 'NOT_ELEVATED');

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-zinc-400">
                    {overview.data
                        ? reclaimable > 0
                            ? t('disk.cleanup.summary', { size: formatBytes(reclaimable, language), mount })
                            : locked ? t(platform === 'windows' ? 'disk.cleanup.summaryLockedWindows' : 'disk.cleanup.summaryLocked') : t('disk.cleanup.summaryNone', { mount })
                        : t('disk.cleanup.intro')}
                </p>
                <Button size="sm" variant="subtle" onClick={overview.reload} loading={overview.loading && Boolean(overview.data)} disabled={!enabled}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('disk.cleanup.measure')}
                </Button>
            </div>

            {overview.error ? (
                <ErrorNotice error={overview.error} title={t('disk.cleanup.loadFailed')} onRetry={overview.reload} />
            ) : !overview.data ? (
                <p className="flex items-center gap-2 py-6 text-xs text-zinc-400" role="status">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t('disk.cleanup.measuring')}
                </p>
            ) : sorted.length === 0 ? (
                <EmptyState icon={<Eraser className="h-5 w-5" />} title={t('disk.cleanup.noneKnown')} />
            ) : (
                <ul className="grid grid-cols-1 gap-2.5 [@container(min-width:52rem)]:grid-cols-2" aria-label={t('disk.cleanup.listLabel')} aria-busy={overview.loading || undefined}>
                    {sorted.map((preview) => (
                        <CleanupCard key={preview.id} preview={preview} mount={mount} platform={platform} onReview={() => setReviewing(preview)} />
                    ))}
                </ul>
            )}

            {reviewing && (
                <CleanupDialog
                    serverId={serverId}
                    platform={platform}
                    initial={reviewing}
                    onClose={() => setReviewing(null)}
                    onDone={() => {
                        overview.reload();
                        onChanged();
                    }}
                />
            )}
        </div>
    );
}

function CleanupCard({ preview, mount, platform, onReview }: { preview: CleanupPreview; mount: string; platform: OpsPlatform; onReview: () => void }) {
    const t = useT();
    const language = useLanguage();
    const Icon = ICONS[preview.id];
    const here = preview.mounts.includes(mount);
    const params = paramSummary(t, language, preview);
    const runnable = preview.status === 'ready' || preview.status === 'analyze';
    return (
        <li className={cn('flex min-w-0 flex-col gap-2 rounded-xl border px-3.5 py-3', preview.status === 'ready' && here ? 'border-white/[0.1] bg-white/[0.03]' : 'border-white/[0.06] bg-white/[0.015]')}>
            <div className="flex items-start gap-2.5">
                <span className={cn('mt-0.5 rounded-lg p-1.5', preview.status === 'ready' ? 'bg-brand-500/10 text-brand-300' : 'bg-white/[0.04] text-zinc-500')} aria-hidden="true">
                    <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-medium text-zinc-100">{t(`disk.cleanup.items.${preview.id}.title`)}</h4>
                    <p className="mt-0.5 text-xs text-zinc-400">{t(`disk.cleanup.items.${preview.id}.desc`)}</p>
                </div>
                <div className="shrink-0 text-right">
                    {preview.status === 'ready' ? (
                        <div className="text-sm font-semibold tabular-nums text-zinc-50">{preview.bytes !== null ? formatBytes(preview.bytes, language) : '—'}</div>
                    ) : preview.status === 'nothing' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{t('disk.cleanup.nothing')}</span>
                    ) : preview.status === 'analyze' ? (
                        <span className="text-xs text-zinc-400">{t('disk.cleanup.needsAnalysis')}</span>
                    ) : (
                        <>
                            {(preview.bytes ?? 0) > 0 && <div className="text-sm font-semibold tabular-nums text-zinc-400">{formatBytes(preview.bytes ?? 0, language)}</div>}
                            <Badge tone="warning">{t('disk.cleanup.unavailable')}</Badge>
                        </>
                    )}
                    {preview.status === 'ready' && (
                        <div className="text-[11px] text-zinc-500">
                            {preview.count !== null ? t(preview.count === 1 ? 'disk.cleanup.countOne' : 'disk.cleanup.count', { count: preview.count }) : t(`disk.cleanup.estimateShort.${preview.estimate}`)}
                        </div>
                    )}
                </div>
            </div>
            {preview.status === 'unavailable' && (
                <p className="text-xs text-amber-200/90" title={preview.reason?.message}>{reasonText(t, preview, platform)}</p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                {preview.mounts.length > 0 && (
                    <span className={cn(here ? 'text-zinc-300' : 'text-zinc-500')}>
                        {t(here ? 'disk.cleanup.frees' : 'disk.cleanup.freesElsewhere', { mounts: preview.mounts.join(', ') })}
                    </span>
                )}
                {params && <span>{preview.mounts.length > 0 && <span aria-hidden="true">· </span>}{params}</span>}
                <Button size="sm" variant={preview.status === 'ready' ? 'secondary' : 'ghost'} className="ml-auto h-7" onClick={onReview} disabled={!runnable}>
                    {preview.status === 'analyze' ? t('disk.cleanup.analyze') : t('disk.cleanup.review')}
                </Button>
            </div>
        </li>
    );
}

type CleanupDialogProps = {
    serverId: number;
    platform: OpsPlatform;
    initial: CleanupPreview;
    onClose: () => void;
    onDone: () => void;
};

const paramNames = (id: CleanupId) => Object.keys(CLEANUP_PARAM_RULES[id] ?? {}) as Array<keyof CleanupParams>;

// The cleanup with its parameters, what it removes now (measured again for
// these parameters), the command, then the confirmation and the result.
function CleanupDialog({ serverId, platform, initial, onClose, onDone }: CleanupDialogProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const id = initial.id;
    const [params, setParams] = useState<CleanupParams>(initial.params);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<DiskActionResult | null>(null);
    const [failure, setFailure] = useState<unknown>(null);
    const preview = useRemote((signal) => diskApi.cleanupPreview(serverId, id, params, signal), `cleanup:${serverId}:${id}:${JSON.stringify(params)}`, !result);
    const data = preview.data;
    const title = t(`disk.cleanup.items.${id}.title`);
    const ready = data?.status === 'ready';

    const run = async () => {
        setRunning(true);
        setFailure(null);
        try {
            const outcome = await diskApi.runCleanup(serverId, id, params);
            setResult(outcome);
            const freed = outcome.freedBytes !== null ? t('disk.freed', { size: bytes(Math.max(0, outcome.freedBytes), language), mount: outcome.mounts.map((delta) => delta.mount).join(', ') || '—' }) : undefined;
            toast.success(t('disk.cleanup.done', { name: title }), freed);
            onDone();
        } catch (error) {
            setFailure(error);
            toast.error(t('disk.cleanup.failed', { name: title }), errorText(error, t));
        } finally {
            setRunning(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!running}
            title={result ? t('disk.cleanup.resultTitle', { name: title }) : title}
            icon={result ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 text-rose-400" />}
            widthClass="max-w-2xl"
            role={result ? 'dialog' : 'alertdialog'}
            footer={result ? (
                <Button size="sm" variant="primary" onClick={onClose} data-autofocus>{t('disk.cleanup.close')}</Button>
            ) : (
                <>
                    <Button variant="ghost" size="sm" onClick={onClose} disabled={running} data-autofocus>{t('common.cancel')}</Button>
                    <Button variant="danger" size="sm" onClick={() => void run()} loading={running} disabled={!ready || preview.loading}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {data?.bytes ? t('disk.cleanup.confirmSize', { size: formatBytes(data.bytes, language) }) : t('disk.cleanup.confirm')}
                    </Button>
                </>
            )}
        >
            {result ? <CleanupResult result={result} /> : (
                <div className="flex flex-col gap-3 text-sm text-zinc-300">
                    <p>{t(`disk.cleanup.items.${id}.explain`)}</p>
                    {paramNames(id).length > 0 && (
                        <div className="flex flex-wrap gap-3">
                            {paramNames(id).map((name) => {
                                const rule = CLEANUP_PARAM_RULES[id]![name]!;
                                return (
                                    <label key={name} className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-zinc-400">
                                        {t(`disk.cleanup.paramLabels.${name}`)}
                                        <Select
                                            aria-label={t(`disk.cleanup.paramLabels.${name}`)}
                                            value={String(params[name] ?? rule.default)}
                                            onChange={(value) => setParams((current) => ({ ...current, [name]: Number(value) }))}
                                            disabled={running}
                                            options={rule.choices.map((choice) => ({ value: String(choice), label: choiceLabel(t, language, name, choice) }))}
                                        />
                                    </label>
                                );
                            })}
                        </div>
                    )}
                    {preview.error ? (
                        <ErrorNotice error={preview.error} onRetry={preview.reload} />
                    ) : !data || preview.loading ? (
                        <p className="flex items-center gap-2 text-xs text-zinc-400" role="status">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            {t(id === 'win-component-store' ? 'disk.cleanup.analyzing' : 'disk.cleanup.checking')}
                        </p>
                    ) : (
                        <PreviewDetails preview={data} platform={platform} />
                    )}
                    {Boolean(failure) && <ErrorNotice error={failure} title={t('disk.cleanup.failed', { name: title })} />}
                </div>
            )}
        </Modal>
    );
}

function choiceLabel(t: TranslateFn, language: string, name: keyof CleanupParams, choice: number): string {
    if (name === 'keepMB') return formatBytes(choice * 1024 * 1024, language);
    if (choice === 0) return t(name === 'keepDays' ? 'disk.cleanup.params.noAgeLimit' : 'disk.cleanup.params.allAges');
    return t(choice === 1 ? 'disk.cleanup.params.daysOne' : 'disk.cleanup.params.days', { days: choice });
}

function PreviewDetails({ preview, platform }: { preview: CleanupPreview; platform: OpsPlatform }) {
    const t = useT();
    const language = useLanguage();
    // The backend's own wording (English) only as a tooltip, like the card's.
    if (preview.status === 'unavailable') return <Notice tone="locked"><span title={preview.reason?.message}>{reasonText(t, preview, platform)}</span></Notice>;
    if (preview.status === 'nothing') return <Notice>{t('disk.cleanup.nothingNow')}</Notice>;
    const usage = typeof preview.facts?.usage === 'number' ? preview.facts.usage : null;
    return (
        <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-100" role="status">
                <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {preview.count !== null && <strong className="font-semibold">{t(preview.count === 1 ? 'disk.cleanup.removesOne' : 'disk.cleanup.removes', { count: preview.count })}</strong>}
                {preview.count !== null && <span aria-hidden="true">·</span>}
                <span>{estimateText(t, language, preview.bytes, preview.estimate)}</span>
                {preview.mounts.length > 0 && <span className="text-rose-200/80">{t('disk.cleanup.on', { mounts: preview.mounts.join(', ') })}</span>}
            </div>
            {usage !== null && <p className="text-xs text-zinc-400">{t('disk.cleanup.journalUsage', { size: formatBytes(usage, language) })}</p>}
            {typeof preview.facts?.recommended === 'string' && (
                <p className="text-xs text-zinc-400">{t(preview.facts.recommended === 'yes' ? 'disk.cleanup.dismRecommended' : 'disk.cleanup.dismNotRecommended')}</p>
            )}
            {preview.facts?.removal === 'rm' && <p className="text-xs text-zinc-400">{t('disk.cleanup.removedByPath')}</p>}
            {preview.items.length > 0 && (
                <ul className="max-h-56 divide-y divide-white/[0.05] overflow-auto rounded-lg border border-white/[0.06] text-xs" aria-label={t('disk.cleanup.itemsLabel')}>
                    {preview.items.map((item) => (
                        <li key={item.label} className="flex items-center gap-3 px-3 py-1.5">
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200" title={item.label}>{item.label}</span>
                            {item.modifiedAt ? <span className="shrink-0 tabular-nums text-zinc-500">{fileDate(item.modifiedAt, language)}</span> : null}
                            <span className="w-16 shrink-0 text-right tabular-nums text-zinc-300">{bytes(item.bytes, language)}</span>
                        </li>
                    ))}
                </ul>
            )}
            {preview.count !== null && preview.count > preview.items.length && (
                <p className="text-[11px] text-zinc-500">{t('disk.cleanup.moreItems', { count: preview.count - preview.items.length })}</p>
            )}
            <div className="text-xs">
                <div className="mb-1 text-zinc-500">{t('disk.cleanup.command')}</div>
                <code className="block break-all rounded-lg border border-white/[0.06] bg-ink-950/60 px-3 py-2 font-mono text-[11px] text-zinc-200">{preview.command}</code>
            </div>
            <p className="text-xs text-zinc-500">{t(`disk.cleanup.items.${preview.id}.note`)}</p>
        </>
    );
}

function CleanupResult({ result }: { result: DiskActionResult }) {
    const t = useT();
    const language = useLanguage();
    const freed = result.freedBytes;
    return (
        <div className="flex flex-col gap-3 text-sm text-zinc-300">
            <div className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] px-3.5 py-3" role="status">
                <span className="text-xl font-semibold tabular-nums text-zinc-50">{freed !== null ? bytes(Math.max(0, freed), language) : '—'}</span>
                <span className="text-xs text-emerald-100">{freed !== null ? t('disk.cleanup.freedLabel') : t('disk.cleanup.freedUnknown')}</span>
                {result.reportedBytes !== null && (
                    <span className="ml-auto text-[11px] text-zinc-400">{t('disk.cleanup.reported', { size: bytes(result.reportedBytes, language) })}</span>
                )}
            </div>
            {result.mounts.length > 0 && (
                <table className="w-full text-xs">
                    <caption className="sr-only">{t('disk.cleanup.mountsCaption')}</caption>
                    <thead>
                        <tr className="text-left text-[11px] text-zinc-500">
                            <th scope="col" className="pb-1 font-medium">{t('disk.cleanup.columns.mount')}</th>
                            <th scope="col" className="pb-1 text-right font-medium">{t('disk.cleanup.columns.before')}</th>
                            <th scope="col" className="pb-1 text-right font-medium">{t('disk.cleanup.columns.after')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {result.mounts.map((delta) => (
                            <tr key={delta.mount} className="border-t border-white/[0.05]">
                                <td className="py-1 font-mono text-[12px] text-zinc-200">{delta.mount}</td>
                                <td className="py-1 text-right tabular-nums text-zinc-400">{t('disk.cleanup.free', { size: bytes(delta.freeBefore, language) })}</td>
                                <td className="py-1 text-right tabular-nums text-zinc-100">{t('disk.cleanup.free', { size: bytes(delta.freeAfter, language) })}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <details className="group rounded-lg border border-white/[0.06]">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.03] focus-ring [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="h-3.5 w-3.5 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden="true" />
                    {t('disk.cleanup.output')}
                </summary>
                <div className="flex flex-col gap-2 border-t border-white/[0.06] px-3 py-2">
                    <code className="block break-all font-mono text-[11px] text-zinc-400">{result.command}</code>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-200">{result.output || t('disk.cleanup.noOutput')}</pre>
                </div>
            </details>
        </div>
    );
}
