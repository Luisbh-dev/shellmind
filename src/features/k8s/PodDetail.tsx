import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { ChevronLeft, Copy, Eye, EyeOff, RefreshCw, Trash2, X } from 'lucide-react';
import type { K8sContainerDetail, K8sContainerState, K8sPod, K8sPodDetail } from '@shared/k8s';
import { AskAiButton } from '@/components/AskAiButton';
import { useConfirm, useToast } from '@/components/ui';
import { formatTimestamp } from '@/features/ops/format';
import { Section, StateBadge, ToolButton, type BadgeTone } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { useLanguage, useT } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import type { WorkspaceServer } from '@/workspace/types';
import { k8sApi } from './api';
import { k8sErrorText } from './errors';
import { EventList } from './EventList';
import { ownerLabel, plural } from './labels';
import { formatAge, podDeletion, podTone, type PodDeletion } from './model';
import { PodLogs } from './PodLogs';
import { PodShellButton } from './shell';
import { DetailRows, K8sErrorNotice, TableSkeleton } from './ui';

// A pod's detail pane: what it runs and why it is in the state it is in
// (containers with their current and last state, conditions, volumes), its
// logs and its events, with the shell, "Ask AI" and delete actions.

type Tab = 'overview' | 'logs' | 'events';
const TABS: Tab[] = ['overview', 'logs', 'events'];
const MASK = '••••••••';

type PodDetailProps = {
    server: WorkspaceServer;
    context: string;
    pod: K8sPod;
    headingRef: Ref<HTMLHeadingElement>;
    // The detail replaces the list (a narrow panel): back to it.
    onBack?: () => void;
    // The detail sits next to the list: close it.
    onClose?: () => void;
    onDeleted: () => void;
    active: boolean;
};

function stateTone(state: K8sContainerState): BadgeTone {
    if (state.state === 'running') return 'ok';
    if (state.state === 'terminated') return state.exitCode === 0 ? 'idle' : 'bad';
    if (state.state === 'waiting') return /BackOff|Err|Invalid|Error/.test(state.reason ?? '') ? 'bad' : 'warn';
    return 'idle';
}

function stateLabel(state: K8sContainerState, t: ReturnType<typeof useT>): string {
    const word = t(`k8s.container.states.${state.state}`);
    return state.reason ? `${word}: ${state.reason}` : word;
}

function StateLine({ label, state }: { label: string; state: K8sContainerState }) {
    const t = useT();
    const language = useLanguage();
    const exit = state.exitCode !== null ? t('k8s.container.exitCode', { code: state.exitCode }) : null;
    const signal = state.signal ? t('k8s.container.signal', { signal: state.signal }) : null;
    const when = state.finishedAt ?? state.startedAt;
    return (
        <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 shrink-0 text-[11px] text-zinc-500">{label}</span>
                <StateBadge tone={stateTone(state)} label={stateLabel(state, t)} />
                {[exit, signal].filter(Boolean).map((text) => <span key={text} className="text-[11px] tabular-nums text-zinc-300">{text}</span>)}
                {when && <span className="text-[11px] text-zinc-500" title={when}>{formatTimestamp(when, language)}</span>}
            </div>
            {state.message && <p className="ml-[6.5rem] break-words font-mono text-[11px] text-zinc-400">{state.message}</p>}
        </div>
    );
}

