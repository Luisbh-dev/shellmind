import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpCircle, Boxes, ChevronLeft, DownloadCloud, MoreHorizontal, PowerOff, RefreshCw, RotateCw, ScrollText, Square } from 'lucide-react';
import { isValidComposeName, type ComposeAction, type ComposeProjectInfo, type LogStreamSource, type OpsActionResult, type OpsCapabilities } from '@shared/ops';
import { Menu, useConfirm, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useElementWidth } from '@/lib/useElementWidth';
import { opsApi } from './api';
import { ShellButton, containerStateLabel, containerTone } from './containerUi';
import { describeOpsError } from './errors';
import { EmptyState, ErrorNotice, SearchField, Section, StateBadge, ToolButton, type BadgeTone } from './ui';
import { useListDetailFocus } from './useListDetailFocus';
import { useRemote } from './useRemote';

// Compose projects of the server, found from their containers: their state,
// services, files, and the lifecycle actions (all confirmed first, `down`
// with what it removes). Actions show the command they ran and its output.

const ACTION_ICONS: Record<ComposeAction, typeof Square> = {
    up: ArrowUpCircle,
    update: DownloadCloud,
    restart: RotateCw,
    stop: Square,
    down: PowerOff
};
const PROJECT_ACTIONS: ComposeAction[] = ['up', 'update', 'restart', 'stop', 'down'];
const SERVICE_ACTIONS: ComposeAction[] = ['up', 'update', 'restart', 'stop'];
// What the files are needed for.
const NEEDS_FILES = new Set<ComposeAction>(['up', 'update']);

type Running = { project: string; action: ComposeAction; service?: string };
type LastRun = { project: string; action: ComposeAction; service?: string; ok: boolean; command: string | null; output: string };

function projectTone(project: ComposeProjectInfo): BadgeTone {
    if (project.containers.some((container) => containerTone(container) === 'bad')) return 'bad';
    if (project.running === 0) return 'idle';
    return project.running === project.containers.length ? 'ok' : 'warn';
}

type ComposeViewProps = {
    serverId: number;
    caps: OpsCapabilities;
    onFollowLogs: (source: LogStreamSource) => void;
};

