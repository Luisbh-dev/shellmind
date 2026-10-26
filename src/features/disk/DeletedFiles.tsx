import { useState } from 'react';
import { Box, CheckCircle2, Cog, FileSearch, MoreHorizontal, RefreshCw, RotateCw, Scissors, Square } from 'lucide-react';
import type { DeletedOpenFile, DeletedReleaseAction, DiskActionResult, DiskMount } from '@shared/disk';
import { Badge, Button, Menu, useConfirm, useToast, type MenuItem } from '@/components/ui';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { EmptyState, ErrorNotice } from '@/features/ops/ui';
import { errorText } from '@/features/ops/errors';
import { useRemote } from '@/features/ops/useRemote';
import { diskApi } from './api';
import { Notice, bytes } from './ui';

// Files deleted while a process still holds them: their space only comes
// back when the process lets go. Each can be released by restarting what
// runs the process (its systemd unit or container), by emptying the file in
// place through /proc (the process keeps running), or by stopping the
// process. Every action is confirmed, checked again on the server and
// recorded in the audit log.

type DeletedFilesProps = {
    serverId: number;
    mount: DiskMount;
    // Who the scan runs as (without elevation, only their processes are seen).
    user: string;
    elevated: boolean;
    enabled: boolean;
    // A release changed the disk: the summary reads it again.
    onChanged: () => void;
};

const ACTION_ICONS: Record<DeletedReleaseAction, typeof RotateCw> = {
    'restart-service': RotateCw,
    'restart-container': Box,
    truncate: Scissors,
    terminate: Square
};

// What each release does, said before it runs.
function confirmText(t: TranslateFn, language: string, action: DeletedReleaseAction, file: DeletedOpenFile): { title: string; message: string; confirm: string } {
    const values = { process: file.process, pid: file.pid, path: file.path, size: bytes(file.bytes, language), unit: file.unit ?? '', container: file.container ?? '' };
    return {
        title: t(`disk.deleted.confirm.${action}.title`, values),
        message: t(`disk.deleted.confirm.${action}.message`, values),
        confirm: t(`disk.deleted.confirm.${action}.confirm`, values)
    };
}