function Environment({ container }: { container: K8sContainerDetail }) {
    const t = useT();
    const toast = useToast();
    const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
    const literal = container.env.filter((entry) => entry.value !== null);
    const all = literal.length > 0 && literal.every((entry) => revealed.has(entry.name));
    const toggle = (name: string) => setRevealed((previous) => {
        const next = new Set(previous);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
    });
    const copy = async (name: string, value: string) => {
        try {
            await copyText(value);
            toast.success(t('k8s.env.copied', { name }));
        } catch {
            toast.error(t('k8s.env.copyFailed'));
        }
    };
    if (!container.env.length && !container.envFrom.length) return <p className="text-xs text-zinc-500">{t('k8s.env.empty')}</p>;
    return (
        <>
            <div className="flex items-center gap-2">
                <p className="mr-auto text-[11px] text-zinc-500">{t('k8s.env.hint')}</p>
                {literal.length > 0 && (
                    <ToolButton
                        icon={all ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        label={all ? t('k8s.env.hideAll') : t('k8s.env.showAll')}
                        onClick={() => setRevealed(all ? new Set() : new Set(literal.map((entry) => entry.name)))}
                    />
                )}
            </div>
            <ul className="divide-y divide-white/[0.05] text-xs">
                {container.env.map(({ name, value, from }) => {
                    const shown = revealed.has(name);
                    return (
                        <li key={name} className="flex items-start gap-2 py-1.5">
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-[11px] font-medium text-zinc-300" title={name}>{name}</div>
                                {from ? (
                                    <code className="break-all font-mono text-[11px] text-sky-200">{t('k8s.env.from', { source: from })}</code>
                                ) : (
                                    <code className={cn('break-all font-mono text-[11px]', shown ? 'text-zinc-200' : 'select-none text-zinc-500')}>
                                        {shown ? value || '""' : <><span aria-hidden="true">{MASK}</span><span className="sr-only">{t('k8s.env.masked')}</span></>}
                                    </code>
                                )}
                            </div>
                            {!from && value !== null && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => toggle(name)}
                                        aria-pressed={shown}
                                        aria-label={shown ? t('k8s.env.hide', { name }) : t('k8s.env.show', { name })}
                                        title={shown ? t('k8s.env.hide', { name }) : t('k8s.env.show', { name })}
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100 focus-ring"
                                    >
                                        {shown ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void copy(name, value)}
                                        aria-label={t('k8s.env.copy', { name })}
                                        title={t('k8s.env.copy', { name })}
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100 focus-ring"
                                    >
                                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                    </button>
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>
            {container.envFrom.length > 0 && (
                <p className="text-[11px] text-zinc-400">{t('k8s.env.envFrom', { sources: container.envFrom.join(', ') })}</p>
            )}
        </>
    );
}

const resources = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => `${name} ${value}`).join(', ');

function ContainerCard({ container }: { container: K8sContainerDetail }) {
    const t = useT();
    const crashed = container.lastState?.state === 'terminated' && container.lastState.exitCode !== 0;
    return (
        <article className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2.5" aria-label={t('k8s.container.label', { name: container.name })}>
            <header className="flex flex-wrap items-center gap-2">
                <h4 className="min-w-0 truncate font-mono text-xs font-semibold text-zinc-100">{container.name}</h4>
                {container.init && <span className="rounded border border-white/10 px-1.5 text-[10px] text-zinc-400">{t(container.sidecar ? 'k8s.container.sidecar' : 'k8s.container.init')}</span>}
                <span className={cn('ml-auto text-[11px] tabular-nums', container.restarts > 0 ? 'text-amber-200' : 'text-zinc-500')}>
                    {plural(t, 'k8s.container.restarts', container.restarts)}
                </span>
                <span className={cn('text-[11px]', container.ready ? 'text-emerald-200' : 'text-zinc-500')}>{container.ready ? t('k8s.container.ready') : t('k8s.container.notReady')}</span>
            </header>
            <p className="truncate font-mono text-[11px] text-zinc-400" title={container.image}>{container.image}</p>
            <StateLine label={t('k8s.container.state')} state={container.state} />
            {container.lastState && (
                <div className={cn(crashed && 'rounded-md bg-rose-500/[0.06] px-2 py-1')}>
                    <StateLine label={t('k8s.container.lastState')} state={container.lastState} />
                </div>
            )}
            <DetailRows
                rows={[
                    ...(container.ports.length ? [[t('k8s.container.ports'), container.ports.join(', ')] as [string, string]] : []),
                    ...(Object.keys(container.requests).length ? [[t('k8s.container.requests'), resources(container.requests)] as [string, string]] : []),
                    ...(Object.keys(container.limits).length ? [[t('k8s.container.limits'), resources(container.limits)] as [string, string]] : []),
                    ...(container.command ? [[t('k8s.container.command'), <code key="command" className="break-all font-mono text-[11px]">{container.command}</code>] as [string, React.ReactNode]] : [])
                ]}
            />
            <Section title={t('k8s.env.title')} count={container.env.length}>
                <Environment container={container} />
            </Section>
        </article>
    );
}

function Overview({ pod, detail }: { pod: K8sPod; detail: K8sPodDetail }) {
    const t = useT();
    const language = useLanguage();
    const date = (value: string | null) => (value ? <span title={value}>{formatTimestamp(value, language)} ({t('k8s.pods.ago', { age: formatAge(value) })})</span> : '—');
    return (
        <div className="space-y-3 px-4 py-3">
            <DetailRows
                rows={[
                    [t('k8s.pod.namespace'), pod.namespace],
                    [t('k8s.pod.owner'), pod.owner ? ownerLabel(t, pod.owner) : t('k8s.pod.noOwner')],
                    [t('k8s.pod.node'), pod.node ?? t('k8s.pod.unscheduled')],
                    [t('k8s.pod.ip'), [pod.ip, detail.hostIp && t('k8s.pod.hostIp', { ip: detail.hostIp })].filter(Boolean).join(' · ') || '—'],
                    [t('k8s.pod.qos'), detail.qosClass ?? '—'],
                    [t('k8s.pod.serviceAccount'), detail.serviceAccount ?? '—'],
                    [t('k8s.pod.created'), date(pod.createdAt)],
                    [t('k8s.pod.started'), date(detail.startedAt)]
                ]}
            />
            {detail.conditions.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('k8s.pod.conditions')}>
                    {detail.conditions.map((condition) => (
                        <li key={condition.type} title={[condition.reason, condition.message].filter(Boolean).join(': ') || undefined}>
                            <StateBadge tone={condition.status === 'True' ? 'ok' : condition.status === 'False' ? 'warn' : 'idle'} label={`${condition.type}${condition.status === 'True' ? '' : `: ${condition.reason ?? condition.status}`}`} />
                        </li>
                    ))}
                </ul>
            )}
            <div className="space-y-2">
                {detail.containers.map((container) => <ContainerCard key={container.name} container={container} />)}
            </div>
            {detail.initContainers.length > 0 && (
                // Open while the pod initializes: they are what it waits for.
                <Section title={t('k8s.pod.initContainers')} count={detail.initContainers.length} defaultOpen={pod.status.startsWith('Init:')}>
                    {detail.initContainers.map((container) => <ContainerCard key={container.name} container={container} />)}
                </Section>
            )}
            {detail.volumes.length > 0 && (
                <Section title={t('k8s.pod.volumes')} count={detail.volumes.length}>
                    <ul className="space-y-1 text-xs">
                        {detail.volumes.map((volume) => (
                            <li key={volume.name} className="flex min-w-0 gap-2">
                                <span className="truncate font-mono text-[11px] text-zinc-200">{volume.name}</span>
                                <span className="shrink-0 text-[11px] text-zinc-500">{volume.type}</span>
                                {volume.source && <span className="min-w-0 truncate font-mono text-[11px] text-zinc-400" title={volume.source}>{volume.source}</span>}
                            </li>
                        ))}
                    </ul>
                </Section>
            )}
        </div>
    );
}

export function PodDetail({ server, context, pod, headingRef, onBack, onClose, onDeleted, active }: PodDetailProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const [tab, setTab] = useState<Tab>('overview');
    const [visitedLogs, setVisitedLogs] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
    const detail = useRemote((signal) => k8sApi.pod(server.id, context, pod.namespace, pod.name, signal), `pod:${server.id}:${context}:${pod.namespace}/${pod.name}`);
    const { reload } = detail;

    // The list refreshed and the pod changed: so does its detail.
    const changed = `${pod.status}:${pod.restarts}:${pod.ready}`;
    const seen = useRef(changed);
    useEffect(() => {
        if (seen.current === changed) return;
        seen.current = changed;
        reload();
    }, [changed, reload]);

    const show = (next: Tab) => {
        setTab(next);
        if (next === 'logs') setVisitedLogs(true);
    };
    const onTabKey = (event: KeyboardEvent, index: number) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : TABS[(index + step + TABS.length) % TABS.length];
        show(next);
        tabRefs.current.get(next)?.focus();
    };

    const remove = async () => {
        const owner = pod.owner ? ownerLabel(t, pod.owner) : '';
        const message: Record<PodDeletion, () => string> = {
            replaced: () => t('k8s.pod.delete.replaced', { owner }),
            cleanup: () => t('k8s.pod.delete.cleanup', { owner }),
            'job-running': () => t('k8s.pod.delete.jobRunning', { owner }),
            'job-finished': () => t('k8s.pod.delete.jobFinished', { owner }),
            mirror: () => t('k8s.pod.delete.mirror', { node: pod.owner?.name ?? '' }),
            'other-owner': () => t('k8s.pod.delete.otherOwner', { owner }),
            unowned: () => t('k8s.pod.delete.unowned')
        };
        const ok = await confirm({
            title: t('k8s.pod.delete.title', { name: pod.name }),
            message: message[podDeletion(pod)](),
            confirmLabel: t('k8s.pod.delete.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        setDeleting(true);
        try {
            await k8sApi.deletePod(server.id, context, pod.namespace, pod.name);
            toast.success(t('k8s.pod.delete.done', { name: pod.name }));
            onDeleted();
        } catch (error) {
            toast.error(t('k8s.pod.delete.failed', { name: pod.name }), k8sErrorText(error, t));
        } finally {
            setDeleting(false);
        }
    };

    const data = detail.data;
    const idPrefix = `k8s-pod-${server.id}`;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start gap-2 border-b border-white/[0.06] px-4 py-3">
                {onBack && <ToolButton compact icon={<ChevronLeft className="h-4 w-4" />} label={t('k8s.back')} onClick={onBack} />}
                <div className="min-w-0 flex-1">
                    <h3 ref={headingRef} tabIndex={-1} className="truncate font-mono text-sm font-semibold text-zinc-100 outline-none" title={pod.name}>{pod.name}</h3>
                    <p className="truncate text-xs text-zinc-400">{[pod.namespace, pod.owner ? ownerLabel(t, pod.owner) : null].filter(Boolean).join(' · ')}</p>
                </div>
                <StateBadge tone={podTone(pod)} label={pod.status} />
                {onClose && <ToolButton compact icon={<X className="h-4 w-4" />} label={t('k8s.pod.close')} onClick={onClose} />}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5" role="group" aria-label={t('k8s.pod.actionsLabel')}>
                <PodShellButton serverId={server.id} context={context} pod={pod} containers={data ? [...data.containers, ...data.initContainers] : undefined} />
                <AskAiButton
                    variant="button"
                    serverId={server.id}
                    attachment={{ kind: 'pod', context, namespace: pod.namespace, pod: pod.name }}
                    hint={t('k8s.pod.askAiHint')}
                />
                <ToolButton icon={<Trash2 className="h-3.5 w-3.5" />} label={t('k8s.pod.delete.action')} tone="danger" busy={deleting} disabled={pod.problem === 'terminating'} onClick={() => void remove()} />
                <div className="ml-auto">
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('k8s.refresh')} busy={detail.loading} onClick={reload} />
                </div>
            </div>

            <div role="tablist" aria-label={t('k8s.pod.tabsLabel')} className="flex gap-1 border-b border-white/[0.06] px-4">
                {TABS.map((entry, index) => (
                    <button
                        key={entry}
                        ref={(element) => {
                            if (element) tabRefs.current.set(entry, element);
                            else tabRefs.current.delete(entry);
                        }}
                        id={`${idPrefix}-tab-${entry}`}
                        type="button"
                        role="tab"
                        aria-selected={tab === entry}
                        aria-controls={`${idPrefix}-panel-${entry}`}
                        tabIndex={tab === entry ? 0 : -1}
                        onClick={() => show(entry)}
                        onKeyDown={(event) => onTabKey(event, index)}
                        className={cn(
                            '-mb-px rounded-t-md border-b-2 px-2.5 pb-2 pt-1.5 text-xs font-medium transition-colors focus-ring',
                            tab === entry ? 'border-brand-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
                        )}
                    >
                        {t(`k8s.pod.tabs.${entry}`)}
                        {entry === 'events' && data && data.events.some((event) => event.type === 'Warning') && (
                            <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" aria-hidden="true" />
                        )}
                    </button>
                ))}
            </div>

            <div id={`${idPrefix}-panel-overview`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-overview`} hidden={tab !== 'overview'} className="min-h-0 flex-1 overflow-auto">
                {detail.error ? <K8sErrorNotice error={detail.error} onRetry={reload} className="m-4" /> : null}
                {data ? <Overview pod={pod} detail={data} /> : !detail.error && <TableSkeleton rows={4} />}
            </div>
            {/* The panel is always there (the tab points at it); the log stream starts once it is shown. */}
            <div id={`${idPrefix}-panel-logs`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-logs`} hidden={tab !== 'logs'} className={cn('min-h-0 flex-1', tab === 'logs' ? 'flex flex-col' : 'hidden')}>
                {visitedLogs && <PodLogs serverId={server.id} serverName={server.name} context={context} pod={pod} detail={data} active={active && tab === 'logs'} />}
            </div>
            <div id={`${idPrefix}-panel-events`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-events`} hidden={tab !== 'events'} className="min-h-0 flex-1 overflow-auto">
                {data ? <EventList events={data.events} compact /> : detail.error ? <K8sErrorNotice error={detail.error} onRetry={reload} className="m-4" /> : <TableSkeleton rows={3} />}
            </div>
        </div>
    );
}
