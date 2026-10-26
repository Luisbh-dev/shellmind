import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { LogStreamSource } from '@shared/ops';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import type { WorkspaceServer } from '@/workspace/types';
import { useElementWidth } from '@/lib/useElementWidth';
import { opsApi } from './api';
import { ErrorNotice, ToolButton } from './ui';
import { useRemote } from './useRemote';
import { availableViews } from './viewRegistry';
import type { LogRequest } from './viewTypes';

// The Operations tab of an SSH server: its views (services, containers,
// Compose projects, images, live logs...) come from the view registry.
// Nothing is requested before the tab is first opened; each view mounts on
// first use and then stays mounted (a running log stream survives a look at
// the services).

type OperationsPanelProps = {
    server: WorkspaceServer;
    isActive: boolean;
};

function Operations({ server, isActive }: OperationsPanelProps) {
    const t = useT();
    const [opened, setOpened] = useState(isActive);
    const [view, setView] = useState('services');
    const [visited, setVisited] = useState<Set<string>>(() => new Set(['services']));
    const [logRequest, setLogRequest] = useState<LogRequest | null>(null);
    // "Check again" bypasses the server's cache for one request. The key stays
    // the same, so the views (and a running log stream) keep the capabilities
    // they have while the new ones load.
    const bypassCache = useRef(false);
    const tabRefs = useRef(new Map<string, HTMLButtonElement>());
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    // In a narrow panel the view tabs and the privilege badge show icons only.
    const compact = width > 0 && width < 640;

    useEffect(() => {
        if (isActive) setOpened(true);
    }, [isActive]);

    const caps = useRemote((signal) => {
        const refresh = bypassCache.current;
        bypassCache.current = false;
        return opsApi.capabilities(server.id, refresh, signal);
    }, `caps:${server.id}`, opened);
    const { reload: reloadCaps } = caps;
    const redetect = useCallback(() => {
        bypassCache.current = true;
        reloadCaps();
    }, [reloadCaps]);

    const views = availableViews(caps.data);
    // A view the server turned out not to offer falls back to the first one.
    const current = views.some((entry) => entry.id === view) ? view : views[0]?.id;

    const show = useCallback((next: string) => {
        setView(next);
        setVisited((previous) => (previous.has(next) ? previous : new Set([...previous, next])));
    }, []);

    const followLogs = useCallback((source: LogStreamSource) => {
        setLogRequest((previous) => ({ source, nonce: (previous?.nonce ?? 0) + 1 }));
        show('logs');
    }, [show]);

    const onTabKey = (event: KeyboardEvent, index: number) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + step + views.length) % views.length;
        show(views[next].id);
        tabRefs.current.get(views[next].id)?.focus();
    };

    // The view tabs scroll when they do not fit (Spanish labels at 1366 px):
    // the selected one stays in sight, and an edge fades where more tabs are.
    const tablistRef = useRef<HTMLDivElement>(null);
    const [fade, setFade] = useState({ left: false, right: false });
    const updateFade = useCallback(() => {
        const list = tablistRef.current;
        if (!list) return;
        const next = { left: list.scrollLeft > 1, right: list.scrollLeft + list.clientWidth < list.scrollWidth - 1 };
        setFade((previous) => (previous.left === next.left && previous.right === next.right ? previous : next));
    }, []);
    useEffect(() => {
        const list = tablistRef.current;
        if (!list || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(updateFade);
        observer.observe(list);
        updateFade();
        return () => observer.disconnect();
    }, [updateFade, opened, views.length, compact]);
    useEffect(() => {
        if (!current) return undefined;
        const frame = requestAnimationFrame(() => tabRefs.current.get(current)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
        return () => cancelAnimationFrame(frame);
    }, [current, compact, width]);
    const stops = [fade.left ? 'transparent' : 'black', ...(fade.left ? ['black 1.5rem'] : []), ...(fade.right ? ['black calc(100% - 1.5rem)'] : []), fade.right ? 'transparent' : 'black'];
    const edgeFade = fade.left || fade.right ? `linear-gradient(to right, ${stops.join(', ')})` : undefined;

    if (!opened) return null;

    const data = caps.data;
    // On Windows `root` means "member of Administrators".
    const privilege = data
        ? data.root
            ? data.platform === 'windows'
                ? { label: t('ops.privilege.admin'), hint: t('ops.privilege.adminHint'), ok: true }
                : { label: t('ops.privilege.root'), hint: t('ops.privilege.rootHint'), ok: true }
            : data.sudo
                ? { label: t('ops.privilege.sudo'), hint: t('ops.privilege.sudoHint'), ok: true }
                : { label: t('ops.privilege.user'), hint: data.platform === 'windows' ? t('ops.privilege.windowsUserHint') : t('ops.privilege.userHint'), ok: false }
        : null;

    return (
        <div ref={rootRef} className="absolute inset-0 flex flex-col bg-ink-900">
            <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 pt-3">
                <div
                    ref={tablistRef}
                    role="tablist"
                    aria-label={t('ops.viewsLabel')}
                    className="-mb-px flex min-w-0 gap-1 overflow-x-auto scrollbar-hide"
                    style={edgeFade ? { maskImage: edgeFade, WebkitMaskImage: edgeFade } : undefined}
                    onScroll={updateFade}
                >
                    {views.map((entry, index) => {
                        const Icon = entry.icon;
                        const selected = current === entry.id;
                        const label = t(entry.labelKey);
                        return (
                            <button
                                key={entry.id}
                                ref={(element) => {
                                    if (element) tabRefs.current.set(entry.id, element);
                                    else tabRefs.current.delete(entry.id);
                                }}
                                id={`ops-tab-${server.id}-${entry.id}`}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={`ops-panel-${server.id}-${entry.id}`}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => show(entry.id)}
                                onKeyDown={(event) => onTabKey(event, index)}
                                title={compact ? label : undefined}
                                className={cn(
                                    'inline-flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors focus-ring rounded-t-md',
                                    selected ? 'border-brand-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
                                )}
                            >
                                <Icon className="h-4 w-4" aria-hidden="true" />
                                <span className={cn(compact && 'sr-only')}>{label}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="mb-2 ml-auto flex items-center gap-2">
                    {privilege && (
                        <span
                            className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]', privilege.ok ? 'border-white/10 text-zinc-300' : 'border-amber-500/30 text-amber-200')}
                            title={privilege.hint}
                        >
                            {privilege.ok ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />}
                            <span className={cn(compact && 'sr-only')}>{privilege.label}</span>
                            <span className="sr-only">{privilege.hint}</span>
                        </span>
                    )}
                    <ToolButton
                        compact
                        icon={<RefreshCw className="h-4 w-4" />}
                        label={t('ops.redetect')}
                        busy={caps.loading}
                        onClick={redetect}
                    />
                </div>
            </div>

            {data && caps.error ? (
                <ErrorNotice error={caps.error} title={t('ops.redetectFailed')} onRetry={redetect} className="mx-4 mt-3" />
            ) : null}

            <div className="relative min-h-0 flex-1">
                {!data ? (
                    caps.error ? (
                        <ErrorNotice error={caps.error} onRetry={redetect} className="m-4" />
                    ) : (
                        <div className="flex items-center gap-2 p-6 text-sm text-zinc-400" role="status">
                            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                            {t('ops.detecting')}
                        </div>
                    )
                ) : (
                    views.filter((entry) => visited.has(entry.id) || entry.id === current).map(({ id, Component }) => (
                        <div
                            key={id}
                            id={`ops-panel-${server.id}-${id}`}
                            role="tabpanel"
                            aria-labelledby={`ops-tab-${server.id}-${id}`}
                            hidden={current !== id}
                            className="absolute inset-0"
                        >
                            <Component server={server} caps={data} followLogs={followLogs} logRequest={logRequest} />
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

// Keyed by server: no state or stream carries over to another server.
export default function OperationsPanel(props: OperationsPanelProps) {
    return <Operations key={props.server.id} {...props} />;
}