export function ComposeView({ serverId, caps, onFollowLogs }: ComposeViewProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [running, setRunning] = useState<Running | null>(null);
    const [lastRun, setLastRun] = useState<LastRun | null>(null);

    const overview = useRemote((signal) => opsApi.compose(serverId, signal), `compose:${serverId}`);
    const projects = useMemo(() => overview.data?.projects ?? [], [overview.data]);
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return projects.filter((project) => !needle
            || project.name.toLowerCase().includes(needle)
            || (project.workingDir ?? '').toLowerCase().includes(needle)
            || project.containers.some((container) => (container.composeService ?? '').toLowerCase().includes(needle)));
    }, [projects, query]);

    const current = projects.find((project) => project.name === selected) ?? null;
    const wide = width >= 900;
    const focus = useListDetailFocus(selected, !wide);
    const tool = overview.data?.tool ?? null;

    const select = (name: string) => {
        focus.opening();
        setSelected(name);
    };

    // How a taken-down project comes back, with this server's Compose.
    const upCommand = `${tool ?? (overview.data?.engine === 'podman' ? 'podman-compose' : 'docker compose')} up -d`;

    // Why an action cannot run now (undefined: it can).
    const unavailable = (project: ComposeProjectInfo, action: ComposeAction): string | undefined => {
        if (!project.actionable) return t('ops.compose.unusableName');
        if (!tool) return t('ops.compose.noTool');
        if (NEEDS_FILES.has(action) && (project.missingFiles.length > 0 || project.configFiles.length === 0)) return t('ops.compose.needsFiles');
        if (tool !== 'docker compose' && (project.missingFiles.length > 0 || project.configFiles.length === 0)) return t('ops.compose.needsFiles');
        return undefined;
    };

    const confirmMessage = (project: ComposeProjectInfo, action: ComposeAction, service?: string): ReactNode => {
        if (service) return t(`ops.compose.confirm.${action}.service`, { name: project.name, service });
        const message = t(`ops.compose.confirm.${action}.message`, { name: project.name });
        if (action !== 'down') return message;
        return (
            <>
                <p>{message}</p>
                <ul className="mt-2 max-h-32 list-disc space-y-0.5 overflow-auto pl-5 font-mono text-xs text-zinc-300">
                    {project.containers.map((container) => <li key={container.id}>{container.name}</li>)}
                </ul>
                <p className="mt-2 text-amber-200/90">{t('ops.compose.confirm.down.keep', { command: upCommand })}</p>
            </>
        );
    };

    const runAction = async (project: ComposeProjectInfo, action: ComposeAction, service?: string) => {
        const ok = await confirm({
            title: service
                ? t(`ops.compose.confirm.${action}.serviceTitle`, { name: project.name, service })
                : t(`ops.compose.confirm.${action}.title`, { name: project.name }),
            message: confirmMessage(project, action, service),
            confirmLabel: t(`ops.compose.actions.${action}`),
            tone: action === 'up' ? 'default' : 'danger'
        });
        if (!ok) return;
        setRunning({ project: project.name, action, service });
        const target = service ? `${project.name}/${service}` : project.name;
        try {
            const result: OpsActionResult = await opsApi.composeAction(serverId, project.name, action, service);
            setLastRun({ project: project.name, action, service, ok: true, command: result.command, output: result.output });
            toast.success(t(`ops.compose.done.${action}`, { name: target }));
        } catch (error) {
            const { title, detail } = describeOpsError(error, t);
            setLastRun({ project: project.name, action, service, ok: false, command: null, output: detail ?? title });
            toast.error(t('ops.compose.failed', { name: target }), detail ? `${title} ${detail}` : title);
        } finally {
            setRunning(null);
            overview.reload();
        }
    };

    const listPane = (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('ops.compose.search')} className="w-full max-w-xs flex-1" inputRef={focus.fallback} />
                <div className="ml-auto">
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('ops.refresh')} onClick={overview.reload} busy={overview.loading} />
                </div>
            </div>
            {overview.data && !tool && (
                <div className="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/[0.06] px-4 py-2 text-xs text-amber-100" role="status">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('ops.compose.readOnly', { problem: overview.data.problem ?? '' })}</span>
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
                {overview.error ? (
                    <ErrorNotice error={overview.error} onRetry={overview.reload} className="m-4" />
                ) : overview.loading && !overview.data ? (
                    <div className="space-y-2 p-4" aria-hidden="true">
                        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-11 animate-pulse rounded-lg bg-white/[0.03]" />)}
                    </div>
                ) : visible.length === 0 ? (
                    <EmptyState
                        icon={<Boxes className="h-5 w-5" />}
                        title={projects.length ? t('ops.compose.noMatch') : t('ops.compose.empty')}
                        detail={projects.length ? undefined : t('ops.compose.emptyHint')}
                    />
                ) : (
                    <table className="w-full table-fixed text-xs">
                        <caption className="sr-only">{t('ops.compose.caption', { count: visible.length })}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <th scope="col" className="px-4 py-2 font-medium">{t('ops.compose.columns.name')}</th>
                                <th scope="col" className="w-36 px-2 py-2 font-medium">{t('ops.compose.columns.state')}</th>
                                {wide && <th scope="col" className="w-24 px-2 py-2 pr-4 text-right font-medium">{t('ops.compose.columns.services')}</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((project) => {
                                const isSelected = project.name === selected;
                                const services = new Set(project.containers.map((container) => container.composeService ?? container.name)).size;
                                return (
                                    <tr key={project.name} className={cn('border-b border-white/[0.04]', isSelected && 'bg-brand-500/[0.08]')}>
                                        <td className="px-4 py-1.5">
                                            <button
                                                ref={focus.rowRef(project.name)}
                                                type="button"
                                                onClick={() => select(project.name)}
                                                aria-current={isSelected || undefined}
                                                className="block w-full min-w-0 rounded text-left focus-ring"
                                            >
                                                <span className="flex items-center gap-1.5">
                                                    <span className="truncate font-medium text-zinc-100">{project.name}</span>
                                                    {(project.missingFiles.length > 0 || !project.actionable) && (
                                                        <AlertTriangle
                                                            className="h-3.5 w-3.5 shrink-0 text-amber-300"
                                                            aria-label={project.actionable ? t('ops.compose.filesMissingShort') : t('ops.compose.unusableName')}
                                                        />
                                                    )}
                                                </span>
                                                <span className="block truncate font-mono text-[11px] text-zinc-500">{project.workingDir ?? t('ops.compose.noDirectory')}</span>
                                            </button>
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <StateBadge tone={projectTone(project)} label={t('ops.compose.runningCount', { running: project.running, total: project.containers.length })} />
                                        </td>
                                        {wide && <td className="px-2 py-1.5 pr-4 text-right tabular-nums text-zinc-400">{services}</td>}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );

    const busyHere = running && current && running.project === current.name ? running : null;
    const lastHere = lastRun && current && lastRun.project === current.name ? lastRun : null;

    const detailPane = selected && (
        <section
            aria-label={t('ops.compose.detailLabel', { name: selected })}
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
                    {current?.workingDir && <p className="truncate font-mono text-[11px] text-zinc-400" title={current.workingDir}>{current.workingDir}</p>}
                </div>
                {current && <StateBadge tone={projectTone(current)} label={t('ops.compose.runningCount', { running: current.running, total: current.containers.length })} />}
            </div>

            {current ? (
                <div className="space-y-3 px-4 py-3">
                    {!current.actionable && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-100" role="status">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>{t('ops.compose.unusableNameNotice')}</span>
                        </div>
                    )}
                    {current.missingFiles.length > 0 && (
                        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-100" role="status">
                            <div className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {t('ops.compose.filesMissing')}
                            </div>
                            <ul className="mt-1 space-y-0.5 pl-5 font-mono text-[11px] text-amber-200/90">
                                {current.missingFiles.map((file) => <li key={file} className="break-all">{file}</li>)}
                            </ul>
                            <p className="mt-1 text-amber-200/80">{tool === 'docker compose' ? t('ops.compose.filesMissingHint') : t('ops.compose.filesMissingHintPodman')}</p>
                        </div>
                    )}

                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('ops.compose.actionsLabel')}>
                        {PROJECT_ACTIONS.map((action) => {
                            const Icon = ACTION_ICONS[action];
                            const reason = unavailable(current, action);
                            return (
                                <ToolButton
                                    key={action}
                                    icon={<Icon className="h-3.5 w-3.5" />}
                                    label={t(`ops.compose.actions.${action}`)}
                                    tone={action === 'down' || action === 'stop' ? 'danger' : action === 'update' ? 'primary' : 'default'}
                                    busy={busyHere?.action === action && !busyHere.service}
                                    disabled={running !== null || Boolean(reason)}
                                    disabledReason={reason}
                                    onClick={() => void runAction(current, action)}
                                />
                            );
                        })}
                        <ToolButton
                            icon={<ScrollText className="h-3.5 w-3.5" />}
                            label={t('ops.compose.logs')}
                            disabled={!tool || !current.actionable}
                            disabledReason={!current.actionable ? t('ops.compose.unusableName') : t('ops.compose.noTool')}
                            onClick={() => onFollowLogs({ kind: 'compose', project: current.name })}
                        />
                    </div>

                    {busyHere && (
                        <p className="flex items-center gap-2 text-xs text-zinc-300" role="status" aria-live="polite">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            {t(busyHere.action === 'update' ? 'ops.compose.runningSlow' : 'ops.compose.running', {
                                action: t(`ops.compose.actions.${busyHere.action}`),
                                name: busyHere.service ? `${current.name}/${busyHere.service}` : current.name
                            })}
                        </p>
                    )}

                    {lastHere && !busyHere && (
                        <Section
                            key={`${lastHere.action}-${lastHere.service ?? ''}-${lastHere.ok}`}
                            title={lastHere.ok ? t('ops.compose.lastRun.ok', { action: t(`ops.compose.actions.${lastHere.action}`) }) : t('ops.compose.lastRun.failed', { action: t(`ops.compose.actions.${lastHere.action}`) })}
                            defaultOpen={!lastHere.ok}
                        >
                            {lastHere.command && <code className="block break-all font-mono text-[11px] text-zinc-400">{lastHere.command}</code>}
                            <pre className={cn('max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-black/30 p-3 font-mono text-[11px] leading-relaxed', lastHere.ok ? 'border-white/[0.06] text-zinc-300' : 'border-rose-500/25 text-rose-100')}>
                                {lastHere.output.trim() || t('ops.compose.lastRun.noOutput')}
                            </pre>
                        </Section>
                    )}

                    <section aria-label={t('ops.compose.servicesLabel')} className="space-y-1.5">
                        <h4 className="text-xs font-semibold text-zinc-200">{t('ops.compose.servicesTitle', { count: current.containers.length })}</h4>
                        <ul className="divide-y divide-white/[0.05] rounded-lg border border-white/[0.06]">
                            {current.containers.map((container) => {
                                const service = container.composeService ?? container.name;
                                // Only a service name Compose could have given is passed back to it.
                                const usable = Boolean(container.composeService && isValidComposeName(container.composeService));
                                return (
                                    <li key={container.id} className="flex items-center gap-2 px-3 py-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="truncate text-xs font-medium text-zinc-100">{service}</span>
                                                <StateBadge tone={containerTone(container)} label={containerStateLabel(container, t)} />
                                            </div>
                                            <div className="truncate text-[11px] text-zinc-500" title={`${container.name} · ${container.image}`}>
                                                {container.name} · {container.image}
                                            </div>
                                        </div>
                                        <ShellButton compact serverId={serverId} caps={caps} container={container} />
                                        <Menu
                                            label={t('ops.compose.serviceActions', { service })}
                                            triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.08]"
                                            items={[
                                                ...SERVICE_ACTIONS.map((action) => {
                                                    const Icon = ACTION_ICONS[action];
                                                    return {
                                                        id: action,
                                                        label: t(`ops.compose.actions.${action}`),
                                                        icon: <Icon className="h-4 w-4" />,
                                                        disabled: running !== null || Boolean(unavailable(current, action)) || !usable,
                                                        danger: action === 'stop',
                                                        onSelect: () => void runAction(current, action, service)
                                                    };
                                                }),
                                                {
                                                    id: 'logs',
                                                    label: t('ops.compose.serviceLogs'),
                                                    icon: <ScrollText className="h-4 w-4" />,
                                                    disabled: !tool || !current.actionable || !usable,
                                                    onSelect: () => onFollowLogs({ kind: 'compose', project: current.name, service })
                                                }
                                            ]}
                                        >
                                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                        </Menu>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>

                    <Section title={t('ops.compose.files')} count={current.configFiles.length}>
                        {current.configFiles.length === 0 ? (
                            <p className="text-xs text-zinc-500">{t('ops.compose.noFiles')}</p>
                        ) : (
                            <ul className="space-y-0.5 font-mono text-[11px]">
                                {current.configFiles.map((file) => (
                                    <li key={file} className={cn('break-all', current.missingFiles.includes(file) ? 'text-amber-200 line-through decoration-amber-400/60' : 'text-zinc-300')}>
                                        {file}
                                        {current.missingFiles.includes(file) && <span className="sr-only"> {t('ops.compose.missing')}</span>}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {tool && <p className="text-[11px] text-zinc-500">{t('ops.compose.tool', { tool })}</p>}
                    </Section>
                </div>
            ) : (
                <p className="px-4 py-3 text-xs text-zinc-400">{t('ops.compose.gone', { command: upCommand })}</p>
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
