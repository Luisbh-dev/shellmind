import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, PackageCheck, RefreshCw, RotateCw, ScanSearch, ShieldCheck, X } from 'lucide-react';
import { isJobFinal } from '@shared/multiexec';
import { canApply, canInstall, canTellSecurity, type PatchMode, type PatchScan } from '@shared/patch';
import type { ServerSummary } from '@shared/types';
import { Button, EmptyState, IconButton, Spinner, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/relativeTime';
import { JobStatusBadge, useMultiExecStore } from '@/features/multiexec/public';
import { useServers } from '@/store/servers';
import { ApplyDialog } from './ApplyDialog';
import { Age, ErrorBox, managerName, Note, RebootFlag, scanErrorText, SecurityCount } from './bits';
import { localizePatchText } from './output';
import { PatchJob } from './PatchJob';
import { usePatchStore } from './store';
import { UpdatesTable } from './UpdatesTable';

// One server's updates: what its package manager has pending (security ones
// first), whether a reboot is pending, when it was last updated and how old
// its package lists are, with scan, refresh and install actions, and its
// patch run while one goes on (or the latest one). In the Operations tab and
// in the patch center's side pane.

const POLL_MS = 3000;

type ServerUpdatesProps = {
    server: Pick<ServerSummary, 'id' | 'name' | 'type'>;
    layout: 'tab' | 'pane';
    // The pane's close button.
    onClose?: () => void;
    // The Operations tab's link to the fleet-wide view.
    onOpenCenter?: () => void;
};

function Tile({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
            <dt className="break-words text-[11px] uppercase leading-tight tracking-wider text-zinc-500">{label}</dt>
            <dd className="mt-0.5 text-sm text-zinc-100">{children}</dd>
        </div>
    );
}

function Details({ scan }: { scan: PatchScan }) {
    const t = useT();
    const [openHeld, setOpenHeld] = useState(false);
    const sections: ReactNode[] = [];
    if (scan.held.length) {
        sections.push(
            <div key="held" className="rounded-xl border border-white/5">
                <button
                    type="button"
                    aria-expanded={openHeld}
                    onClick={() => setOpenHeld((open) => !open)}
                    className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/[0.03] focus-ring"
                >
                    {openHeld ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t('patch.updates.held', { count: scan.held.length })}
                </button>
                {openHeld && (
                    <div className="space-y-1.5 border-t border-white/5 px-3 py-2">
                        <p className="text-xs text-zinc-400">{t('patch.updates.heldHint')}</p>
                        <ul className="flex flex-wrap gap-1.5">
                            {scan.held.map((entry) => (
                                <li key={entry.name} className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                                    {entry.name} <span className="font-sans text-zinc-500">· {t(`patch.updates.heldReason.${entry.reason}`)}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        );
    }
    if (scan.patches.length) {
        sections.push(
            <div key="patches" className="space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('patch.updates.patches', { count: scan.patches.length })}</h4>
                <ul className="space-y-0.5 text-xs">
                    {scan.patches.map((advisory) => (
                        <li key={advisory.name} className="flex flex-wrap gap-x-2">
                            <span className="font-mono text-zinc-200">{advisory.name}</span>
                            {advisory.severity && <span className="text-rose-300">{advisory.severity}</span>}
                            <span className="text-zinc-400">{advisory.summary}</span>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }
    if (scan.rebootPackages.length || scan.restartServices.length) {
        sections.push(
            <div key="reboot" className="grid gap-3 sm:grid-cols-2">
                {scan.rebootPackages.length > 0 && (
                    <div className="space-y-1">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('patch.updates.rebootPackages')}</h4>
                        <p className="break-words font-mono text-[11px] text-zinc-300">{scan.rebootPackages.join(', ')}</p>
                    </div>
                )}
                {scan.restartServices.length > 0 && (
                    <div className="space-y-1">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('patch.updates.restartServices')}</h4>
                        <p className="break-words font-mono text-[11px] text-zinc-300">{scan.restartServices.join(', ')}</p>
                    </div>
                )}
            </div>
        );
    }
    return sections.length ? <div className="space-y-3">{sections}</div> : null;
}

export default function ServerUpdates({ server, layout, onClose, onOpenCenter }: ServerUpdatesProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const headingId = useId();
    const { servers } = useServers();
    const detail = usePatchStore((state) => state.details[server.id]);
    const row = usePatchStore((state) => state.rows[server.id]);
    const lastJobId = usePatchStore((state) => state.lastJobs[server.id] ?? null);
    const job = useMultiExecStore((state) => (lastJobId ? state.jobs[lastJobId] : undefined));
    const [applying, setApplying] = useState<PatchMode | null>(null);
    const [jobOpen, setJobOpen] = useState(true);
    const [now, setNow] = useState(() => Date.now());

    const state = detail?.state ?? null;
    const scan = state?.scan ?? null;
    const scanning = detail?.action === 'scan' || Boolean(state?.scanning) || Boolean(row?.scanning);
    const jobId = state?.jobId ?? row?.jobId ?? null;
    const jobRunning = Boolean(jobId) || Boolean(job && !isJobFinal(job.info.status));
    const windows = server.type === 'windows';

    useEffect(() => {
        void usePatchStore.getState().loadServer(server.id);
    }, [server.id]);

    // Never read before: read it now (read-only).
    const loaded = Boolean(detail && !detail.loading && detail.state);
    const neverRead = loaded && !scan && !state?.error && !state?.scanning && !jobId;
    useEffect(() => {
        if (neverRead && !detail?.action && !detail?.actionError) void usePatchStore.getState().scanServer(server.id);
    }, [neverRead, detail?.action, detail?.actionError, server.id]);

    // While a run or a scan goes on (here or after a run), read it again now and then.
    const following = Boolean(state?.scanning || jobId);
    useEffect(() => {
        if (!following) return;
        const timer = window.setInterval(() => void usePatchStore.getState().loadServer(server.id), POLL_MS);
        return () => window.clearInterval(timer);
    }, [following, server.id]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    const refresh = async () => {
        const outcome = await usePatchStore.getState().refreshServer(server.id);
        if (outcome) toast.success(t('patch.toasts.refreshed'));
    };

    const names = new Map(servers.map((entry) => [entry.id, entry.name]));
    const jumpFor = row?.jumpHostFor ?? [];
    const installable = scan ? canApply(scan.manager) && canInstall(scan.privilege) : false;
    const busy = detail?.action ?? null;

    const content = (() => {
        if (!detail || (detail.loading && !detail.state)) {
            return <div className="flex items-center gap-2 py-8 text-sm text-zinc-400" role="status"><Spinner className="h-4 w-4" />{t('patch.status.scanning')}</div>;
        }
        if (detail.loadError && !detail.state) return <ErrorBox error={detail.loadError} heading={t('patch.errors.loadFailed')} />;
        if (!scan) {
            if (scanning) return <div className="flex items-center gap-2 py-8 text-sm text-zinc-400" role="status"><Spinner className="h-4 w-4" />{t('patch.status.scanning')}</div>;
            // The latest scan failed and there is none before it: why (the
            // header's "Scan again" tries again).
            if (state?.error) {
                const reason = scanErrorText(t, state.error);
                return (
                    <Note tone="bad">
                        <p className="text-sm font-medium">{t('patch.updates.scanFailed')}</p>
                        <p>{reason}</p>
                        {state.error.message && state.error.message !== reason && (
                            <p className="break-words font-mono text-[11px] opacity-80">
                                <span className="sr-only">{t('patch.updates.scanFailedDetail')}: </span>{state.error.message}
                            </p>
                        )}
                    </Note>
                );
            }
            return (
                <EmptyState
                    icon={<ScanSearch className="h-5 w-5" />}
                    title={t('patch.updates.notScanned')}
                    description={t('patch.updates.notScannedText')}
                    actions={<Button size="sm" variant="primary" onClick={() => void usePatchStore.getState().scanServer(server.id)}>{t('patch.actions.rescan')}</Button>}
                />
            );
        }
        return (
            <>
                <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
                    <Tile label={t('patch.columns.pending')}><span className="tabular-nums">{scan.total}</span></Tile>
                    <Tile label={t('patch.columns.security')}><SecurityCount value={scan.security} manager={scan.manager} /></Tile>
                    <Tile label={t('patch.columns.reboot')}><RebootFlag value={scan.rebootRequired} /></Tile>
                    <Tile label={t('patch.columns.lastUpdate')}>{scan.lastUpdateAt === null ? <span className="text-zinc-400">{t('patch.values.never')}</span> : <Age at={scan.lastUpdateAt} now={now} />}</Tile>
                    <Tile label={windows ? t('patch.summary.windowsLists') : t('patch.columns.lists')}>
                        {scan.metadataAt === null ? <span className="text-amber-300">{t('patch.values.listsMissing')}</span> : <Age at={scan.metadataAt} now={now} stale />}
                    </Tile>
                </dl>
                <div className="space-y-2">
                    {windows && <Note tone="info">{t('patch.notes.windows')}</Note>}
                    {!windows && scan.manager === null && <Note tone="warn">{t('patch.notes.noManager')}</Note>}
                    {!windows && scan.privilege === 'sudo-password' && <Note tone="warn">{t('patch.notes.sudoPassword')}</Note>}
                    {!windows && scan.privilege === 'none' && <Note tone="warn">{t('patch.notes.noPrivilege')}</Note>}
                    {!windows && scan.manager && !canTellSecurity(scan.manager) && scan.total > 0 && <Note tone="info">{t('patch.notes.noSecurity', { manager: managerName(t, scan.manager) })}</Note>}
                    {jumpFor.length > 0 && <Note tone="info">{t('patch.notes.jumpHost', { names: jumpFor.map((id) => names.get(id) ?? `#${id}`).join(', ') })}</Note>}
                    {scan.notices.map((notice) => (
                        <Note key={notice.code} tone={notice.code === 'listing-failed' || notice.code === 'search-failed' ? 'bad' : 'warn'}>
                            <p>{t(`patch.notices.${notice.code}`, { detail: notice.detail ?? '' })}</p>
                            {notice.detail && (notice.code === 'listing-failed' || notice.code === 'search-failed' || notice.code === 'security-unknown') && (
                                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] opacity-80">{notice.detail}</pre>
                            )}
                        </Note>
                    ))}
                    {state?.error && <Note tone="bad">{scanErrorText(t, state.error)}</Note>}
                </div>
                <UpdatesTable updates={scan.updates} total={scan.total} securityKnown={scan.security !== null && scan.manager !== 'zypper'} />
                <Details scan={scan} />
                {detail.refreshOutput && (
                    <details className="rounded-lg border border-white/5">
                        <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.03] focus-ring">{t('patch.updates.refreshOutput')}</summary>
                        <pre className="max-h-48 overflow-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] text-zinc-300 scrollbar-thin">{localizePatchText(detail.refreshOutput, t)}</pre>
                    </details>
                )}
            </>
        );
    })();

    return (
        <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-3 scrollbar-thin">
            <div className="space-y-4">
                <header className="space-y-2">
                    <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                            <h2
                                id={headingId}
                                // The patch center moves focus here when the pane covers its table.
                                tabIndex={layout === 'pane' ? -1 : undefined}
                                data-pane-focus={layout === 'pane' ? true : undefined}
                                className={cn('max-w-full truncate rounded text-base font-semibold text-zinc-100 focus-ring', layout === 'pane' ? 'inline-block align-top' : 'sr-only')}
                            >
                                {layout === 'pane' ? server.name : t('patch.view')}
                            </h2>
                            <p className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
                                {scan && <span>{managerName(t, scan.manager)}</span>}
                                {scan && <span aria-hidden="true">·</span>}
                                {scan && <span>{t('patch.summary.privilege')}: {t(`patch.privilege.${scan.privilege}`)}</span>}
                                {scan && <span aria-hidden="true">·</span>}
                                {scan && <span>{t('patch.summary.scanned', { when: formatRelativeTime(scan.scannedAt, now, language) })}</span>}
                                {scanning && <span className="inline-flex items-center gap-1 text-sky-300"><Spinner className="h-3 w-3" />{t('patch.status.scanning')}</span>}
                            </p>
                        </div>
                        <Button size="sm" variant="subtle" onClick={() => void usePatchStore.getState().scanServer(server.id)} loading={busy === 'scan'} disabled={scanning && busy !== 'scan'} title={t('patch.actions.rescanHint')}>
                            {busy !== 'scan' && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}{t('patch.actions.rescan')}
                        </Button>
                        {onOpenCenter && (
                            <Button size="sm" variant="ghost" onClick={onOpenCenter}>
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.actions.openCenter')}
                            </Button>
                        )}
                        {onClose && (
                            <IconButton size="sm" variant="ghost" label={t('patch.actions.closeDetails', { name: server.name })} onClick={onClose}>
                                <X className="h-4 w-4" aria-hidden="true" />
                            </IconButton>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {!windows && (
                            <>
                                <Button size="sm" variant="primary" onClick={() => setApplying('security')} disabled={!installable || jobRunning || !canTellSecurity(scan?.manager ?? null)}>
                                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.actions.installSecurity')}
                                </Button>
                                <Button size="sm" variant="secondary" onClick={() => setApplying('all')} disabled={!installable || jobRunning}>
                                    <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.actions.installAll')}
                                </Button>
                            </>
                        )}
                        <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => void refresh()}
                            loading={busy === 'refresh'}
                            disabled={jobRunning || (!windows && scan !== null && !canInstall(scan.privilege))}
                            title={windows ? t('patch.actions.refreshWindowsHint') : t('patch.actions.refreshHint')}
                        >
                            {busy !== 'refresh' && <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}{windows ? t('patch.actions.refreshWindows') : t('patch.actions.refresh')}
                        </Button>
                    </div>
                </header>

                {detail?.actionError !== null && detail?.actionError !== undefined && (
                    <ErrorBox error={detail.actionError} />
                )}

                {lastJobId && (
                    <section className="rounded-xl border border-white/10 bg-white/[0.02]" aria-label={t('patch.job.title')}>
                        <div className="flex items-center gap-2 px-3 py-2">
                            <button
                                type="button"
                                aria-expanded={jobOpen}
                                onClick={() => setJobOpen((open) => !open)}
                                className="inline-flex min-w-0 items-center gap-1.5 rounded text-xs font-medium text-zinc-200 focus-ring"
                            >
                                {jobOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                                {jobRunning ? t('patch.job.running') : t('patch.job.last')}
                            </button>
                            {job && <span className="ml-auto"><JobStatusBadge status={job.info.status} failed={job.info.counts.failed + job.info.counts.timeout > 0} /></span>}
                        </div>
                        {jobOpen && <div className="flex min-h-[18rem] flex-col border-t border-white/5 p-3"><PatchJob jobId={lastJobId} /></div>}
                    </section>
                )}

                {content}
            </div>

            {applying && (
                <ApplyDialog
                    serverIds={[server.id]}
                    names={new Map([[server.id, server.name]])}
                    initialMode={applying}
                    onClose={() => setApplying(null)}
                    onStarted={() => {
                        setApplying(null);
                        setJobOpen(true);
                        void usePatchStore.getState().loadServer(server.id);
                    }}
                />
            )}
        </section>
    );
}
