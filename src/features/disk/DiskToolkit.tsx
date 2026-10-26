import { useEffect, useMemo, useState } from 'react';
import { Eraser, FileSearch, FileX2, FolderTree, HardDrive, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { findMount, type DiskAccess, type DiskMount } from '@shared/disk';
import { classify, THRESHOLDS } from '@shared/thresholds';
import { AskAiButton } from '@/components/AskAiButton';
import { Badge, IconButton, Modal, Select, Skeleton, TabPanel, Tabs } from '@/components/ui';
import { useResolvedTheme } from '@/features/appearance/store';
import { ErrorNotice } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { Meter, ToneBadge } from '@/features/status/Meter';
import { vizStyle } from '@/features/status/vizTheme';
import { useLanguage, useT } from '@/i18n';
import { formatBytes, formatPercent } from '@/lib/format';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { clearDiskTarget, peekDiskTarget, type DiskView } from '@/store/diskView';
import type { WorkspaceServer } from '@/workspace/types';
import { diskApi } from './api';
import { Cleanups } from './Cleanups';
import { DeletedFiles } from './DeletedFiles';
import { LargeFiles } from './LargeFiles';
import { limitedHintKey } from './ui';
import { UsageExplorer } from './UsageExplorer';

// The disk-full toolkit of one server (from a filesystem row of the Status
// page, its "Free up space", or the command palette): one filesystem at a
// time, with what fills it (directory explorer, largest files, deleted files
// still held open), the cleanups that free space safely, and "Ask AI why
// it is full".

const ID_PREFIX = 'disk-view';

// The fullest filesystem: what the view opens on when nothing is named.
function fullest(mounts: DiskMount[]): DiskMount | null {
    return mounts.reduce<DiskMount | null>((worst, mount) => (!worst || mount.usagePercent > worst.usagePercent ? mount : worst), null);
}

export default function DiskToolkit({ onClose, server }: GlobalActionProps) {
    if (!server) return null;
    return <Toolkit key={server.id} server={server} onClose={onClose} />;
}

function Toolkit({ server, onClose }: { server: WorkspaceServer; onClose: () => void }) {
    const t = useT();
    const language = useLanguage();
    const theme = useResolvedTheme();
    const [start] = useState(() => peekDiskTarget(server.id));
    useEffect(clearDiskTarget, []);
    const [chosen, setChosen] = useState<string | null>(start.mount);
    const [view, setView] = useState<DiskView>(start.view);
    const [seen, setSeen] = useState<Set<DiskView>>(() => new Set([start.view]));
    const [paths, setPaths] = useState<Record<string, string>>({});
    const overview = useRemote((signal) => diskApi.overview(server.id, signal), `disk:${server.id}`);
    const mounts = useMemo(() => overview.data?.mounts ?? [], [overview.data]);
    // The Status page names a Windows drive "D:", the toolkit "D:\".
    const mount = (chosen !== null ? findMount(mounts, chosen) : null) ?? fullest(mounts);
    const access = overview.data?.access ?? null;
    const platform = access?.platform ?? (server.type === 'windows' ? 'windows' : 'linux');
    const windows = platform === 'windows';

    const show = (next: DiskView) => {
        setView(next);
        setSeen((current) => (current.has(next) ? current : new Set([...current, next])));
    };
    // Keeps what is on screen while it reads again (a new key would drop it).
    const reloadSummary = overview.reload;
    const views: Array<{ id: DiskView; label: string; icon: JSX.Element }> = [
        { id: 'usage', label: t('disk.tabs.usage'), icon: <FolderTree className="h-3.5 w-3.5" /> },
        { id: 'files', label: t('disk.tabs.files'), icon: <FileSearch className="h-3.5 w-3.5" /> },
        ...(windows ? [] : [{ id: 'deleted' as const, label: t('disk.tabs.deleted'), icon: <FileX2 className="h-3.5 w-3.5" /> }]),
        { id: 'cleanup', label: t('disk.tabs.cleanup'), icon: <Eraser className="h-3.5 w-3.5" /> }
    ];
    const current = windows && view === 'deleted' ? 'usage' : view;

    return (
        <Modal
            open
            onClose={onClose}
            title={t('disk.title')}
            description={server.name}
            icon={<HardDrive className="h-4 w-4" />}
            widthClass="max-w-[min(84rem,calc(100vw-2rem))]"
            className="h-[calc(100vh-2rem)]"
            bodyClassName="flex flex-col overflow-hidden p-0"
        >
            <div className="flex min-h-0 flex-1 flex-col [container-type:inline-size]" style={vizStyle(theme)}>
                {overview.error && !overview.data ? (
                    <div className="p-5">
                        <ErrorNotice error={overview.error} title={t('disk.loadFailed', { name: server.name })} onRetry={reloadSummary} />
                    </div>
                ) : !mount || !access ? (
                    <SummarySkeleton />
                ) : (
                    <>
                        <section aria-label={t('disk.summary.label', { mount: mount.mount })} className="flex flex-col gap-3 border-b border-white/[0.06] px-5 py-3.5">
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="w-72 max-w-full">
                                    <Select
                                        aria-label={t('disk.mountPicker')}
                                        value={mount.mount}
                                        onChange={setChosen}
                                        options={mounts.map((entry) => ({
                                            value: entry.mount,
                                            label: t('disk.mountOption', { mount: entry.mount, percent: formatPercent(entry.usagePercent, language) }),
                                            description: [entry.fsType, entry.device, t('disk.summary.freeShort', { size: formatBytes(entry.freeBytes, language) })].filter(Boolean).join(' · ')
                                        }))}
                                    />
                                </div>
                                <AccessBadge access={access} />
                                <div className="ml-auto flex items-center gap-1.5">
                                    <AskAiButton
                                        serverId={server.id}
                                        attachment={{ kind: 'disk', mount: mount.mount }}
                                        prompt={t('disk.ai.prompt', { mount: mount.mount })}
                                        variant="button"
                                        label={t('disk.ai.ask')}
                                        hint={t('disk.ai.hint')}
                                        onAsked={onClose}
                                    />
                                    <IconButton size="md" label={t('disk.summary.refresh')} onClick={reloadSummary}>
                                        <RefreshCw className={overview.loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
                                    </IconButton>
                                </div>
                            </div>
                            <MountSummary mount={mount} windows={windows} />
                            {Boolean(overview.error) && <ErrorNotice error={overview.error} title={t('disk.refreshFailed')} onRetry={reloadSummary} />}
                        </section>

                        <div className="border-b border-white/[0.06] px-4 py-2">
                            <Tabs
                                idPrefix={ID_PREFIX}
                                aria-label={t('disk.tabs.label')}
                                value={current}
                                onChange={(id) => show(id as DiskView)}
                                items={views.map((entry) => ({ id: entry.id, label: entry.label, icon: entry.icon }))}
                            />
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
                            <TabPanel idPrefix={ID_PREFIX} id="usage" active={current === 'usage'}>
                                <UsageExplorer
                                    key={mount.mount}
                                    serverId={server.id}
                                    platform={platform}
                                    mount={mount}
                                    mounts={mounts}
                                    elevated={access.elevated}
                                    enabled={seen.has('usage')}
                                    path={paths[mount.mount] ?? mount.mount}
                                    onPathChange={(path) => setPaths((all) => ({ ...all, [mount.mount]: path }))}
                                    onMountChange={setChosen}
                                    onShowDeleted={windows ? undefined : () => show('deleted')}
                                />
                            </TabPanel>
                            <TabPanel idPrefix={ID_PREFIX} id="files" active={current === 'files'}>
                                <LargeFiles
                                    key={mount.mount}
                                    serverId={server.id}
                                    platform={platform}
                                    mount={mount}
                                    elevated={access.elevated}
                                    enabled={seen.has('files')}
                                    onReveal={(folder) => {
                                        setPaths((all) => ({ ...all, [mount.mount]: folder }));
                                        show('usage');
                                    }}
                                />
                            </TabPanel>
                            {!windows && (
                                <TabPanel idPrefix={ID_PREFIX} id="deleted" active={current === 'deleted'}>
                                    <DeletedFiles key={mount.mount} serverId={server.id} mount={mount} user={access.user} elevated={access.elevated} enabled={seen.has('deleted')} onChanged={reloadSummary} />
                                </TabPanel>
                            )}
                            <TabPanel idPrefix={ID_PREFIX} id="cleanup" active={current === 'cleanup'}>
                                <Cleanups serverId={server.id} platform={platform} mount={mount.mount} enabled={seen.has('cleanup')} onChanged={reloadSummary} />
                            </TabPanel>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

function AccessBadge({ access }: { access: DiskAccess }) {
    const t = useT();
    if (access.elevated) {
        const how = access.platform === 'windows' ? t('disk.access.admin') : access.root ? t('disk.access.root') : t('disk.access.sudo');
        return (
            <Badge tone="success" title={t('disk.access.elevatedHint', { user: access.user })}>
                <ShieldCheck className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{how}
            </Badge>
        );
    }
    return (
        <Badge tone="warning" title={t(limitedHintKey(access.platform))}>
            <ShieldAlert className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{t('disk.access.limited', { user: access.user })}
        </Badge>
    );
}

// Windows has no inode table to speak of: the usage takes the whole row.
function MountSummary({ mount, windows }: { mount: DiskMount; windows: boolean }) {
    const t = useT();
    const language = useLanguage();
    const tone = classify(mount.usagePercent, THRESHOLDS.disk);
    const inodes = mount.inodes;
    const inodeTone = inodes ? classify(inodes.usagePercent, THRESHOLDS.disk) : 'ok';
    const marks = [THRESHOLDS.disk.warn, THRESHOLDS.disk.critical];
    const used = t('disk.summary.used', { used: formatBytes(mount.usedBytes, language), total: formatBytes(mount.totalBytes, language) });
    return (
        <div className={windows ? 'flex flex-col' : 'grid grid-cols-1 gap-x-6 gap-y-3 [@container(min-width:48rem)]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'}>
            <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-50">{formatPercent(mount.usagePercent, language)}</span>
                    <span className="text-xs text-zinc-400">{used}</span>
                    <ToneBadge tone={tone} />
                    <span className="ml-auto text-xs tabular-nums text-zinc-300">{t('disk.summary.free', { size: formatBytes(mount.freeBytes, language) })}</span>
                </div>
                <Meter value={mount.usagePercent} tone={tone} marks={marks} label={t('disk.summary.meter', { mount: mount.mount })} valueText={`${formatPercent(mount.usagePercent, language)} · ${used}`} />
                <div className="flex flex-wrap gap-x-2 text-[11px] text-zinc-500">
                    <span className="font-mono text-zinc-300">{mount.mount}</span>
                    {mount.fsType && <span>{mount.fsType}</span>}
                    <span className="truncate" title={mount.device}>{mount.device}</span>
                    {mount.readOnly && <Badge tone="warning">{t('disk.summary.readOnly')}</Badge>}
                </div>
            </div>
            {!windows && <div className="flex min-w-0 flex-col justify-center gap-1.5">
                {inodes ? (
                    <>
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="text-zinc-400">{t('disk.summary.inodes')}</span>
                            <span className="inline-flex items-center gap-1.5 tabular-nums text-zinc-200">
                                <ToneBadge tone={inodeTone} />
                                {formatPercent(inodes.usagePercent, language)}
                            </span>
                        </div>
                        <Meter size="md" value={inodes.usagePercent} tone={inodeTone} marks={marks} label={t('disk.summary.inodesMeter', { mount: mount.mount })} valueText={t('disk.summary.inodesText', { percent: formatPercent(inodes.usagePercent, language), free: inodes.free.toLocaleString(language) })} />
                        <span className="text-[11px] text-zinc-500">{t('disk.summary.inodesFree', { free: inodes.free.toLocaleString(language) })}</span>
                    </>
                ) : (
                    <span className="text-[11px] text-zinc-500">{t('disk.summary.noInodes')}</span>
                )}
            </div>}
        </div>
    );
}

function SummarySkeleton() {
    const t = useT();
    return (
        <div className="flex flex-col gap-3 px-5 py-4" role="status" aria-label={t('disk.loading')}>
            <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-72" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="ml-auto h-8 w-40" />
            </div>
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="mt-4 h-8 w-96" />
            {[0, 1, 2, 3, 4].map((row) => <Skeleton key={row} className="h-6 w-full" />)}
        </div>
    );
}
