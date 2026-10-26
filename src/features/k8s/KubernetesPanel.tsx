import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Boxes, ExternalLink, Layers, MoreHorizontal, RefreshCw, Server, ShieldAlert, ShipWheel, Timer } from 'lucide-react';
import { K8S_ALL_NAMESPACES, type K8sStatus, type K8sWorkload } from '@shared/k8s';
import { Menu, Select, useConfirm, useToast, type SelectOption } from '@/components/ui';
import { EmptyState, ToolButton } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useElementWidth } from '@/lib/useElementWidth';
import type { WorkspaceServer } from '@/workspace/types';
import { k8sApi } from './api';
import { k8sErrorText } from './errors';
import { plural } from './labels';
import { EventsView } from './EventsView';
import { defaultNamespace, initialContext, loadView, saveView, SERIOUS } from './model';
import { NamespaceDialog } from './NamespaceDialog';
import { NodesView } from './NodesView';
import { PodsView } from './PodsView';
import { recordK8sPresence, useOpenK8sPanel, useRedetectRequests } from './presence';
import { CountPill, K8sErrorNotice, useViewRefresh, type RefreshSignal } from './ui';
import { WorkloadsView } from './WorkloadsView';

// The Kubernetes tab of a server: kubectl on the server (SSH) or on this
// computer (a local server with the kubectl preset). Nothing runs before the
// tab is first opened; then kubectl is looked for, and the views list the
// chosen context and namespace. The context is the tab's own (every request
// names it): kubectl's current context only changes when asked.

type ViewId = 'workloads' | 'pods' | 'events' | 'nodes';
const VIEWS: Array<{ id: ViewId; icon: typeof Boxes }> = [
    { id: 'workloads', icon: Layers },
    { id: 'pods', icon: Boxes },
    { id: 'events', icon: Timer },
    { id: 'nodes', icon: Server }
];

// The namespace picker's "type one" entry (not a namespace name: has capitals).
const OTHER_NAMESPACE = 'Other…';

type PanelProps = { server: WorkspaceServer; isActive: boolean };

function Unavailable({ status, onRetry, busy }: { status: K8sStatus; onRetry: () => void; busy: boolean }) {
    const t = useT();
    const problem = status.problem?.code ?? 'KUBECTL_MISSING';
    const where = status.runner === 'local' ? 'local' : 'ssh';
    return (
        <EmptyState
            icon={<ShipWheel className="h-5 w-5" />}
            title={t(`k8s.unavailable.${problem}.${where}`)}
            detail={
                <span className="block space-y-1">
                    <span className="block">{t(`k8s.unavailable.${problem}.hint`)}</span>
                    {/* kubectl's own words; the other problems are fully told above. */}
                    {problem === 'KUBECONFIG_ERROR' && status.problem?.message && (
                        <span className="block whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-500">{status.problem.message}</span>
                    )}
                    {status.unsupportedContexts.length > 0 && (
                        <span className="block">{t('k8s.unsupportedContexts', { names: status.unsupportedContexts.join(', ') })}</span>
                    )}
                </span>
            }
        >
            <div className="mt-2 flex flex-wrap justify-center gap-2">
                {problem === 'KUBECTL_MISSING' && (
                    <a
                        href={status.installUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/15 px-3 text-xs font-medium text-brand-100 hover:bg-brand-500/25 focus-ring"
                    >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('k8s.install')}
                    </a>
                )}
                <ToolButton icon={<RefreshCw className="h-3.5 w-3.5" />} label={t('k8s.checkAgain')} busy={busy} onClick={onRetry} />
            </div>
        </EmptyState>
    );
}

