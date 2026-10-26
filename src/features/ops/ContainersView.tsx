import { useMemo, useState } from 'react';
import { BarChart3, Boxes, ChevronLeft, Container, Play, RefreshCw, RotateCw, Square, Trash2 } from 'lucide-react';
import { CONTAINER_ACTIONS, type ContainerAction, type ContainerInfo, type ContainerStats, type LogStreamSource, type OpsCapabilities } from '@shared/ops';
import { AskAiButton } from '@/components/AskAiButton';
import { useConfirm, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import { useElementWidth } from '@/lib/useElementWidth';
import { opsApi } from './api';
import { ContainerSections } from './ContainerDetail';
import { ShellButton, composeStatusLabel, containerStateLabel, containerTone } from './containerUi';
import { errorText } from './errors';
import { containerStatusText } from './format';
import { EmptyState, ErrorNotice, SearchField, Segmented, StateBadge, ToolButton } from './ui';
import { useListDetailFocus } from './useListDetailFocus';
import { useRemote } from './useRemote';

type Filter = 'all' | 'running' | 'stopped';

const ACTION_ICONS: Record<ContainerAction, typeof Play> = { start: Play, stop: Square, restart: RotateCw, remove: Trash2 };

type ContainersViewProps = {
    serverId: number;
    caps: OpsCapabilities;
    onFollowLogs: (source: LogStreamSource) => void;
};

export function ContainersView({ serverId, caps, onFollowLogs }: ContainersViewProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const [filter, setFilter] = useState<Filter>('all');
    const [project, setProject] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [showStats, setShowStats] = useState(false);
    const [running, setRunning] = useState<ContainerAction | null>(null);
    const engine = caps.containers.engine;

    const list = useRemote((signal) => opsApi.containers(serverId, signal), `containers:${serverId}`, Boolean(engine));
    const stats = useRemote((signal) => opsApi.containerStats(serverId, signal), `stats:${serverId}`, Boolean(engine) && showStats);
    const detail = useRemote((signal) => opsApi.container(serverId, selected ?? '', signal), `container:${serverId}:${selected}`, Boolean(selected));

    const containers = useMemo(() => list.data?.containers ?? [], [list.data]);
    const projects = useMemo(() => {
        const names = new Set(containers.map((container) => container.composeProject).filter((name): name is string => Boolean(name)));
        for (const entry of list.data?.projects ?? []) names.add(entry.name);
        return [...names].sort((a, b) => a.localeCompare(b));
    }, [containers, list.data]);
    const statsById = useMemo(() => {
        const map = new Map<string, ContainerStats>();
        for (const entry of stats.data ?? []) map.set(entry.id.slice(0, 12), entry);
        return map;
    }, [stats.data]);
    const counts = {
        all: containers.length,
        running: containers.filter((container) => container.state === 'running').length,
        stopped: containers.filter((container) => container.state !== 'running').length
    };
    const visible = containers.filter((container) => {
        if (filter === 'running' && container.state !== 'running') return false;
        if (filter === 'stopped' && container.state === 'running') return false;
        if (project && container.composeProject !== project) return false;
        const needle = query.trim().toLowerCase();
        return !needle || [container.name, container.image, container.composeService ?? ''].some((value) => value.toLowerCase().includes(needle));
    });

    const current = containers.find((container) => container.name === selected) ?? null;
    const wide = width >= 900;
    const focus = useListDetailFocus(selected, !wide);
    const statsFor = (container: ContainerInfo) => statsById.get(container.id.slice(0, 12));

    const select = (name: string) => {
        focus.opening();
        setSelected(name);
    };

    const refresh = () => {
        list.reload();
        if (showStats) stats.reload();
        if (selected) detail.reload();
    };

    const runAction = async (container: ContainerInfo, action: ContainerAction) => {
        const ok = await confirm({
            title: t(`ops.containers.confirm.${action}.title`, { name: container.name }),
            message: t(`ops.containers.confirm.${action}.message`, { name: container.name }),
            confirmLabel: t(`ops.containers.actions.${action}`),
            tone: action === 'start' ? 'default' : 'danger'
        });
        if (!ok) return;
        setRunning(action);
        try {
            await opsApi.containerAction(serverId, container.name, action);
            toast.success(t(`ops.containers.done.${action}`, { name: container.name }));
            if (action === 'remove') {
                focus.closing(null);
                setSelected(null);
            }
        } catch (error) {
            toast.error(t('ops.containers.failed', { name: container.name }), errorText(error, t));
        } finally {
            setRunning(null);
            refresh();
        }
    };

    if (!engine) {
        return (
            <EmptyState icon={<Container className="h-5 w-5" />} title={t('ops.containers.noEngine')} detail={caps.containers.problem ?? undefined} />
        );
    }

    const listPane = (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('ops.containers.search')} className="w-full max-w-xs flex-1" inputRef={focus.fallback} />
                <Segmented<Filter>
                    label={t('ops.containers.filterLabel')}
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: 'all', label: t('ops.containers.filter.all'), count: counts.all },
                        { value: 'running', label: t('ops.containers.filter.running'), count: counts.running },
                        { value: 'stopped', label: t('ops.containers.filter.stopped'), count: counts.stopped }
                    ]}
                />
                <div className="ml-auto flex items-center gap-1.5">
                    <ToolButton
                        icon={<BarChart3 className="h-3.5 w-3.5" />}
                        label={t('ops.containers.stats')}
                        pressed={showStats}
                        busy={showStats && stats.loading}
                        onClick={() => setShowStats((value) => !value)}
                    />
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('ops.refresh')} onClick={refresh} busy={list.loading} />
                </div>
            </div>
            {projects.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-4 py-2" role="group" aria-label={t('ops.containers.projects')}>
                    <Boxes className="mr-1 h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                    {projects.map((name) => {
                        const info = list.data?.projects.find((entry) => entry.name === name);
                        return (
                            <button
                                key={name}
                                type="button"
                                aria-pressed={project === name}
                                onClick={() => setProject((value) => (value === name ? null : name))}
                                title={info?.configFiles ?? undefined}
                                className={cn(
                                    'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors focus-ring',
                                    project === name ? 'border-brand-500/50 bg-brand-500/15 text-brand-100' : 'border-white/10 text-zinc-300 hover:bg-white/5'
                                )}
                            >
                                {name}
                                {info?.status && <span className="ml-1.5 text-zinc-500">{composeStatusLabel(info.status, t)}</span>}
                            </button>
                        );
                    })}
                </div>
            )}
            {showStats && stats.error ? <ErrorNotice error={stats.error} onRetry={stats.reload} className="mx-4 mt-3" /> : null}
            <div className="min-h-0 flex-1 overflow-auto">
                {list.error ? (
                    <ErrorNotice error={list.error} onRetry={list.reload} className="m-4" />
                ) : list.loading && !list.data ? (
                    <div className="space-y-2 p-4" aria-hidden="true">
                        {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-white/[0.03]" />)}
                    </div>
                ) : visible.length === 0 ? (
                    <EmptyState icon={<Container className="h-5 w-5" />} title={t('ops.containers.empty')} />
                ) : (
                    <table className="w-full table-fixed text-xs">
                        <caption className="sr-only">{t('ops.containers.caption', { count: visible.length })}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <th scope="col" className="px-4 py-2 font-medium">{t('ops.containers.columns.name')}</th>
                                <th scope="col" className="w-36 px-2 py-2 font-medium">{t('ops.containers.columns.state')}</th>
                                {wide && <th scope="col" className="w-48 px-2 py-2 font-medium">{t('ops.containers.columns.ports')}</th>}
                                {showStats && <th scope="col" className="w-16 px-2 py-2 text-right font-medium">{t('ops.containers.columns.cpu')}</th>}
                                {showStats && <th scope="col" className="w-20 px-2 py-2 text-right font-medium">{t('ops.containers.columns.memory')}</th>}
                                <th scope="col" className="w-14 px-2 py-2 pr-4"><span className="sr-only">{t('ops.containers.columns.shell')}</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((container) => {
                                const isSelected = container.name === selected;
                                const usage = statsFor(container);
                                return (
                                    <tr key={container.id} className={cn('border-b border-white/[0.04]', isSelected && 'bg-brand-500/[0.08]')}>
                                        <td className="px-4 py-1.5">
                                            <button
                                                ref={focus.rowRef(container.name)}
                                                type="button"
                                                onClick={() => select(container.name)}
                                                aria-current={isSelected || undefined}
                                                className="block w-full min-w-0 rounded text-left focus-ring"
                                            >
                                                <span className="block truncate font-medium text-zinc-100">{container.name}</span>
                                                <span className="block truncate text-[11px] text-zinc-500">
                                                    {[container.image, container.composeService && `${container.composeProject}/${container.composeService}`].filter(Boolean).join(' · ')}
                                                </span>
                                            </button>
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <StateBadge tone={containerTone(container)} label={containerStateLabel(container, t)} />
                                            <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={container.status}>{containerStatusText(container.status, t, language) ?? container.status}</div>
                                        </td>
                                        {wide && <td className="truncate px-2 py-1.5 font-mono text-[11px] text-zinc-400" title={container.ports}>{container.ports || '—'}</td>}
                                        {showStats && <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{usage?.cpuPercent != null ? formatPercent(usage.cpuPercent, language) : '—'}</td>}
                                        {showStats && <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300" title={usage?.memoryUsage}>{usage?.memoryPercent != null ? formatPercent(usage.memoryPercent, language) : '—'}</td>}
                                        <td className="px-2 py-1.5 pr-4 text-right">
                                            {container.state === 'running' && <ShellButton compact serverId={serverId} caps={caps} container={container} />}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );

    const detailPane = selected && (
        <section
            aria-label={t('ops.containers.detailLabel', { name: selected })}
            className={cn('flex min-h-0 min-w-0 flex-col overflow-auto', wide ? 'w-[34rem] shrink-0 border-l border-white/[0.06]' : 'flex-1')}
        >
            <div className="flex items-start gap-2 border-b border-white/[0.06] px-4 py-3">
                {!wide && (
                    <ToolButton
                        compact
                        icon={<ChevronLeft className="h-4 w-4" />}
                        label={t('ops.back')}
                        onClick={() => {
                            focus.closing(selected);
                            setSelected(null);
                        }}
                    />
                )}
                <div className="min-w-0 flex-1">
                    <h3 ref={focus.heading} tabIndex={-1} className="truncate text-sm font-semibold text-zinc-100 outline-none">{selected}</h3>
                    {current && <p className="truncate text-xs text-zinc-400">{current.image}</p>}
                </div>
                {current && <StateBadge tone={containerTone(current)} label={containerStateLabel(current, t)} />}
                {current && (
                    <AskAiButton
                        serverId={serverId}
                        attachment={{ kind: 'container', container: current.name, engine }}
                        label={t('ops.containers.askAi', { name: current.name })}
                    />
                )}
            </div>

            {current ? (
                <>
                    <div className="flex flex-wrap items-center gap-1.5 px-4 py-3" role="group" aria-label={t('ops.containers.actionsLabel')}>
                        <ShellButton serverId={serverId} caps={caps} container={current} />
                        {CONTAINER_ACTIONS.map((action) => {
                            const Icon = ACTION_ICONS[action];
                            return (
                                <ToolButton
                                    key={action}
                                    icon={<Icon className="h-3.5 w-3.5" />}
                                    label={t(`ops.containers.actions.${action}`)}
                                    tone={action === 'remove' || action === 'stop' ? 'danger' : 'default'}
                                    busy={running === action}
                                    disabled={(running !== null && running !== action) || (action === 'start' && current.state === 'running') || (action === 'stop' && current.state !== 'running')}
                                    onClick={() => void runAction(current, action)}
                                />
                            );
                        })}
                    </div>
                    <ContainerSections key={current.name} serverId={serverId} caps={caps} container={current} detail={detail} onFollowLogs={onFollowLogs} />
                </>
            ) : (
                <p className="px-4 py-3 text-xs text-zinc-400">{t('ops.containers.gone')}</p>
            )}
        </section>
    );

    return (
        <div ref={rootRef} className="flex h-full min-h-0">
            {(wide || !selected) && listPane}
            {detailPane}
        </div>
    );
}
