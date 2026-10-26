import { useMemo, useState } from 'react';
import { AlertTriangle, Eraser, HardDrive, Layers, RefreshCw, Trash2 } from 'lucide-react';
import type { DiskUsageKind, DiskUsageRow, ImageInfo, OpsCapabilities, PruneMode } from '@shared/ops';
import { Button, Menu, Modal, useConfirm, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { opsApi } from './api';
import { errorText } from './errors';
import { formatTimestamp } from './format';
import { EmptyState, ErrorNotice, SearchField, Segmented, StateBadge, StatTile, ToolButton, countKey } from './ui';
import { useRemote } from './useRemote';

// The engine's images and disk space: what each image is used by, what a
// prune would remove (previewed with the space it frees, then confirmed),
// and single image removal (refused by the engine while a container uses it).

type Filter = 'all' | 'used' | 'unused' | 'dangling';

const USAGE_KINDS: DiskUsageKind[] = ['images', 'containers', 'volumes', 'build-cache'];

const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12);

function matches(image: ImageInfo, filter: Filter): boolean {
    if (filter === 'used') return image.containers > 0;
    if (filter === 'unused') return image.containers === 0;
    if (filter === 'dangling') return image.dangling;
    return true;
}

type ImagesViewProps = {
    serverId: number;
    caps: OpsCapabilities;
};