function Workspace({ server, isActive, status, onRedetect, detecting }: PanelProps & { status: K8sStatus; onRedetect: () => void; detecting: boolean }) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const compact = width > 0 && width < 720;
    const remembered = useMemo(() => loadView(server.id), [server.id]);
    const [context, setContext] = useState<string>(() => initialContext(status, remembered.context) ?? '');
    const [namespace, setNamespace] = useState<string>(() =>
        remembered.context === context && remembered.namespace ? remembered.namespace : defaultNamespace(status, context));
    const [view, setView] = useState<ViewId>('pods');
    const [visited, setVisited] = useState<Set<ViewId>>(() => new Set(['pods']));
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [workloadFilter, setWorkloadFilter] = useState<K8sWorkload | null>(null);
    const [podRequest, setPodRequest] = useState<{ name: string; namespace: string; nonce: number } | null>(null);
    const [nonce, setNonce] = useState(0);
    const tabRefs = useRef(new Map<ViewId, HTMLButtonElement>());

    // A context that disappeared from the kubeconfig (checked again) falls back.
    useEffect(() => {
        if (!status.contexts.some((entry) => entry.name === context)) {
            const next = initialContext(status) ?? '';
            setContext(next);
            setNamespace(defaultNamespace(status, next));
        }
    }, [status, context]);

    useEffect(() => {
        if (context) saveView(server.id, { context, namespace });
    }, [server.id, context, namespace]);

    const namespaces = useRemote((signal) => k8sApi.namespaces(server.id, context, signal), `ns:${server.id}:${context}`, Boolean(context));
    // Pods are listed for the tab's badge and for the workloads' pods too:
    // refreshed while the tab shows, whichever view is on screen.
    const pods = useRemote((signal) => k8sApi.pods(server.id, context, namespace, signal), `pods:${server.id}:${context}:${namespace}`, Boolean(context));
    const { reload: reloadPods } = pods;

    // Refresh reloads every view in place (their rows stay while it runs);
    // auto-refresh reloads each view a while after its last answer.
    const refreshSignal: RefreshSignal = { nonce, auto: autoRefresh };
    useViewRefresh(pods, refreshSignal, isActive);

    const show = useCallback((next: ViewId) => {
        setView(next);
        setVisited((previous) => (previous.has(next) ? previous : new Set([...previous, next])));
    }, []);

    const switchContext = (next: string) => {
        setContext(next);
        setNamespace(defaultNamespace(status, next));
        setWorkloadFilter(null);
    };
    const [typingNamespace, setTypingNamespace] = useState(false);
    const switchNamespace = (next: string) => {
        if (next === OTHER_NAMESPACE) {
            setTypingNamespace(true);
            return;
        }
        setNamespace(next);
        setWorkloadFilter(null);
    };

    const openPod = useCallback((name: string, podNamespace: string) => {
        setPodRequest((previous) => ({ name, namespace: podNamespace, nonce: (previous?.nonce ?? 0) + 1 }));
        show('pods');
    }, [show]);

    const showWorkloadPods = useCallback((workload: K8sWorkload) => {
        setWorkloadFilter(workload);
        show('pods');
    }, [show]);

    const makeDefault = async () => {
        const ok = await confirm({
            title: t('k8s.useContext.title', { context }),
            message: t(status.runner === 'local' ? 'k8s.useContext.messageLocal' : 'k8s.useContext.message', { context, server: server.name }),
            confirmLabel: t('k8s.useContext.confirm')
        });
        if (!ok) return;
        try {
            await k8sApi.useContext(server.id, context);
            toast.success(t('k8s.useContext.done', { context }));
            onRedetect();
        } catch (error) {
            toast.error(t('k8s.useContext.failed'), k8sErrorText(error, t));
        }
    };

    const onTabKey = (event: KeyboardEvent, index: number) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : (index + step + VIEWS.length) % VIEWS.length;
        show(VIEWS[next].id);
        tabRefs.current.get(VIEWS[next].id)?.focus();
    };

    const contextOptions: SelectOption[] = [
        ...status.contexts.map((entry) => ({
            value: entry.name,
            label: entry.name,
            description: [entry.cluster, entry.server, entry.name === status.currentContext ? t('k8s.currentContext') : null].filter(Boolean).join(' · ') || undefined
        })),
        // Listed, so a context that cannot be used is not just missing (its
        // name fails the context pattern: no usable context has it as a value).
        ...status.unsupportedContexts.map((name) => ({ value: name, label: name, description: t('k8s.unsupportedContext'), disabled: true }))
    ];
    const namespaceList = namespaces.data ?? [];
    const namespaceOptions: SelectOption[] = [
        { value: K8S_ALL_NAMESPACES, label: t('k8s.allNamespaces') },
        ...[...new Set([...namespaceList, ...(namespace !== K8S_ALL_NAMESPACES ? [namespace] : [])])].sort().map((name) => ({ value: name, label: name })),
        { value: OTHER_NAMESPACE, label: t('k8s.otherNamespace.option') }
    ];

    const podList = pods.data?.pods ?? [];
    // The badge counts the pods failing (crash loops, image pulls...); the
    // pods view's "needs attention" filter also has pending, not ready ones.
    const failing = podList.filter((pod) => pod.problem !== null && SERIOUS.has(pod.problem)).length;
    const runner = status.runner === 'local'
        ? t('k8s.runner.local', { version: status.kubectl?.version ?? '' })
        : t(status.sudo ? 'k8s.runner.sshSudo' : 'k8s.runner.ssh', { version: status.kubectl?.version ?? '' });
    const reloadAll = () => {
        setNonce((value) => value + 1);
        if (!namespaces.loading) namespaces.reload();
    };

    return (
        <div ref={rootRef} className="absolute inset-0 flex flex-col bg-ink-900">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <ShipWheel className="h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
                <div className="w-56 max-w-full min-w-[10rem]">
                    <Select aria-label={t('k8s.context')} value={context} onChange={switchContext} options={contextOptions} className="h-8 py-0 font-mono text-xs" />
                </div>
                <div className="w-48 max-w-full min-w-[9rem]">
                    <Select aria-label={t('k8s.namespace')} value={namespace} onChange={switchNamespace} options={namespaceOptions} className="h-8 py-0 text-xs" />
                </div>
                {namespaces.error ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-200" title={k8sErrorText(namespaces.error, t)}>
                        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('k8s.namespacesUnavailable')}
                    </span>
                ) : null}
                <div className="ml-auto flex items-center gap-2">
                    <span className={cn('hidden rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 md:inline', compact && 'md:hidden')} title={status.kubectl?.path ?? undefined}>
                        {runner}
                    </span>
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('k8s.checkAgain')} busy={detecting} onClick={onRedetect} />
                    <Menu
                        label={t('k8s.more')}
                        triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.08] focus-ring"
                        items={[
                            {
                                id: 'use-context',
                                label: context === status.currentContext ? t('k8s.useContext.already') : t('k8s.useContext.action'),
                                disabled: context === status.currentContext,
                                onSelect: () => void makeDefault()
                            }
                        ]}
                    >
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </Menu>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 pt-2">
                <div role="tablist" aria-label={t('k8s.viewsLabel')} className="-mb-px flex gap-1">
                    {VIEWS.map((entry, index) => {
                        const Icon = entry.icon;
                        const selected = view === entry.id;
                        const label = t(`k8s.views.${entry.id}`);
                        return (
                            <button
                                key={entry.id}
                                ref={(element) => {
                                    if (element) tabRefs.current.set(entry.id, element);
                                    else tabRefs.current.delete(entry.id);
                                }}
                                id={`k8s-tab-${server.id}-${entry.id}`}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={`k8s-panel-${server.id}-${entry.id}`}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => show(entry.id)}
                                onKeyDown={(event) => onTabKey(event, index)}
                                title={compact ? label : undefined}
                                className={cn(
                                    'inline-flex items-center gap-2 rounded-t-md border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors focus-ring',
                                    selected ? 'border-brand-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
                                )}
                            >
                                <Icon className="h-4 w-4" aria-hidden="true" />
                                <span className={cn(compact && 'sr-only')}>{label}</span>
                                {entry.id === 'pods' && <CountPill count={failing} tone="bad" label={plural(t, 'k8s.failingCount', failing)} />}
                            </button>
                        );
                    })}
                </div>
                <div className="mb-2 ml-auto flex items-center gap-1.5">
                    <ToolButton
                        compact={compact}
                        icon={<Timer className="h-3.5 w-3.5" />}
                        label={t('k8s.autoRefresh')}
                        pressed={autoRefresh}
                        onClick={() => setAutoRefresh((on) => !on)}
                    />
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('k8s.refresh')} busy={pods.loading} onClick={reloadAll} />
                </div>
            </div>

            <div className="relative min-h-0 flex-1">
                {/* Every tab has its panel (aria-controls points at it); a view is mounted once first shown. */}
                {VIEWS.map(({ id }) => {
                    const mounted = visited.has(id) || id === view;
                    const active = isActive && view === id;
                    return (
                        <div
                            key={id}
                            id={`k8s-panel-${server.id}-${id}`}
                            role="tabpanel"
                            aria-labelledby={`k8s-tab-${server.id}-${id}`}
                            hidden={view !== id}
                            className="absolute inset-0"
                        >
                            {mounted && id === 'pods' && (
                                <PodsView
                                    server={server}
                                    context={context}
                                    namespace={namespace}
                                    pods={pods}
                                    onReload={reloadPods}
                                    workload={workloadFilter}
                                    onClearWorkload={() => setWorkloadFilter(null)}
                                    request={podRequest}
                                    active={active}
                                />
                            )}
                            {mounted && id === 'workloads' && (
                                <WorkloadsView
                                    serverId={server.id}
                                    context={context}
                                    namespace={namespace}
                                    refresh={refreshSignal}
                                    active={active}
                                    pods={podList}
                                    onShowPods={showWorkloadPods}
                                />
                            )}
                            {mounted && id === 'events' && (
                                <EventsView serverId={server.id} context={context} namespace={namespace} refresh={refreshSignal} active={active} onOpenPod={openPod} />
                            )}
                            {mounted && id === 'nodes' && <NodesView serverId={server.id} context={context} refresh={refreshSignal} active={active} pods={podList} />}
                        </div>
                    );
                })}
            </div>
            {typingNamespace && (
                <NamespaceDialog
                    initial={namespace === K8S_ALL_NAMESPACES ? '' : namespace}
                    onCancel={() => setTypingNamespace(false)}
                    onChoose={(next) => {
                        setTypingNamespace(false);
                        switchNamespace(next);
                    }}
                />
            )}
        </div>
    );
}

