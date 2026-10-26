import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, File, Folder, HardDrive, Link2, RefreshCw } from 'lucide-react';
import { DEFAULT_DISK_SCAN_BUDGET, DISK_SCAN_BUDGETS, pathTrail, parentPath, type DirectoryListing, type DiskEntry, type DiskMount } from '@shared/disk';
import type { OpsPlatform } from '@shared/ops';
import { Badge, Button, IconButton, Skeleton } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatAgo } from '@/features/status/format';
import { useNow } from '@/features/status/hooks';
import { EmptyState, ErrorNotice } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { diskApi } from './api';
import { Notice, SizeBar, bytes, limitedHintKey, shareText } from './ui';

// One level of a directory, largest first: drill into a folder, go back up
// with the breadcrumb or the Up button. Scans run on the server with a time
// budget and are cached there; "Rescan" asks again.

type UsageExplorerProps = {
    serverId: number;
    platform: OpsPlatform;
    mount: DiskMount;
    mounts: DiskMount[];
    elevated: boolean;
    // The tab is (or was) on screen: nothing loads before.
    enabled: boolean;
    path: string;
    onPathChange: (path: string) => void;
    onMountChange: (mount: string) => void;
    // Linux: shows the deleted files still held open (when df and du disagree).
    onShowDeleted?: () => void;
};

const LONGEST_BUDGET = DISK_SCAN_BUDGETS[DISK_SCAN_BUDGETS.length - 1];