export function DeletedFiles({ serverId, mount, user, elevated, enabled, onChanged }: DeletedFilesProps) {
    const t = useT();
    const language = useLanguage();
    const confirm = useConfirm();
    const toast = useToast();
    const [busy, setBusy] = useState<string | null>(null);
    const scan = useRemote((signal) => diskApi.deleted(serverId, mount.mount, signal), `deleted:${serverId}:${mount.mount}`, enabled);
    const data = scan.data;

    const release = async (file: DeletedOpenFile, action: DeletedReleaseAction) => {
        const text = confirmText(t, language, action, file);
        const ok = await confirm({ title: text.title, message: text.message, confirmLabel: text.confirm, tone: 'danger' });
        if (!ok) return;
        const key = `${file.pid}:${file.fd}`;
        setBusy(key);
        try {
            const result: DiskActionResult = await diskApi.release(serverId, {
                action,
                mount: mount.mount,
                pid: file.pid,
                process: file.process,
                // The backend checks that the pid and the descriptor still
                // name the process and the file of this row.
                ...(file.started ? { started: file.started } : {}),
                ...(action === 'truncate' ? { fd: file.fd, ...(file.inode ? { inode: file.inode } : {}) } : {}),
                ...(action === 'restart-service' && file.unit ? { unit: file.unit } : {}),
                ...(action === 'restart-container' && file.container ? { container: file.container } : {})
            });
            toast.success(
                t(`disk.deleted.done.${action}`, { process: file.process, unit: file.unit ?? '', container: file.container ?? '' }),
                result.freedBytes !== null ? t('disk.freed', { size: bytes(Math.max(0, result.freedBytes), language), mount: mount.mount }) : undefined
            );
            onChanged();
        } catch (error) {
            toast.error(t('disk.deleted.failed'), errorText(error, t));
        } finally {
            setBusy(null);
            scan.reload();
        }
    };

    // One release at a time (two restarts, or a restart and a SIGTERM, must
    // not race): the list is read again after each.
    const actionsFor = (file: DeletedOpenFile): MenuItem[] => {
        const locked = elevated ? undefined : true;
        const item = (action: DeletedReleaseAction, label: string, needsRoot?: boolean): MenuItem => {
            const Icon = ACTION_ICONS[action];
            const hint = busy ? t('disk.deleted.busy') : needsRoot ? t('disk.deleted.needsRoot') : undefined;
            return { id: action, label, icon: <Icon className="h-4 w-4" />, danger: action === 'terminate' || action === 'truncate', disabled: busy !== null || needsRoot, hint, onSelect: () => void release(file, action) };
        };
        return [
            ...(file.unit ? [item('restart-service', t('disk.deleted.actions.restartService', { unit: file.unit }), locked)] : []),
            ...(file.container ? [item('restart-container', t('disk.deleted.actions.restartContainer', { container: file.container }))] : []),
            item('truncate', t('disk.deleted.actions.truncate'), locked),
            item('terminate', t('disk.deleted.actions.terminate', { process: file.process }), locked)
        ];
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-zinc-400">{t('disk.deleted.intro')}</p>
                <Button size="sm" variant="subtle" onClick={scan.reload} loading={scan.loading && Boolean(data)} disabled={!enabled}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('disk.deleted.check')}
                </Button>
            </div>
            {!elevated && <Notice tone="locked">{t('disk.deleted.limited')} {t('disk.access.limitedHint')}</Notice>}

            {scan.error ? (
                <ErrorNotice error={scan.error} title={t('disk.deleted.loadFailed')} onRetry={scan.reload} />
            ) : !data ? (
                <p className="flex items-center gap-2 py-6 text-xs text-zinc-400" role="status">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t('disk.deleted.checking', { mount: mount.mount })}
                </p>
            ) : data.files.length === 0 ? (
                data.partial ? (
                    // Not a clean bill: the processes of other users were not seen.
                    <EmptyState
                        icon={<FileSearch className="h-5 w-5" />}
                        title={t('disk.deleted.noneOwn', { user, mount: mount.mount })}
                        detail={`${t('disk.deleted.noneOwnDetail')} ${t(`disk.deleted.source.${data.source}`)}`}
                    />
                ) : (
                    <EmptyState icon={<CheckCircle2 className="h-5 w-5 text-emerald-400" />} title={t('disk.deleted.none', { mount: mount.mount })} detail={t(`disk.deleted.source.${data.source}`)} />
                )
            ) : (
                <>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5" role="status">
                        <span className="text-lg font-semibold tabular-nums text-zinc-50">{bytes(data.totalBytes, language)}</span>
                        <span className="text-xs text-zinc-300">
                            {t(data.files.length === 1 ? 'disk.deleted.summaryOne' : 'disk.deleted.summary', { count: data.files.length, mount: mount.mount })}
                        </span>
                        <span className="ml-auto text-[11px] text-zinc-500">{t(`disk.deleted.source.${data.source}`)}</span>
                    </div>
                    <div className={cn('overflow-x-auto rounded-xl border border-white/[0.06] bg-ink-900/40', scan.loading && 'opacity-60')} aria-busy={scan.loading || undefined}>
                        <table className="w-full min-w-[44rem] table-fixed text-xs">
                            <caption className="sr-only">{t('disk.deleted.caption', { mount: mount.mount })}</caption>
                            <thead>
                                <tr className="border-b border-white/[0.06] text-left text-[11px] text-zinc-500">
                                    <th scope="col" className="w-24 px-3 py-1.5 text-right font-medium">{t('disk.deleted.columns.size')}</th>
                                    <th scope="col" className="px-3 py-1.5 font-medium">{t('disk.deleted.columns.file')}</th>
                                    <th scope="col" className="w-44 px-3 py-1.5 font-medium">{t('disk.deleted.columns.process')}</th>
                                    <th scope="col" className="w-40 px-3 py-1.5 font-medium">{t('disk.deleted.columns.runsIn')}</th>
                                    <th scope="col" className="w-14 px-3 py-1.5"><span className="sr-only">{t('disk.deleted.columns.actions')}</span></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.04]">
                                {data.files.map((file) => (
                                    <tr key={`${file.pid}:${file.fd}`} className="hover:bg-white/[0.02]">
                                        <td className="px-3 py-1.5 text-right font-medium tabular-nums text-zinc-100">{bytes(file.bytes, language)}</td>
                                        <td className="truncate px-3 py-1.5 font-mono text-[12px] text-zinc-200" title={file.path}>
                                            {file.path}
                                            <span className="ml-1.5 font-sans text-[11px] text-rose-300">{t('disk.deleted.deletedTag')}</span>
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <div className="truncate font-medium text-zinc-200" title={file.process}>{file.process}</div>
                                            <div className="truncate text-[11px] text-zinc-500">{t('disk.deleted.pid', { pid: file.pid, fd: file.fd })}{file.user ? ` · ${file.user}` : ''}</div>
                                        </td>
                                        <td className="px-3 py-1.5">
                                            {file.unit ? (
                                                <Badge tone="brand"><Cog className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{file.unit}</Badge>
                                            ) : file.container ? (
                                                <Badge tone="info"><Box className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{file.container}</Badge>
                                            ) : (
                                                <span className="text-zinc-500">{t('disk.deleted.noOwner')}</span>
                                            )}
                                        </td>
                                        <td className="px-2 py-1 text-right">
                                            <Menu
                                                label={t('disk.deleted.actionsFor', { path: file.path })}
                                                align="end"
                                                items={actionsFor(file)}
                                                triggerClassName={cn('inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100', busy === `${file.pid}:${file.fd}` && 'animate-pulse')}
                                            >
                                                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                            </Menu>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