export function ImagesView({ serverId, caps }: ImagesViewProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [removing, setRemoving] = useState<string | null>(null);
    const [pruning, setPruning] = useState<PruneMode | null>(null);

    const list = useRemote((signal) => opsApi.images(serverId, signal), `images:${serverId}`);
    const usage = useRemote((signal) => opsApi.diskUsage(serverId, signal), `disk-usage:${serverId}`);
    const images = useMemo(() => list.data?.images ?? [], [list.data]);
    const counts = useMemo(() => ({
        all: images.length,
        used: images.filter((image) => matches(image, 'used')).length,
        unused: images.filter((image) => matches(image, 'unused')).length,
        dangling: images.filter((image) => matches(image, 'dangling')).length
    }), [images]);
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return images.filter((image) => matches(image, filter) && (!needle || (image.reference ?? '').toLowerCase().includes(needle) || image.id.includes(needle)));
    }, [images, filter, query]);

    const size = (bytes: number | null) => (bytes === null ? '—' : formatBytes(bytes, language));
    const refresh = () => {
        list.reload();
        usage.reload();
    };

    const remove = async (image: ImageInfo) => {
        const name = image.reference ?? shortId(image.id);
        const ok = await confirm({
            title: t('ops.images.confirmRemove.title', { name }),
            message: image.reference ? t('ops.images.confirmRemove.tagged', { name }) : t('ops.images.confirmRemove.untagged'),
            confirmLabel: t('ops.images.remove'),
            tone: 'danger'
        });
        if (!ok) return;
        setRemoving(image.reference ?? image.id);
        try {
            await opsApi.removeImage(serverId, image.reference ?? image.id);
            toast.success(t('ops.images.removed', { name }));
        } catch (error) {
            toast.error(t('ops.images.removeFailed', { name }), errorText(error, t));
        } finally {
            setRemoving(null);
            refresh();
        }
    };

    const usageRow = (kind: DiskUsageKind): DiskUsageRow | undefined => usage.data?.rows.find((row) => row.kind === kind);
    const docker = caps.containers.engine === 'docker';
    const pruneModes: PruneMode[] = docker ? ['dangling', 'unused', 'build-cache'] : ['dangling', 'unused'];

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* The panel is narrow next to the chat on a wide window: the layout follows its width, not the window's. */}
            <section aria-label={t('ops.images.usage.title')} className="border-b border-white/[0.06] px-4 py-3 [container-type:inline-size]">
                {usage.error ? (
                    <ErrorNotice error={usage.error} title={t('ops.images.usage.failed')} onRetry={usage.reload} />
                ) : (
                    <div className="grid grid-cols-2 gap-2 [@container(min-width:40rem)]:grid-cols-4" aria-busy={usage.loading}>
                        {USAGE_KINDS.map((kind) => {
                            const row = usageRow(kind);
                            const loading = usage.loading && !usage.data;
                            return (
                                <StatTile
                                    key={kind}
                                    label={t(`ops.images.usage.${kind}`)}
                                    value={loading ? <span className="inline-block h-4 w-16 animate-pulse rounded bg-white/[0.06] align-middle" /> : size(row?.size ?? null)}
                                    hint={loading ? undefined : row && row.reclaimable
                                        ? t('ops.images.usage.reclaimable', { size: size(row.reclaimable) })
                                        : row?.count !== null && row?.count !== undefined ? t('ops.images.usage.count', { count: row.count }) : undefined}
                                    tone={row?.size && row.reclaimable && row.reclaimable / row.size > 0.5 ? 'warn' : undefined}
                                />
                            );
                        })}
                    </div>
                )}
            </section>

            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('ops.images.search')} className="w-full max-w-xs flex-1" />
                <Segmented<Filter>
                    label={t('ops.images.filterLabel')}
                    value={filter}
                    onChange={setFilter}
                    options={(['all', 'used', 'unused', 'dangling'] as const).map((value) => ({ value, label: t(`ops.images.filter.${value}`), count: counts[value] }))}
                />
                <div className="ml-auto flex items-center gap-1.5">
                    <Menu
                        label={t('ops.images.cleanUp')}
                        triggerClassName="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/30 px-2.5 text-xs font-medium text-rose-200 hover:bg-rose-500/10"
                        items={pruneModes.map((mode) => ({
                            id: mode,
                            label: t(`ops.images.prune.${mode}.menu`),
                            icon: <Eraser className="h-4 w-4" />,
                            onSelect: () => setPruning(mode)
                        }))}
                    >
                        <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{t('ops.images.cleanUp')}</span>
                    </Menu>
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('ops.refresh')} onClick={refresh} busy={list.loading} />
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto [container-type:inline-size]">
                {list.error ? (
                    <ErrorNotice error={list.error} onRetry={list.reload} className="m-4" />
                ) : list.loading && !list.data ? (
                    <div className="space-y-2 p-4" aria-hidden="true">
                        {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-9 animate-pulse rounded-lg bg-white/[0.03]" />)}
                    </div>
                ) : visible.length === 0 ? (
                    <EmptyState icon={<Layers className="h-5 w-5" />} title={images.length ? t('ops.images.noMatch') : t('ops.images.empty')} />
                ) : (
                    <table className="w-full table-fixed text-xs">
                        <caption className="sr-only">{t('ops.images.caption', { count: visible.length })}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <th scope="col" className="px-4 py-2 font-medium">{t('ops.images.columns.image')}</th>
                                <th scope="col" className="w-20 px-2 py-2 text-right font-medium">{t('ops.images.columns.size')}</th>
                                <th scope="col" className="hidden w-44 px-2 py-2 font-medium [@container(min-width:40rem)]:table-cell">{t('ops.images.columns.created')}</th>
                                <th scope="col" className="w-28 px-2 py-2 font-medium">{t('ops.images.columns.usage')}</th>
                                <th scope="col" className="w-14 px-2 py-2 pr-4"><span className="sr-only">{t('ops.images.columns.actions')}</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((image) => {
                                const key = `${image.id}-${image.reference ?? ''}`;
                                const name = image.reference ?? shortId(image.id);
                                const busy = removing === (image.reference ?? image.id);
                                return (
                                    <tr key={key} className="border-b border-white/[0.04]">
                                        <td className="px-4 py-1.5">
                                            <div className={cn('truncate font-medium', image.reference ? 'text-zinc-100' : 'italic text-zinc-400')} title={image.reference ?? image.id}>
                                                {image.reference ?? t('ops.images.untagged')}
                                            </div>
                                            <div className="truncate text-[11px] text-zinc-500">
                                                <span className="font-mono">{shortId(image.id)}</span>
                                                {/* Without the Created column, its date goes here. */}
                                                <span className="[@container(min-width:40rem)]:hidden" title={image.createdSince ?? undefined}> · {formatTimestamp(image.createdAt, language)}</span>
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{size(image.size)}</td>
                                        <td className="hidden truncate px-2 py-1.5 text-zinc-400 [@container(min-width:40rem)]:table-cell" title={image.createdSince ?? undefined}>
                                            {formatTimestamp(image.createdAt, language)}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            {image.dangling ? (
                                                <StateBadge tone="warn" label={t('ops.images.dangling')} />
                                            ) : image.containers > 0 ? (
                                                <StateBadge tone="ok" label={t(countKey('ops.images.usedBy', image.containers), { count: image.containers })} />
                                            ) : (
                                                <StateBadge tone="idle" label={t('ops.images.unused')} />
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 pr-4 text-right">
                                            <ToolButton
                                                compact
                                                tone="danger"
                                                icon={<Trash2 className="h-4 w-4" />}
                                                label={t('ops.images.removeName', { name })}
                                                busy={busy}
                                                disabled={removing !== null || image.containers > 0}
                                                disabledReason={image.containers > 0 ? t(countKey('ops.images.inUse', image.containers), { count: image.containers }) : undefined}
                                                onClick={() => void remove(image)}
                                            />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {pruning && (
                <PruneDialog
                    serverId={serverId}
                    mode={pruning}
                    onClose={() => setPruning(null)}
                    onDone={refresh}
                />
            )}
        </div>
    );
}

type PruneDialogProps = {
    serverId: number;
    mode: PruneMode;
    onClose: () => void;
    onDone: () => void;
};

// What the prune removes now and the space it frees, then the confirmation.
function PruneDialog({ serverId, mode, onClose, onDone }: PruneDialogProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const [running, setRunning] = useState(false);
    const preview = useRemote((signal) => opsApi.prunePreview(serverId, mode, signal), `prune:${serverId}:${mode}`);
    const data = preview.data;
    const count = data?.images.length ?? 0;
    const nothing = Boolean(data && (mode === 'build-cache' ? !data.bytes : count === 0));

    const run = async () => {
        setRunning(true);
        try {
            const result = await opsApi.prune(serverId, mode);
            toast.success(
                t(`ops.images.prune.${mode}.done`),
                result.reclaimedBytes !== null ? t('ops.images.prune.freed', { size: formatBytes(result.reclaimedBytes, language) }) : undefined
            );
            onDone();
            onClose();
        } catch (error) {
            toast.error(t('ops.images.prune.failed'), errorText(error, t));
            setRunning(false);
        }
    };

    const estimate = data && data.bytes !== null
        ? t(`ops.images.prune.estimate.${data.estimate}`, { size: formatBytes(data.bytes, language) })
        : null;

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!running}
            title={t(`ops.images.prune.${mode}.title`)}
            icon={<AlertTriangle className="h-4 w-4 text-rose-400" />}
            widthClass="max-w-lg"
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={onClose} disabled={running} data-autofocus>
                        {t('common.cancel')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void run()} loading={running} disabled={!data || nothing}>
                        {mode === 'build-cache' ? t('ops.images.prune.build-cache.confirm') : t(countKey('ops.images.prune.confirm', count), { count })}
                    </Button>
                </>
            }
        >
            <div className="space-y-3 text-sm text-zinc-300">
                <p>{t(`ops.images.prune.${mode}.explain`)}</p>
                {preview.error ? (
                    <ErrorNotice error={preview.error} onRetry={preview.reload} />
                ) : !data ? (
                    <div className="flex items-center gap-2 text-xs text-zinc-400" role="status">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        {t('ops.images.prune.checking')}
                    </div>
                ) : nothing ? (
                    <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-zinc-400" role="status">{t(`ops.images.prune.${mode}.nothing`)}</p>
                ) : (
                    <>
                        <div className="flex items-center gap-2 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-100" role="status">
                            <HardDrive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>
                                {mode !== 'build-cache' && <strong className="font-semibold">{t(countKey('ops.images.prune.count', count), { count })}</strong>}
                                {mode !== 'build-cache' && estimate ? ' · ' : ''}
                                {estimate}
                            </span>
                        </div>
                        {count > 0 && (
                            <ul className="max-h-56 divide-y divide-white/[0.05] overflow-auto rounded-lg border border-white/[0.06] text-xs" aria-label={t('ops.images.prune.listLabel')}>
                                {data.images.map((image) => (
                                    <li key={image.id} className="flex items-center gap-2 px-3 py-1.5">
                                        <span className={cn('min-w-0 flex-1 truncate', image.reference ? 'text-zinc-200' : 'italic text-zinc-400')}>
                                            {image.reference ?? t('ops.images.untagged')}
                                        </span>
                                        <span className="shrink-0 font-mono text-[11px] text-zinc-500">{shortId(image.id)}</span>
                                        <span className="w-16 shrink-0 text-right tabular-nums text-zinc-400">{image.size !== null ? formatBytes(image.size, language) : '—'}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="text-xs text-zinc-500">{t(`ops.images.prune.${mode}.note`)}</p>
                    </>
                )}
            </div>
        </Modal>
    );
}
