import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, FileSpreadsheet, FileText, Network, Play, Plus, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import { findDangerousCommand } from '@shared/commandSafety';
import { isJobFinal, type MultiExecJobInfo } from '@shared/multiexec';
import type { ServerSummary, Snippet } from '@shared/types';
import { Button, Modal, Spinner, Tabs, tabDomId, tabPanelDomId, useConfirm, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { exportFileName, saveText } from '@/lib/download';
import { useAppStore } from '@/store/appStore';
import { jobKindOf } from '@/lib/jobKinds';
import { getServers } from '@/store/servers';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { maskSecretValues, saveLastValues, secretValues, snippetsApi, useSnippetHandoff } from '@/features/snippets/public';
import { Composer } from './Composer';
import { composerFromDraft, composerFromJob, deriveComposer, emptyComposer, isSshCapable, toTarget, type ComposerState } from './composerState';
import { ConfirmView } from './ConfirmView';
import { controlErrorText, startErrorText } from './errors';
import { jobToCsv, jobToJson, jobToText } from './export';
import { JobsList } from './JobsList';
import { JobView } from './JobView';
import { isJobActive, mayHaveRun, retryServers, summaryOf, useMultiExecStore, type JobView as JobViewModel } from './store';
import { plural } from './strategy';

type View = 'compose' | 'confirm' | 'job' | 'jobs';

export type MultiExecModalProps = GlobalActionProps & {
    // Open on the job list (the "Multi-exec jobs" action).
    initialView?: 'jobs';
};

// Where focus goes when a view shows (see the effect on `view`): the first
// field with a problem, else the element of the view marked for it, else its
// first control.
function focusView(body: HTMLElement): void {
    const target = body.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?? body.querySelector<HTMLElement>('[data-view-focus]')
        ?? body.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
    target?.focus({ preventScroll: true });
}

export default function MultiExecModal({ onClose, server, initialView }: MultiExecModalProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const tabsId = useId();
    const openAction = useAppStore((state) => state.openAction);
    const jobs = useMultiExecStore((state) => state.jobs);
    const requests = useMultiExecStore((state) => state.requests);
    const list = useMultiExecStore((state) => state.list);
    const listError = useMultiExecStore((state) => state.listError);
    const hasMore = useMultiExecStore((state) => state.hasMore);
    const loadingMore = useMultiExecStore((state) => state.loadingMore);
    const moreError = useMultiExecStore((state) => state.moreError);

    // A draft handed over by the snippets library opens the composer. It is
    // read here and cleared by an effect: state initializers must stay pure
    // (StrictMode calls them twice and keeps one result).
    const [draft] = useState(() => useSnippetHandoff.getState().draft);
    const preselected = server && isSshCapable(server) ? [server.id] : [];
    const [composer, setComposer] = useState<ComposerState>(() => (draft ? composerFromDraft(draft, preselected) : emptyComposer(preselected)));
    const [jobId, setJobId] = useState<string | null>(() => useMultiExecStore.getState().currentJobId);
    const [view, setView] = useState<View>(() => {
        if (draft) return 'compose';
        if (initialView === 'jobs') return 'jobs';
        const { currentJobId, jobs: known } = useMultiExecStore.getState();
        return currentJobId && known[currentJobId] ? 'job' : 'compose';
    });

    const [servers, setServers] = useState<ServerSummary[] | null>(null);
    // Every saved server's name (snippets may be scoped to any of them).
    const [serverNames, setServerNames] = useState<ReadonlyMap<number, string>>(() => new Map());
    const [snippets, setSnippets] = useState<Snippet[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [attempted, setAttempted] = useState(false);
    const [typed, setTyped] = useState('');
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);
    const [busy, setBusy] = useState<'pause' | 'resume' | 'cancel' | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const shownView = useRef(view);
    const [failedReviews, setFailedReviews] = useState(0);

    useEffect(() => {
        useSnippetHandoff.getState().clearDraft();
    }, []);

    // Focus follows the view: the control that changed it (a footer button,
    // a job of the list) went with the previous one, and the next Tab must
    // start in the new view. A tab the user picked keeps the focus.
    useEffect(() => {
        if (shownView.current === view) return;
        shownView.current = view;
        const body = bodyRef.current;
        const active = document.activeElement;
        if (!body || (active instanceof HTMLElement && active !== document.body && body.closest('[role="dialog"]')?.contains(active))) return;
        focusView(body);
    }, [view]);

    // A review that found problems takes the user to the first of them.
    useEffect(() => {
        if (failedReviews > 0) bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
    }, [failedReviews]);

    useEffect(() => {
        const controller = new AbortController();
        Promise.all([getServers(), snippetsApi.list(controller.signal)])
            .then(([serverList, snippetList]) => {
                setServers(serverList.filter(isSshCapable));
                setServerNames(new Map(serverList.map((item) => [item.id, item.name])));
                setSnippets(snippetList);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
            });
        return () => controller.abort();
    }, []);

    useEffect(() => {
        void useMultiExecStore.getState().refreshList();
    }, [view]);

    // The job on screen is followed, and gets no notification.
    const shownJob = view === 'job' ? jobId : null;
    useEffect(() => {
        const store = useMultiExecStore.getState();
        if (shownJob) store.open(shownJob);
        store.setVisibleJob(shownJob);
        return () => useMultiExecStore.getState().setVisibleJob(null);
    }, [shownJob]);

    const sshServers = useMemo(() => servers ?? [], [servers]);
    const serverName = (serverId: number) => serverNames.get(serverId) ?? `#${serverId}`;
    const derived = deriveComposer(composer, snippets, sshServers, serverName, t);
    const danger = useMemo(() => (derived.command.trim() ? findDangerousCommand(derived.command) : null), [derived.command]);
    const dangerConfirmed = !danger || typed.trim() === String(derived.targets.length);
    const job: JobViewModel | null = jobId ? jobs[jobId] ?? null : null;
    // W8-T3: a job another feature started (a patch center run) is run
    // again from that feature, which may also word its output (lib/jobKinds.ts).
    const kind = job ? jobKindOf(job.info) : null;
    const jobView = useMemo(() => (job && kind?.present ? { ...job, servers: kind.present(job.servers, t) } : job), [job, kind, t]);

    const editComposer = (next: ComposerState) => {
        setComposer(next);
        setStartError(null);
    };

    const review = () => {
        setAttempted(true);
        if (derived.problems.length) {
            setFailedReviews((count) => count + 1);
            return;
        }
        setTyped('');
        setStartError(null);
        setView('confirm');
    };

    const launch = async () => {
        if (!derived.request || !dangerConfirmed || starting) return;
        setStarting(true);
        setStartError(null);
        try {
            const info = await useMultiExecStore.getState().start(
                { ...derived.request, ...(danger ? { confirmDangerous: true } : {}) },
                derived.targets.map(toTarget)
            );
            if (derived.snippet) saveLastValues(derived.snippet.id, composer.values, derived.secret);
            // What is composed next is a job of its own, not this rerun again.
            setComposer((current) => ({ ...current, rerunOf: null, maskedHistory: false }));
            setJobId(info.id);
            setAttempted(false);
            setView('job');
        } catch (error) {
            setStartError(startErrorText(error, derived.targets.map(toTarget), t));
        } finally {
            setStarting(false);
        }
    };

    const openJob = (id: string) => {
        useMultiExecStore.getState().open(id);
        setJobId(id);
        setView('job');
    };

    // Back to the composer with this job's command, settings and servers
    // (`serverIds`); a rerun goes straight to the review when nothing is missing.
    const composeFrom = (from: JobViewModel, serverIds: number[], rerun: boolean) => {
        const next = composerFromJob(from.info, serverIds, requests[from.info.id], rerun);
        setComposer(next);
        setTyped('');
        setStartError(null);
        const ready = rerun && !next.maskedHistory && deriveComposer(next, snippets, sshServers, serverName, t).problems.length === 0;
        setAttempted(rerun && !ready);
        setView(ready ? 'confirm' : 'compose');
    };

    const control = async (action: 'pause' | 'resume' | 'cancel') => {
        if (!jobId) return;
        setBusy(action);
        try {
            await useMultiExecStore.getState()[action](jobId);
        } catch (error) {
            toast.error(t(`multiexec.errors.${action}Failed`), controlErrorText(error, t));
        } finally {
            setBusy(null);
        }
    };

    const removeJob = async (info: MultiExecJobInfo) => {
        const ok = await confirm({
            title: t('multiexec.jobs.deleteTitle'),
            message: t('multiexec.jobs.deleteMessage'),
            confirmLabel: t('multiexec.jobs.delete'),
            tone: 'danger'
        });
        if (!ok) return;
        try {
            await useMultiExecStore.getState().remove(info.id);
            if (jobId === info.id) setJobId(null);
        } catch (error) {
            toast.error(t('multiexec.errors.deleteFailed'), controlErrorText(error, t));
        }
    };

    const clearHistory = async () => {
        const ok = await confirm({
            title: t('multiexec.jobs.clearTitle'),
            message: t('multiexec.jobs.clearMessage'),
            confirmLabel: t('multiexec.jobs.clear'),
            tone: 'danger'
        });
        if (!ok) return;
        try {
            const deleted = await useMultiExecStore.getState().clearFinished();
            toast.success(t('multiexec.jobs.cleared', { count: deleted }));
        } catch (error) {
            toast.error(t('multiexec.errors.deleteFailed'), controlErrorText(error, t));
        }
    };

    const exportJob = (format: 'json' | 'csv' | 'text') => {
        if (!job) return;
        const name = exportFileName('shellmind-multiexec', job.info.createdAt);
        if (format === 'json') saveText(`${name}.json`, jobToJson(job), 'application/json');
        else if (format === 'csv') saveText(`${name}.csv`, jobToCsv(job), 'text/csv;charset=utf-8');
        else saveText(`${name}.txt`, jobToText(job, t), 'text/plain;charset=utf-8');
    };

    // Jobs running now, here or elsewhere.
    const known = new Map((list ?? []).map((info) => [info.id, info]));
    for (const item of Object.values(jobs)) known.set(item.info.id, summaryOf(item));
    const jobRows = [...known.values()].sort((a, b) => b.createdAt - a.createdAt);
    const running = jobRows.filter((info) => !isJobFinal(info.status)).length;

    const tab = view === 'compose' || view === 'confirm' ? 'new' : 'jobs';
    const selectTab = (id: string) => {
        if (id === 'new') setView(view === 'confirm' ? 'confirm' : 'compose');
        else setView('jobs');
    };

    const jobFinal = job ? isJobFinal(job.info.status) : false;
    const toRetry = job && jobFinal ? retryServers(job.servers) : [];
    // Where the command may have run although the job has no result there.
    const leftOut = job && jobFinal ? job.servers.filter(mayHaveRun) : [];

    // Keyed per view, so a button of one view is never reused (and restyled) for another.
    const footer = view === 'compose' ? (
        <Fragment key="compose">
            <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto">{t('common.close')}</Button>
            <Button variant="primary" size="sm" onClick={review} disabled={servers === null}>{t('multiexec.compose.review')}</Button>
        </Fragment>
    ) : view === 'confirm' ? (
        <Fragment key="confirm">
            <Button variant="ghost" size="sm" onClick={() => setView('compose')} className="mr-auto">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.confirm.back')}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={() => void launch()} disabled={!dangerConfirmed || !derived.request} loading={starting}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />{plural(t, 'multiexec.confirm.run', derived.targets.length)}
            </Button>
        </Fragment>
    ) : view === 'job' ? (
        <Fragment key="job">
            <div className="mr-auto flex flex-wrap gap-2">
                <Button variant="subtle" size="sm" onClick={() => exportJob('json')} disabled={!job?.loaded && !job?.servers.length}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.results.exportJson')}
                </Button>
                <Button variant="subtle" size="sm" onClick={() => exportJob('csv')} disabled={!job?.loaded && !job?.servers.length}>
                    <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.results.exportCsv')}
                </Button>
                <Button variant="subtle" size="sm" onClick={() => exportJob('text')} disabled={!job?.loaded && !job?.servers.length}>
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.results.exportText')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openAction('audit')}>
                    <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.results.auditLog')}
                </Button>
            </div>
            {job && !kind && jobFinal && toRetry.length > 0 && (
                <Button variant="secondary" size="sm" onClick={() => composeFrom(job, toRetry.map((item) => item.serverId), true)}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t(toRetry.some((item) => item.status === 'cancelled' || item.status === 'skipped') ? 'multiexec.results.rerunUnfinished' : 'multiexec.results.rerunFailed', { count: toRetry.length })}
                </Button>
            )}
            {job && !kind && (
                <Button variant="primary" size="sm" onClick={() => composeFrom(job, job.servers.map((item) => item.serverId), false)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.results.newRun')}
                </Button>
            )}
            {job && kind?.actions(job.info, toRetry, t).map(({ id, label, title, icon: Icon, primary, run }) => (
                <Button key={id} variant={primary ? 'primary' : 'secondary'} size="sm" title={title} onClick={run}>
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}
                </Button>
            ))}
        </Fragment>
    ) : (
        <Fragment key="jobs">
            <Button variant="ghost" size="sm" onClick={() => void clearHistory()} disabled={!jobRows.some((info) => isJobFinal(info.status))} className="mr-auto">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.jobs.clear')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</Button>
            <Button variant="primary" size="sm" onClick={() => setView('compose')}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.jobs.new')}
            </Button>
        </Fragment>
    );

    return (
        <Modal
            open
            onClose={onClose}
            title={t('multiexec.title')}
            description={t('multiexec.subtitle')}
            icon={<Network className="h-4 w-4" />}
            widthClass="max-w-5xl"
            footer={footer}
        >
            <div ref={bodyRef} className="flex h-[min(68vh,640px)] min-h-[420px] flex-col gap-3">
                <div className="flex items-center gap-3 border-b border-white/5 pb-2">
                    <Tabs
                        idPrefix={tabsId}
                        aria-label={t('multiexec.tabs.label')}
                        value={tab}
                        onChange={selectTab}
                        items={[
                            { id: 'new', label: t('multiexec.tabs.new') },
                            {
                                id: 'jobs',
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        {t('multiexec.tabs.jobs')}
                                        {running > 0 && (
                                            <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-200">
                                                {t('multiexec.tabs.running', { count: running })}
                                            </span>
                                        )}
                                    </span>
                                )
                            }
                        ]}
                    />
                    {view === 'job' && (
                        <button type="button" onClick={() => setView('jobs')} className="ml-auto inline-flex items-center gap-1 rounded text-xs text-zinc-400 hover:text-zinc-200 focus-ring">
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.jobs.all')}
                        </button>
                    )}
                    {view === 'compose' && isJobActive(job) && (
                        <button type="button" onClick={() => setView('job')} className="ml-auto rounded text-xs text-amber-200 underline-offset-2 hover:underline focus-ring">
                            {t('multiexec.compose.showRunning')}
                        </button>
                    )}
                </div>

                <div role="tabpanel" id={tabPanelDomId(tabsId, tab)} aria-labelledby={tabDomId(tabsId, tab)} className="flex min-h-0 flex-1 flex-col">
                    {view === 'compose' && (
                        <Composer
                            state={composer}
                            onChange={editComposer}
                            derived={derived}
                            servers={servers}
                            loadError={loadError}
                            snippets={snippets}
                            serverName={serverName}
                            attempted={attempted}
                        />
                    )}
                    {view === 'confirm' && (
                        <div className="flex min-h-0 flex-1 flex-col gap-3">
                            <ConfirmView
                                derived={derived}
                                danger={danger}
                                dangerLine={danger ? maskSecretValues(danger.line, secretValues(composer.values, derived.secret)) : null}
                                typed={typed}
                                onTypedChange={setTyped}
                            />
                            {startError && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{startError}</p>}
                        </div>
                    )}
                    {view === 'job' && (jobView ? (
                        <>
                            <JobView
                                key={jobView.info.id}
                                view={jobView}
                                busy={busy}
                                onPause={() => void control('pause')}
                                onResume={() => void control('resume')}
                                onCancel={() => void control('cancel')}
                                onOpenJob={openJob}
                            />
                            {leftOut.length > 0 && (
                                <p role="note" className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-100">{plural(t, 'multiexec.results.mayHaveRun', leftOut.length)}</p>
                            )}
                        </>
                    ) : (
                        <div className="flex flex-1 items-center justify-center text-zinc-400"><Spinner /><span className="sr-only">{t('multiexec.loading')}</span></div>
                    ))}
                    {view === 'jobs' && (
                        <JobsList
                            jobs={list === null && !Object.keys(jobs).length ? null : jobRows}
                            error={listError}
                            onOpen={openJob}
                            onDelete={(info) => void removeJob(info)}
                            more={{ available: hasMore, loading: loadingMore, error: moreError, load: () => void useMultiExecStore.getState().loadMore() }}
                        />
                    )}
                </div>
            </div>
        </Modal>
    );
}