export function UsageExplorer({ serverId, platform, mount, mounts, elevated, enabled, path, onPathChange, onMountChange, onShowDeleted }: UsageExplorerProps) {
    const t = useT();
    const language = useLanguage();
    const now = useNow(15_000);
    const [budget, setBudget] = useState<number>(DEFAULT_DISK_SCAN_BUDGET);
    const [nonce, setNonce] = useState(0);
    const rescan = useRef(false);
    const heading = useRef<HTMLHeadingElement>(null);
    const moved = useRef(false);

    const listing = useRemote((signal) => {
        const fresh = rescan.current;
        rescan.current = false;
        return diskApi.usage(serverId, path, { budget, rescan: fresh }, signal);
    }, `usage:${serverId}:${path}:${budget}:${nonce}`, enabled);
    const data = listing.data;

    // After moving to another folder, the focus goes to its heading (the
    // button that moved there is gone).
    useEffect(() => {
        if (moved.current && data && !listing.loading) {
            moved.current = false;
            heading.current?.focus();
        }
    }, [data, listing.loading]);

    const go = (next: string) => {
        moved.current = true;
        onPathChange(next);
    };
    const scanAgain = (seconds = budget) => {
        rescan.current = true;
        setBudget(seconds);
        setNonce((value) => value + 1);
    };
    const parent = parentPath(platform, path, mount.mount);
    const trail = pathTrail(platform, path, mount.mount);
    const total = data ? data.totalBytes ?? data.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) : null;
    const mountAt = (entryPath: string) => mounts.find((candidate) => candidate.mount === entryPath && candidate.mount !== mount.mount);

    return (
        <div className="flex min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <IconButton
                    size="sm"
                    label={t('disk.usage.up')}
                    disabledReason={parent === null ? t('disk.usage.atTop') : undefined}
                    onClick={() => parent !== null && go(parent)}
                >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                </IconButton>
                <nav aria-label={t('disk.usage.breadcrumb')} className="min-w-0 flex-1">
                    <ol className="flex flex-wrap items-center gap-0.5 font-mono text-[12px]">
                        {trail.map((step, index) => {
                            const last = index === trail.length - 1;
                            return (
                                <li key={step.path} className="flex min-w-0 items-center gap-0.5">
                                    {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden="true" />}
                                    {last ? (
                                        <h3 ref={heading} tabIndex={-1} aria-current="page" className="truncate rounded px-1 py-0.5 font-semibold text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-focus" title={step.path}>
                                            {step.name}
                                        </h3>
                                    ) : (
                                        <button type="button" onClick={() => go(step.path)} className="truncate rounded px-1 py-0.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 focus-ring" title={step.path}>
                                            {step.name}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                </nav>
                <div className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-500">
                    {data && (
                        <span className="tabular-nums" title={data.cached ? t('disk.usage.cachedHint') : undefined}>
                            {t(data.cached ? 'disk.usage.scannedCached' : 'disk.usage.scanned', { ago: formatAgo(data.collectedAt, now, t) })}
                        </span>
                    )}
                    <Button size="sm" variant="subtle" onClick={() => scanAgain()} loading={listing.loading && Boolean(data)} disabled={!enabled}>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('disk.usage.rescan')}
                    </Button>
                </div>
            </div>

            {listing.error ? (
                <ErrorNotice error={listing.error} title={t('disk.usage.failed', { path })} onRetry={listing.reload} />
            ) : !data ? (
                <ScanSkeleton path={path} budget={budget} />
            ) : (
                <>
                    <Notes listing={data} elevated={elevated} platform={platform} onLonger={data.budgetSeconds < LONGEST_BUDGET ? () => scanAgain(LONGEST_BUDGET) : undefined} />
                    <Unaccounted listing={data} mount={mount} platform={platform} onShowDeleted={onShowDeleted} />
                    {data.entries.length === 0 ? (
                        <EmptyState icon={<Folder className="h-5 w-5" />} title={t('disk.usage.empty')} />
                    ) : (
                        <div aria-busy={listing.loading || undefined} className={cn('rounded-xl border border-white/[0.06] bg-ink-900/40 motion-safe:transition-opacity', listing.loading && 'opacity-60')}>
                            <div aria-hidden="true" className="grid grid-cols-[1rem_minmax(0,1fr)_5.5rem_3.5rem_1rem] items-center gap-3 border-b border-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-zinc-500 [@container(min-width:44rem)]:grid-cols-[1rem_minmax(0,1fr)_minmax(6rem,14rem)_5.5rem_3.5rem_1rem]">
                                <span />
                                <span>{t('disk.usage.columns.name')}</span>
                                <span className="hidden [@container(min-width:44rem)]:block" />
                                <span className="text-right">{t('disk.usage.columns.size')}</span>
                                <span className="text-right">{t('disk.usage.columns.share')}</span>
                                <span />
                            </div>
                            <ul aria-label={t('disk.usage.listLabel', { path })} className="divide-y divide-white/[0.04]">
                                {data.entries.map((entry) => (
                                    <EntryRow
                                        key={entry.path}
                                        entry={entry}
                                        total={total}
                                        language={language}
                                        otherMount={entry.otherFs ? mountAt(entry.path) : undefined}
                                        onOpen={go}
                                        onMount={onMountChange}
                                    />
                                ))}
                            </ul>
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2 text-[11px] text-zinc-500">
                                <span>
                                    {data.omitted
                                        ? t('disk.usage.omitted', { count: data.omitted.count, size: bytes(data.omitted.bytes, language) })
                                        : t(data.entries.length === 1 ? 'disk.usage.countOne' : 'disk.usage.count', { count: data.entries.length })}
                                </span>
                                <span className="tabular-nums text-zinc-300">
                                    {data.totalBytes !== null ? t('disk.usage.total', { size: bytes(data.totalBytes, language) }) : t('disk.usage.totalPartial', { size: bytes(total, language) })}
                                </span>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function ScanSkeleton({ path, budget }: { path: string; budget: number }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-xs text-zinc-400">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t('disk.usage.scanning', { path, seconds: budget })}
            </p>
            <div className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] p-3" aria-hidden="true">
                {['w-40', 'w-32', 'w-24', 'w-20', 'w-14', 'w-10'].map((width) => (
                    <div key={width} className="flex items-center gap-3">
                        <Skeleton className="h-3.5 w-3.5 rounded" />
                        <Skeleton className="h-3 flex-1" />
                        <Skeleton className={cn('h-1.5', width)} />
                        <Skeleton className="h-3 w-14" />
                    </div>
                ))}
            </div>
        </div>
    );
}

function Notes({ listing, elevated, platform, onLonger }: { listing: DirectoryListing; elevated: boolean; platform: OpsPlatform; onLonger?: () => void }) {
    const t = useT();
    return (
        <>
            {listing.timedOut && (
                <Notice
                    tone="warn"
                    action={onLonger && (
                        <Button size="sm" variant="subtle" onClick={onLonger} className="h-7">
                            {t('disk.usage.longer', { minutes: LONGEST_BUDGET / 60 })}
                        </Button>
                    )}
                >
                    {t('disk.usage.timedOut', { seconds: listing.budgetSeconds })}
                </Notice>
            )}
            {listing.denied > 0 && (
                <Notice tone={elevated ? 'info' : 'locked'}>
                    {t(listing.denied === 1 ? 'disk.usage.deniedOne' : 'disk.usage.denied', { count: listing.denied })}
                    {!elevated && ` ${t(limitedHintKey(platform))}`}
                </Notice>
            )}
        </>
    );
}

// Filesystems whose "used" is not the files below the mount alone (the
// host's disk under a container's overlay, pools shared by datasets).
const SHARED_SPACE = new Set(['overlay', 'btrfs', 'zfs', 'bcachefs', 'tmpfs']);

// At the root of a filesystem, files that add up to clearly less than what
// df reports used: the rest is held by deleted files still open (the usual
// cause), hidden under a mount point, or (Windows) system files the walk
// cannot read.
function Unaccounted({ listing, mount, platform, onShowDeleted }: { listing: DirectoryListing; mount: DiskMount; platform: OpsPlatform; onShowDeleted?: () => void }) {
    const t = useT();
    const language = useLanguage();
    if (listing.path !== mount.mount || listing.totalBytes === null || listing.timedOut || listing.denied > 0 || SHARED_SPACE.has(mount.fsType ?? '')) return null;
    const gap = mount.usedBytes - listing.totalBytes;
    if (gap < Math.max(16 * 1024 * 1024, mount.usedBytes * 0.03)) return null;
    const values = { found: bytes(listing.totalBytes, language), used: bytes(mount.usedBytes, language), gap: bytes(gap, language) };
    return (
        <Notice
            tone="warn"
            action={onShowDeleted && (
                <Button size="sm" variant="subtle" onClick={onShowDeleted} className="h-7">{t('disk.usage.gapAction')}</Button>
            )}
        >
            {t(platform === 'windows' ? 'disk.usage.gapWindows' : 'disk.usage.gap', values)}
        </Notice>
    );
}

type EntryRowProps = {
    entry: DiskEntry;
    total: number | null;
    language: string;
    otherMount?: DiskMount;
    onOpen: (path: string) => void;
    onMount: (mount: string) => void;
};

const ROW = 'grid w-full grid-cols-[1rem_minmax(0,1fr)_5.5rem_3.5rem_1rem] items-center gap-3 px-3 py-1.5 text-left text-xs [@container(min-width:44rem)]:grid-cols-[1rem_minmax(0,1fr)_minmax(6rem,14rem)_5.5rem_3.5rem_1rem]';

function EntryRow({ entry, total, language, otherMount, onOpen, onMount }: EntryRowProps) {
    const t = useT();
    const size = entry.bytes === null ? t('disk.usage.notMeasured') : bytes(entry.bytes, language);
    const share = shareText(entry.bytes, total, language);
    const Icon = entry.otherFs ? HardDrive : entry.kind === 'dir' ? Folder : entry.kind === 'other' ? Link2 : File;
    const opens = entry.kind === 'dir' && !entry.otherFs;
    const content = (
        <>
            <Icon className={cn('h-4 w-4', entry.kind === 'dir' ? 'text-brand-300' : 'text-zinc-500')} aria-hidden="true" />
            <span className="flex min-w-0 items-center gap-2">
                <span className={cn('truncate font-mono text-[12px]', entry.kind === 'dir' ? 'text-zinc-100' : 'text-zinc-300')} title={entry.path}>{entry.name}</span>
                {entry.otherFs && <Badge tone="info">{t(otherMount ? 'disk.usage.otherFs' : 'disk.usage.notFollowed')}</Badge>}
                {entry.partial && <Badge tone="warning">{t('disk.usage.partial')}</Badge>}
            </span>
            <SizeBar share={total && entry.bytes ? entry.bytes / total : 0} className="hidden [@container(min-width:44rem)]:block" />
            <span className={cn('text-right tabular-nums', entry.bytes === null ? 'text-zinc-500' : 'text-zinc-200')}>{size}</span>
            <span className="text-right tabular-nums text-zinc-500">{share}</span>
            {opens || otherMount ? <ChevronRight className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> : <span />}
        </>
    );
    const label = `${entry.name}, ${size}${share ? `, ${share}` : ''}`;
    if (opens) {
        return (
            <li>
                <button type="button" onClick={() => onOpen(entry.path)} aria-label={t('disk.usage.open', { item: label })} className={cn(ROW, 'hover:bg-white/[0.04] focus-ring')}>
                    {content}
                </button>
            </li>
        );
    }
    if (otherMount) {
        return (
            <li>
                <button type="button" onClick={() => onMount(otherMount.mount)} aria-label={t('disk.usage.openMount', { mount: otherMount.mount })} className={cn(ROW, 'hover:bg-white/[0.04] focus-ring')}>
                    {content}
                </button>
            </li>
        );
    }
    return <li className={ROW}>{content}</li>;
}