function Kubernetes({ server, isActive }: PanelProps) {
    const t = useT();
    const [opened, setOpened] = useState(isActive);
    const bypassCache = useRef(false);
    // "Look for kubectl on this server" (command palette): asked again.
    const requests = useRedetectRequests(server.id);
    const answered = useRef(0);
    useOpenK8sPanel(server.id);

    useEffect(() => {
        if (isActive) setOpened(true);
    }, [isActive]);

    const status = useRemote((signal) => {
        const refresh = bypassCache.current || requests > answered.current;
        bypassCache.current = false;
        answered.current = requests;
        return k8sApi.status(server.id, refresh, signal);
    }, `k8s-status:${server.id}`, opened);
    const { reload } = status;
    const redetect = useCallback(() => {
        bypassCache.current = true;
        reload();
    }, [reload]);
    useEffect(() => {
        if (opened && requests > answered.current) redetect();
    }, [opened, requests, redetect]);

    // What was found decides where the tab shows next time (presence.ts).
    useEffect(() => {
        if (status.data) recordK8sPresence(server, status.data);
    }, [server, status.data]);

    if (!opened) return null;
    const data = status.data;

    if (!data) {
        return (
            <div className="absolute inset-0 flex flex-col bg-ink-900">
                {status.error ? (
                    <K8sErrorNotice error={status.error} onRetry={redetect} className="m-4" />
                ) : (
                    <div className="flex items-center gap-2 p-6 text-sm text-zinc-400" role="status">
                        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t(server.type === 'local' ? 'k8s.detectingLocal' : 'k8s.detecting')}
                    </div>
                )}
            </div>
        );
    }

    if (!data.available) {
        return (
            <div className="absolute inset-0 overflow-auto bg-ink-900">
                {status.error ? <K8sErrorNotice error={status.error} title={t('k8s.redetectFailed')} onRetry={redetect} className="mx-4 mt-3" /> : null}
                <Unavailable status={data} onRetry={redetect} busy={status.loading} />
            </div>
        );
    }

    return (
        <>
            <Workspace server={server} isActive={isActive} status={data} onRedetect={redetect} detecting={status.loading} />
            {status.error ? (
                <div className="absolute inset-x-4 bottom-4 z-10">
                    <K8sErrorNotice error={status.error} title={t('k8s.redetectFailed')} onRetry={redetect} />
                </div>
            ) : null}
        </>
    );
}

// Keyed by server: no state or stream carries over to another server.
export default function KubernetesPanel(props: PanelProps) {
    return <Kubernetes key={props.server.id} {...props} />;
}
