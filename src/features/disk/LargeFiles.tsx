import { useRef, useState } from 'react';
import { FileSearch, FolderOpen, RefreshCw } from 'lucide-react';
import { DEFAULT_LARGE_FILE_MB, LARGE_FILE_THRESHOLDS_MB, isWithinMount, type DiskMount } from '@shared/disk';
import type { OpsPlatform } from '@shared/ops';
import { Button, IconButton } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { formatAgo } from '@/features/status/format';
import { useNow } from '@/features/status/hooks';
import { EmptyState, ErrorNotice, Segmented } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { diskApi } from './api';
import { Notice, SizeBar, bytes, fileDate, limitedHintKey } from './ui';

// The largest files of the filesystem (one search per threshold, kept by
// the backend for a while): what they are, when they last changed and who
// owns them, and a way to see their folder in the explorer.

type LargeFilesProps = {
    serverId: number;
    platform: OpsPlatform;
    mount: DiskMount;
    elevated: boolean;
    enabled: boolean;
    onReveal: (folder: string) => void;
};

// The folder a file is in (its filesystem's root at the most).
function folderOf(platform: OpsPlatform, path: string, mount: string): string {
    const separator = platform === 'windows' ? '\\' : '/';
    const index = path.lastIndexOf(separator);
    let folder = index > 0 ? path.slice(0, index) : separator;
    if (platform === 'windows' && /^[A-Z]:$/i.test(folder)) folder = `${folder}\\`;
    return isWithinMount(platform, folder, mount) ? folder : mount;
}

export function LargeFiles({ serverId, platform, mount, elevated, enabled, onReveal }: LargeFilesProps) {
    const t = useT();
    const language = useLanguage();
    const now = useNow(15_000);
    const [minMB, setMinMB] = useState<number>(DEFAULT_LARGE_FILE_MB);
    const [nonce, setNonce] = useState(0);
    const rescan = useRef(false);
    const search = useRemote((signal) => {
        const fresh = rescan.current;
        rescan.current = false;
        return diskApi.largeFiles(serverId, mount.mount, minMB, fresh, signal);
    }, `large:${serverId}:${mount.mount}:${minMB}:${nonce}`, enabled);
    const data = search.data;
    const threshold = formatBytes(minMB * 1024 * 1024, language);
    const largest = data?.files[0]?.bytes ?? 0;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-400">{t('disk.files.threshold')}</span>
                <Segmented<string>
                    label={t('disk.files.threshold')}
                    value={String(minMB)}
                    onChange={(value) => setMinMB(Number(value))}
                    options={LARGE_FILE_THRESHOLDS_MB.map((value) => ({ value: String(value), label: formatBytes(value * 1024 * 1024, language) }))}
                />
                <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
                    {data && <span className="tabular-nums">{t(data.cached ? 'disk.files.searchedCached' : 'disk.files.searched', { ago: formatAgo(data.collectedAt, now, t) })}</span>}
                    <Button
                        size="sm"
                        variant="subtle"
                        loading={search.loading && Boolean(data)}
                        onClick={() => {
                            rescan.current = true;
                            setNonce((value) => value + 1);
                        }}
                    >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('disk.files.rescan')}
                    </Button>
                </div>
            </div>

            {search.error ? (
                <ErrorNotice error={search.error} title={t('disk.files.failed')} onRetry={search.reload} />
            ) : !data ? (
                <p className="flex items-center gap-2 py-6 text-xs text-zinc-400" role="status">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t('disk.files.searching', { mount: mount.mount, size: threshold })}
                </p>
            ) : (
                <>
                    {data.timedOut && <Notice tone="warn">{t('disk.files.timedOut')}</Notice>}
                    {data.denied > 0 && (
                        <Notice tone={elevated ? 'info' : 'locked'}>
                            {t(data.denied === 1 ? 'disk.usage.deniedOne' : 'disk.usage.denied', { count: data.denied })}
                            {!elevated && ` ${t(limitedHintKey(platform))}`}
                        </Notice>
                    )}
                    {data.files.length === 0 ? (
                        <EmptyState icon={<FileSearch className="h-5 w-5" />} title={t('disk.files.none', { size: threshold, mount: mount.mount })} />
                    ) : (
                        <div className={cn('overflow-x-auto rounded-xl border border-white/[0.06] bg-ink-900/40', search.loading && 'opacity-60')} aria-busy={search.loading || undefined}>
                            <table className="w-full min-w-[40rem] table-fixed text-xs">
                                <caption className="sr-only">{t('disk.files.caption', { size: threshold, mount: mount.mount })}</caption>
                                <thead>
                                    <tr className="border-b border-white/[0.06] text-left text-[11px] text-zinc-500">
                                        <th scope="col" className="w-36 px-3 py-1.5 text-right font-medium">{t('disk.files.columns.size')}</th>
                                        <th scope="col" className="px-3 py-1.5 font-medium">{t('disk.files.columns.file')}</th>
                                        <th scope="col" className="w-28 px-3 py-1.5 font-medium">{t('disk.files.columns.modified')}</th>
                                        <th scope="col" className="w-24 px-3 py-1.5 font-medium">{t('disk.files.columns.owner')}</th>
                                        <th scope="col" className="w-12 px-3 py-1.5"><span className="sr-only">{t('disk.files.columns.actions')}</span></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.04]">
                                    {data.files.map((file) => (
                                        <tr key={file.path} className="hover:bg-white/[0.02]">
                                            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-100">
                                                <div className="flex items-center justify-end gap-2.5">
                                                    <SizeBar share={largest ? file.bytes / largest : 0} className="w-12 shrink-0" />
                                                    <span className="w-16 shrink-0">{bytes(file.bytes, language)}</span>
                                                </div>
                                            </td>
                                            <td className="truncate px-3 py-1.5 font-mono text-[12px] text-zinc-200" title={file.path}>{file.path}</td>
                                            <td className="px-3 py-1.5 tabular-nums text-zinc-400">{fileDate(file.modifiedAt, language)}</td>
                                            <td className="truncate px-3 py-1.5 text-zinc-400" title={file.owner ?? undefined}>{file.owner ?? '—'}</td>
                                            <td className="px-2 py-1 text-right">
                                                <IconButton size="sm" variant="ghost" label={t('disk.files.reveal', { path: file.path })} onClick={() => onReveal(folderOf(platform, file.path, mount.mount))}>
                                                    <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                                                </IconButton>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
