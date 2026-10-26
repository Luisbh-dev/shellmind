// The fleet board (Mod+Shift+H): the health of every SSH server on one
// screen, most urgent first, with filters, grouping and the actions a
// sysadmin takes from there (check again, open the server, ask the AI).
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    ArrowDown, ArrowUp, ArrowUpDown, Bell, HeartPulse, MoreHorizontal, Play, RefreshCw, RotateCw, Search, Settings2, ShieldAlert, WifiOff, X
} from 'lucide-react';
import { needsAttention, reachIntervalMinutes, type FleetMetrics, type FleetSettings as Settings } from '@shared/fleet';
import type { Tone } from '@shared/thresholds';
import type { ServerSummary } from '@shared/types';
import { AskAiButton } from '@/components/AskAiButton';
import { Button, EmptyState, IconButton, Input, LazyDialog, Menu, Modal, Select, Skeleton, useToast, type MenuItem } from '@/components/ui';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatPercent } from '@/lib/format';
import { lazyWithRetry } from '@/lib/lazy';
import { useElementSize } from '@/lib/useElementSize';
import { formatGB, formatLoad, formatMB, formatUptime } from '@/features/status/format';
import { serverSubtitle } from '@/features/organization/serverVisuals';
import { useAppStore } from '@/store/appStore';
import { loadServers, useServers } from '@/store/servers';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { requestFleetCheck, saveFleetSettings } from './api';
import { markRequested, setFleetSettings, unmarkRequested, useFleetFeed, useFleetStore } from './feed';
import { FleetSettings, intervalLabel } from './FleetSettings';
import {
    agoText, blockText, countStates, cpuReading, DEFAULT_DIRECTION, diskTone, errorText, failedTone, filterRows, fleetRows, groupRows, hasReboot,
    hasSecurityUpdates, isFiltered, isStale, memoryTone, namesOf, NO_FILTERS, opensRejectedLogin, sortRows, stateName, stateReason,
    type FleetFilters, type FleetRow, type GroupMode, type NameLookup, type SortDirection, type SortKey, type StateFilter, uptimeSecondsAt
} from './model';
import { notificationSupport, requestNotificationPermission, type NotificationSupport } from './notifications';
import { STATE_STYLE, StateBadge, TONE_ICON, TONE_TEXT } from './StateBadge';

const AddServerModal = lazyWithRetry(() => import('@/components/AddServerModal'));

const PREFS_KEY = 'shellmind.fleet.view';
const CLOCK_MS = 15_000;

type ViewPrefs = { group: GroupMode; sort: SortKey; direction: SortDirection };
const DEFAULT_PREFS: ViewPrefs = { group: 'none', sort: 'attention', direction: 'asc' };
const SORT_KEYS: readonly SortKey[] = ['attention', 'name', 'cpu', 'memory', 'disk', 'failed', 'updates', 'uptime', 'lastSeen'];

// The grouping and sort order are remembered on this device.
function readPrefs(): ViewPrefs {
    try {
        const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<ViewPrefs> | null;
        return {
            group: raw?.group === 'group' || raw?.group === 'tag' ? raw.group : 'none',
            sort: raw?.sort && SORT_KEYS.includes(raw.sort) ? raw.sort : DEFAULT_PREFS.sort,
            direction: raw?.direction === 'desc' ? 'desc' : 'asc'
        };
    } catch {
        return DEFAULT_PREFS;
    }
}

function writePrefs(prefs: ViewPrefs) {
    try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
        // Not remembered: the board opens with the defaults next time.
    }
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}

const STATE_FILTERS: Array<Exclude<StateFilter, 'all' | 'attention'>> = ['critical', 'unreachable', 'error', 'warn', 'ok', 'up', 'unknown'];

// Which columns fit the table's box: all of them; all but uptime; or, below
// 75rem (the Electron window is 1024 px wide at least), neither uptime nor
// reboot nor updates, whose flags then show under the server's name. 0: not
// measured (no layout engine).
type Layout = 'full' | 'wide' | 'compact';
const FULL_PX = 1304;
const WIDE_PX = 1200;

function layoutFor(width: number): Layout {
    if (width === 0 || width >= FULL_PX) return 'full';
    return width >= WIDE_PX ? 'wide' : 'compact';
}

// The sum of the column widths, the server's 12rem included.
const TABLE_WIDTH: Record<Layout, string> = { full: 'min-w-[81.5rem]', wide: 'min-w-[75rem]', compact: 'min-w-[58.5rem]' };

type Column = { key: SortKey | null; label: string; hint?: string; className: string; align?: 'right'; srOnly?: boolean };

type RowActions = {
    open: (serverId: number, tab: string) => void;
    edit: (serverId: number) => void;
    check: (ids: number[]) => void;
    toggleMonitoring: (row: FleetRow) => void;
};

function Dash({ label }: { label: string }) {
    return <span className="text-zinc-500" title={label}><span aria-hidden="true">—</span><span className="sr-only">{label}</span></span>;
}

// A reading in its tone's colour, with the tone's shape and word for
// whoever cannot tell the colours apart.
function Toned({ tone, children }: { tone: Tone; children: ReactNode }) {
    const t = useT();
    if (tone === 'ok') return <span className={TONE_TEXT.ok}>{children}</span>;
    const Icon = TONE_ICON[tone];
    return (
        <span className={cn('inline-flex items-center gap-1', TONE_TEXT[tone])}>
            <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
            {children}
            <span className="sr-only"> ({t(`fleet.tone.${tone}`)})</span>
        </span>
    );
}

function askAiPrompt(t: TranslateFn, language: string, row: FleetRow, names: NameLookup): string {
    const state = stateName(t, row);
    const details = stateReason(t, language, row.snapshot, 4, names);
    return details
        ? t('fleet.askAi.prompt', { name: row.server.name, state, details })
        : t('fleet.askAi.promptPlain', { name: row.server.name, state });
}

type Note = { text: string; tone: 'warn' | 'critical' | 'muted'; important: boolean };

// What stopped the checks of the row, or what its failure says (important),
// or a remark on how it is checked.
function rowNote(t: TranslateFn, language: string, row: FleetRow, settings: Settings | null, names: NameLookup, now: number): Note | null {
    const { snapshot, server } = row;
    if (snapshot?.hold === 'auth') return { text: t('fleet.notes.auth'), tone: 'warn', important: true };
    if (snapshot?.hold === 'host-key') return { text: t('fleet.notes.hostKey'), tone: 'critical', important: true };
    if (snapshot?.hold === 'config') {
        return { text: [t('fleet.notes.config'), snapshot.error ? errorText(t, snapshot.error, names) : ''].join(' ').trim(), tone: 'warn', important: true };
    }
    if (snapshot?.blocked) return { text: blockText(t, snapshot.blocked, names), tone: 'warn', important: true };
    if (snapshot && (row.state === 'unreachable' || row.state === 'error') && snapshot.error) {
        const seen = snapshot.lastSeenAt ? t('fleet.notes.unreachableSince', { when: agoText(snapshot.lastSeenAt, now, t, language) }) : t('fleet.notes.neverReached');
        return { text: `${errorText(t, snapshot.error, names)} · ${seen}`, tone: row.state === 'unreachable' ? 'critical' : 'warn', important: true };
    }
    // Only Remote Desktop answered: what needs SSH cannot reach it. A warning
    // when SSH answered before (its OpenSSH server may have stopped).
    if (snapshot?.reachedVia === 'rdp') {
        return snapshot.sshSeenAt !== null
            ? { text: t('fleet.notes.sshStopped', { when: agoText(snapshot.sshSeenAt, now, t, language) }), tone: 'warn', important: true }
            : { text: t('fleet.notes.rdpOnly'), tone: 'muted', important: false };
    }
    if (snapshot && !snapshot.monitored) return { text: t('fleet.notes.excluded'), tone: 'muted', important: false };
    if (row.state === 'up') return { text: t('fleet.notes.up'), tone: 'muted', important: false };
    if (!snapshot?.checkedAt && server.jump_server_id && !settings?.enabled) return { text: t('fleet.notes.behindJump'), tone: 'muted', important: false };
    return null;
}

const NOTE_TONE = { warn: 'text-amber-300', critical: 'text-rose-300', muted: 'text-zinc-400' } as const;

// What a click on the row (or its name) does. Opening a server whose
// credentials (or whose jump host's) were just rejected would log in with
// them again at once, so those rows open the connection to fix instead; a
// changed host key is compared and trusted in the terminal, before any login.
function primaryAction(t: TranslateFn, row: FleetRow, names: NameLookup, actions: RowActions): { label: string; run: () => void } {
    const { server, snapshot } = row;
    const block = snapshot?.blocked?.kind === 'jump-host' ? snapshot.blocked : null;
    const hold = snapshot?.hold ?? block?.hold ?? null;
    const target = block ? block.serverId : server.id;
    const name = block ? names(block.serverId) ?? `#${block.serverId}` : server.name;
    if (hold === 'auth' || hold === 'config') {
        return { label: t(block ? 'fleet.actions.fixJump' : 'fleet.actions.fix', { name }), run: () => actions.edit(target) };
    }
    if (hold === 'host-key') return { label: t('fleet.actions.compareKeys', { name }), run: () => actions.open(target, 'terminal') };
    return { label: t('fleet.actions.open', { name: server.name }), run: () => actions.open(server.id, 'status') };
}

// Reboot and updates under the server's name, when their columns do not fit.
function Flags({ metrics }: { metrics: FleetMetrics }) {
    const t = useT();
    const updates = metrics.updates;
    const security = updates?.security ?? 0;
    if (!metrics.rebootRequired && !updates?.count) return null;
    return (
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] leading-4">
            {metrics.rebootRequired && (
                <span className="inline-flex items-center gap-0.5 text-amber-300">
                    <RotateCw className="h-3 w-3" aria-hidden="true" />{t('fleet.filters.reboot')}
                </span>
            )}
            {updates && updates.count > 0 && (
                <span className={cn('inline-flex items-center gap-0.5', security > 0 ? 'text-rose-300' : 'text-zinc-300')}>
                    {security > 0 && <ShieldAlert className="h-3 w-3" aria-hidden="true" />}
                    {updates.count === 1 ? t('fleet.values.updatesCountOne') : t('fleet.values.updatesCount', { count: updates.count })}
                    {security > 0 && ` · ${t('fleet.values.updatesSecurity', { count: security })}`}
                </span>
            )}
        </span>
    );
}

// The readings of a row, each in the tone of its own threshold. `lastKnown`:
// they predate the latest check (dimmed).
function MetricCells({ metrics, lastKnown, layout, now }: { metrics: FleetMetrics | null; lastKnown: boolean; layout: Layout; now: number }) {
    const t = useT();
    const uptime = uptimeSecondsAt(metrics, now);
    const language = useLanguage();
    const unknown = t('fleet.values.unknown');
    const cpu = cpuReading(metrics);
    const updates = metrics?.updates ?? null;
    const cell = (extra?: string) => cn('px-2 py-2 text-xs', extra, lastKnown && 'opacity-60');
    const number = 'text-right font-mono tabular-nums';
    const failed = metrics?.failedUnits ?? null;
    return (
        <>
            <td
                className={cell(number)}
                title={metrics?.load ? t('fleet.values.loadHint', {
                    one: formatLoad(metrics.load.one, language), five: formatLoad(metrics.load.five, language),
                    fifteen: formatLoad(metrics.load.fifteen, language), cores: metrics.cores ?? '?'
                }) : undefined}
            >
                {cpu ? (
                    <Toned tone={cpu.tone}>
                        {cpu.kind === 'cpu' ? formatPercent(cpu.value, language) : t('fleet.values.perCore', { value: formatLoad(cpu.value, language) })}
                    </Toned>
                ) : <Dash label={unknown} />}
            </td>
            <td
                className={cell(number)}
                title={metrics?.memory ? t('fleet.values.memoryHint', { available: formatMB(metrics.memory.availableMB, language), total: formatMB(metrics.memory.totalMB, language) }) : undefined}
            >
                {metrics?.memory ? <Toned tone={memoryTone(metrics)}>{formatPercent(metrics.memory.usagePercent, language)}</Toned> : <Dash label={unknown} />}
            </td>
            <td
                className={cell(number)}
                title={metrics?.disk ? `${metrics.disk.mount} · ${t('fleet.values.diskHint', { free: formatGB(metrics.disk.freeGB, language), total: formatGB(metrics.disk.totalGB, language) })}` : undefined}
            >
                {metrics?.disk ? (
                    <span className="flex min-w-0 items-baseline justify-end gap-1.5">
                        <span className="truncate text-[11px] text-zinc-400">{metrics.disk.mount}</span>
                        <Toned tone={diskTone(metrics)}>{formatPercent(metrics.disk.usagePercent, language)}</Toned>
                    </span>
                ) : <Dash label={unknown} />}
            </td>
            <td className={cell(number)}>
                {failed === null ? <Dash label={unknown} />
                    : failed === 0 ? <span className="text-zinc-500">0</span>
                        : <Toned tone={failedTone(metrics) === 'critical' ? 'critical' : 'warn'}>{failed}</Toned>}
            </td>
            {layout !== 'compact' && (
                <>
                    <td className={cell()}>
                        {metrics?.rebootRequired
                            ? <span className="inline-flex items-center gap-1 text-amber-300"><RotateCw className="h-3 w-3" aria-hidden="true" />{t('fleet.values.rebootPending')}</span>
                            : <Dash label={metrics?.rebootRequired === false ? t('fleet.values.rebootNotNeeded') : unknown} />}
                    </td>
                    <td
                        className={cell()}
                        title={updates ? (updates.cacheAt
                            ? t('fleet.values.updatesFrom', { manager: updates.manager, when: formatDateTime(updates.cacheAt, language) })
                            : t('fleet.values.updatesManager', { manager: updates.manager })) : undefined}
                    >
                        {!updates ? <Dash label={unknown} />
                            : updates.count === 0 ? <span className="text-zinc-500">{t('fleet.values.updatesNone')}</span>
                                : (
                                    <span className="flex flex-col leading-4">
                                        <span className="font-mono tabular-nums text-zinc-200">{updates.count}</span>
                                        {(updates.security ?? 0) > 0 && (
                                            <span className="inline-flex items-center gap-0.5 text-[11px] text-rose-300">
                                                <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                                                {t('fleet.values.updatesSecurity', { count: updates.security ?? 0 })}
                                            </span>
                                        )}
                                    </span>
                                )}
                    </td>
                </>
            )}
            {layout === 'full' && (
                <td
                    className={cell('text-zinc-300')}
                    title={metrics?.bootedAt ? t('fleet.values.bootedAt', { when: formatDateTime(metrics.bootedAt, language) }) : undefined}
                >
                    {uptime != null ? formatUptime(uptime, t) : <Dash label={unknown} />}
                </td>
            )}
        </>
    );
}

const FleetTableRow = memo(function FleetTableRow({ row, settings, now, actions, names, layout, metricColumns }: {
    row: FleetRow;
    settings: Settings | null;
    now: number;
    actions: RowActions;
    names: NameLookup;
    layout: Layout;
    metricColumns: number;
}) {
    const t = useT();
    const language = useLanguage();
    const { server, snapshot, state } = row;
    const metrics = snapshot?.metrics ?? null;
    // A reading older than the latest check (which failed, or only found
    // the server reachable) is the last known one.
    const lastKnown = Boolean(metrics) && (state === 'unreachable' || state === 'error' || state === 'up');
    const stale = isStale(snapshot, settings, now);
    const note = rowNote(t, language, row, settings, names, now);
    const reason = state === 'warn' || state === 'critical' ? stateReason(t, language, snapshot, 3, names) : '';
    const subtitle = [serverSubtitle(server), metrics?.os].filter(Boolean).join(' · ');
    const stateId = useId();
    const detailId = useId();
    const primary = primaryAction(t, row, names, actions);
    const jumpBlock = snapshot?.blocked?.kind === 'jump-host' ? snapshot.blocked : null;
    const heldLogin = opensRejectedLogin(snapshot);

    // Under the name: what stopped its checks or what its failure says, else
    // why it needs attention, else a remark. Without readings, the note takes
    // the place of the values.
    const detail: Note | null = metrics
        ? (note?.important ? note : reason ? { text: reason, tone: state === 'critical' ? 'critical' : 'warn', important: true } : note)
        : null;
    const spanning = metrics ? null : note;

    const menuItems: MenuItem[] = [
        { id: 'status', label: t('fleet.actions.openStatus'), onSelect: () => actions.open(server.id, 'status') },
        { id: 'terminal', label: t('fleet.actions.openTerminal'), onSelect: () => actions.open(server.id, 'terminal') },
        { id: 'operations', label: t('fleet.actions.openOperations'), onSelect: () => actions.open(server.id, 'operations') },
        { id: 'edit', label: t('fleet.actions.edit'), onSelect: () => actions.edit(server.id) },
        {
            id: 'monitoring',
            label: snapshot?.monitored === false ? t('fleet.actions.include') : t('fleet.actions.exclude'),
            onSelect: () => actions.toggleMonitoring(row)
        }
    ];

    const seenTitle = [
        snapshot?.lastSeenAt ? t('fleet.values.seenAt', { when: formatDateTime(snapshot.lastSeenAt, language) }) : null,
        snapshot?.reachedVia === 'rdp'
            ? (snapshot.sshSeenAt !== null ? t('fleet.values.sshSeenAt', { when: formatDateTime(snapshot.sshSeenAt, language) }) : t('fleet.values.sshNever'))
            : null,
        snapshot?.readAt && snapshot.readAt !== snapshot.lastSeenAt ? t('fleet.values.readAt', { when: formatDateTime(snapshot.readAt, language) }) : null,
        snapshot?.checkedAt && snapshot.checkedAt !== snapshot.lastSeenAt ? t('fleet.values.checkedAt', { when: formatDateTime(snapshot.checkedAt, language) }) : null,
        snapshot?.nextCheckAt ? t('fleet.values.nextCheck', { when: formatDateTime(snapshot.nextCheckAt, language) }) : null,
        snapshot?.handshakeMs != null ? t('fleet.values.latency', { value: snapshot.handshakeMs }) : null
    ].filter(Boolean).join('\n');

    const check = jumpBlock
        ? { label: t('fleet.actions.checkJump', { name: names(jumpBlock.serverId) ?? `#${jumpBlock.serverId}` }), ids: [jumpBlock.serverId] }
        : { label: t('fleet.actions.checkNow', { name: server.name }), ids: [server.id] };

    return (
        // A click anywhere on the row does what its name does, for the mouse;
        // the name button is the same action for the keyboard and screen readers.
        <tr
            data-fleet-row={server.id}
            data-state={state}
            onClick={(event) => {
                if ((event.target as Element).closest('button, a, input, [role="menu"]')) return;
                primary.run();
            }}
            className={cn(
                'cursor-pointer border-t border-white/5 align-top transition-colors hover:bg-white/[0.03]',
                (state === 'critical' || state === 'unreachable') && 'bg-rose-500/[0.03]'
            )}
        >
            <td className="px-2 py-2">
                <StateBadge id={stateId} state={state} snapshot={snapshot} checking={row.checking} stale={stale && !row.checking && state !== 'unknown'} />
            </td>
            <th scope="row" className="min-w-0 px-2 py-1.5 text-left font-normal">
                <button
                    type="button"
                    onClick={primary.run}
                    title={primary.label}
                    aria-describedby={detail || spanning ? `${stateId} ${detailId}` : stateId}
                    className="block max-w-full truncate rounded text-left text-[13px] font-medium text-zinc-100 hover:underline focus-ring"
                >
                    {server.name}
                </button>
                <span className="block truncate font-mono text-[11px] text-zinc-400" title={subtitle}>{subtitle}</span>
                {layout === 'compact' && metrics && <Flags metrics={metrics} />}
                {detail && <span id={detailId} className={cn('mt-0.5 block truncate text-[11px] leading-4', NOTE_TONE[detail.tone])} title={detail.text}>{detail.text}</span>}
            </th>
            {spanning ? (
                <td colSpan={metricColumns} className="px-2 py-2 text-xs">
                    <span id={detailId} className={cn('line-clamp-2 leading-4', NOTE_TONE[spanning.tone])} title={spanning.text}>{spanning.text}</span>
                </td>
            ) : <MetricCells metrics={metrics} lastKnown={lastKnown} layout={layout} now={now} />}
            <td className={cn('px-2 py-2 text-xs', stale ? 'text-amber-300' : 'text-zinc-300')} title={seenTitle || undefined}>
                {snapshot?.lastSeenAt
                    ? <time dateTime={new Date(snapshot.lastSeenAt).toISOString()}>{agoText(snapshot.lastSeenAt, now, t, language)}</time>
                    : <span className="text-zinc-500">{t('fleet.values.never')}</span>}
            </td>
            <td className="px-1 py-1">
                <div className="flex items-center justify-end gap-0.5">
                    <IconButton size="sm" variant="ghost" label={check.label} disabled={row.checking} onClick={() => actions.check(check.ids)}>
                        <RefreshCw className={cn('h-3.5 w-3.5', row.checking && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
                    </IconButton>
                    <AskAiButton
                        serverId={server.id}
                        attachment={{ kind: 'status' }}
                        prompt={askAiPrompt(t, language, row, names)}
                        label={t('common.askAi.about', { name: server.name })}
                        disabledReason={heldLogin ? t('fleet.actions.askAiHeld') : undefined}
                    />
                    <Menu label={t('fleet.actions.more', { name: server.name })} items={menuItems} triggerClassName="h-7 w-7">
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </Menu>
                </div>
            </td>
        </tr>
    );
});

function SortHeader({ column, sort, direction, onSort }: {
    column: Column;
    sort: SortKey;
    direction: SortDirection;
    onSort: (key: SortKey) => void;
}) {
    const t = useT();
    const hintId = useId();
    const active = column.key !== null && sort === column.key;
    const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined;
    const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
    return (
        <th scope="col" aria-sort={ariaSort} className={cn('px-2 py-2 font-semibold', column.className, column.align === 'right' && 'text-right')} title={column.hint}>
            {column.key === null ? (
                <span className={cn(column.srOnly && 'sr-only')}>{column.label}</span>
            ) : (
                <button
                    type="button"
                    onClick={() => onSort(column.key!)}
                    aria-label={t('fleet.columns.sort', { column: column.label })}
                    aria-describedby={column.hint ? hintId : undefined}
                    className={cn(
                        'max-w-full rounded uppercase leading-tight tracking-wider hover:text-zinc-100 focus-ring',
                        column.align === 'right' ? 'text-right' : 'text-left',
                        active && 'text-zinc-100'
                    )}
                >
                    {/* Inline, so a label that wraps keeps the arrow next to its last word. */}
                    {column.label}
                    <Icon className={cn('ml-1 inline h-3 w-3 align-[-2px]', !active && 'opacity-40')} aria-hidden="true" />
                </button>
            )}
            {column.hint && <span id={hintId} className="sr-only">{column.hint}</span>}
        </th>
    );
}

export default function FleetBoard({ onClose }: GlobalActionProps) {
    const t = useT();
    const toast = useToast();
    const id = useId();
    useFleetFeed();
    const { servers, status: serversStatus } = useServers();
    const status = useFleetStore((state) => state.status);
    const settings = useFleetStore((state) => state.settings);
    const snapshots = useFleetStore((state) => state.snapshots);
    const requested = useFleetStore((state) => state.requested);
    const now = useNow(CLOCK_MS);
    const searchRef = useRef<HTMLInputElement>(null);
    const [boxRef, box] = useElementSize<HTMLDivElement>();
    const layout = layoutFor(box.width);

    const [filters, setFilters] = useState<FleetFilters>(NO_FILTERS);
    const [prefs, setPrefs] = useState<ViewPrefs>(readPrefs);
    const [showSettings, setShowSettings] = useState(false);
    const [checkingAll, setCheckingAll] = useState(false);
    const [editing, setEditing] = useState<ServerSummary | null>(null);
    const [permission, setPermission] = useState<NotificationSupport>(() => notificationSupport());

    useEffect(() => writePrefs(prefs), [prefs]);

    // "Ask AI" on a row: the chat lives in the server's workspace, so the
    // server opens (its chat then takes the question) and the board closes.
    useEffect(() => useAppStore.subscribe((state, previous) => {
        const request = state.chatRequest;
        if (!request || request === previous.chatRequest || request.kind !== 'context') return;
        state.requestServerTab(request.serverId, 'status');
        onClose();
    }), [onClose]);

    const names = useMemo(() => namesOf(servers), [servers]);
    const rows = useMemo(() => fleetRows(servers, snapshots, requested, now), [servers, snapshots, requested, now]);
    const counts = useMemo(() => countStates(rows), [rows]);
    const rebootCount = rows.filter(hasReboot).length;
    const securityCount = rows.filter(hasSecurityUpdates).length;
    const groups = useMemo(
        () => groupRows(sortRows(filterRows(rows, filters), prefs.sort, prefs.direction), prefs.group),
        [rows, filters, prefs]
    );
    const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);
    const filtered = isFiltered(filters);

    // "/" filters, as in most list views (unless typing somewhere already).
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('[role="listbox"], [role="menu"]'))) return;
            event.preventDefault();
            searchRef.current?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const apiErrorText = (err: unknown) => (err instanceof ApiError ? err.message : undefined);

    // The rows spin from the click on: the checks may finish (and be
    // reported) before the request's answer arrives.
    const check = useCallback(async (ids?: number[]) => {
        const expected = ids ?? Object.values(useFleetStore.getState().snapshots)
            .filter((snapshot) => snapshot.monitored && !snapshot.hold && !snapshot.blocked)
            .map((snapshot) => snapshot.serverId);
        markRequested(expected);
        try {
            const result = await requestFleetCheck(ids);
            unmarkRequested(expected.filter((serverId) => !result.queued.includes(serverId)));
            const waiting = result.skipped.find((skip) => skip.reason === 'jump-host');
            if (waiting) toast.info(t('fleet.toasts.jumpHost'), t('fleet.toasts.jumpHostText', { name: names(waiting.serverId) ?? `#${waiting.serverId}` }));
            else if (!result.queued.length) toast.info(t('fleet.toasts.nothingToCheck'));
        } catch (err) {
            unmarkRequested(expected);
            toast.error(t('fleet.toasts.refreshFailed'), apiErrorText(err));
        }
    }, [toast, t, names]);

    const checkAll = async () => {
        setCheckingAll(true);
        await check();
        setCheckingAll(false);
    };

    const saveSettings = useCallback(async (update: Partial<Settings>) => {
        try {
            setFleetSettings(await saveFleetSettings(update));
        } catch (err) {
            toast.error(t('fleet.toasts.saveFailed'), apiErrorText(err));
        }
    }, [toast, t]);

    // Asked from a click, as browsers require; the answer is remembered.
    const askPermission = async () => {
        setPermission(await requestNotificationPermission());
    };

    const turnOnHealthChecks = () => {
        if (settings?.notifications) void askPermission();
        void saveSettings({ enabled: true });
    };

    const actions = useMemo<RowActions>(() => ({
        open: (serverId, tab) => {
            useAppStore.getState().requestServerTab(serverId, tab);
            onClose();
        },
        edit: (serverId) => setEditing(servers.find((server) => server.id === serverId) ?? null),
        check: (ids) => void check(ids),
        toggleMonitoring: (row) => {
            const excluded = useFleetStore.getState().settings?.excludedServerIds ?? [];
            const next = excluded.includes(row.server.id) ? excluded.filter((other) => other !== row.server.id) : [...excluded, row.server.id];
            void saveSettings({ excludedServerIds: next });
        }
    }), [check, onClose, saveSettings, servers]);

    const onSort = (key: SortKey) => setPrefs((current) => ({
        ...current,
        sort: key,
        direction: current.sort === key ? (current.direction === 'asc' ? 'desc' : 'asc') : DEFAULT_DIRECTION[key]
    }));

    // Fixed widths but the server's, which takes the rest (12rem at least).
    const compact = layout === 'compact';
    const columns: Column[] = [
        { key: 'attention', label: t('fleet.columns.state'), className: compact ? 'w-[8rem]' : 'w-[8.5rem]' },
        { key: 'name', label: t('fleet.columns.server'), className: '' },
        { key: 'cpu', label: t('fleet.columns.cpu'), hint: t('fleet.columns.cpuHint'), className: 'w-[6.5rem]', align: 'right' },
        { key: 'memory', label: t('fleet.columns.memory'), className: 'w-[5.5rem]', align: 'right' },
        { key: 'disk', label: t('fleet.columns.disk'), className: compact ? 'w-[8rem]' : 'w-[8.5rem]', align: 'right' },
        { key: 'failed', label: t('fleet.columns.failed'), hint: t('fleet.columns.failedHint'), className: compact ? 'w-[6rem]' : 'w-[7.5rem]', align: 'right' },
        ...(compact ? [] : [
            { key: null, label: t('fleet.columns.reboot'), className: 'w-[6.5rem]' },
            { key: 'updates', label: t('fleet.columns.updates'), hint: t('fleet.columns.updatesHint'), className: 'w-[7.5rem]' }
        ] satisfies Column[]),
        ...(layout === 'full' ? [{ key: 'uptime', label: t('fleet.columns.uptime'), className: 'w-[6.5rem]' }] satisfies Column[] : []),
        { key: 'lastSeen', label: t('fleet.columns.lastSeen'), className: 'w-[6.5rem]' },
        { key: null, label: t('fleet.columns.actions'), className: 'w-[6rem]', srOnly: true }
    ];
    // Every column but state, server, last seen and actions.
    const metricColumns = columns.length - 4;

    const sshCount = rows.length;
    const description = settings?.enabled
        ? t(sshCount === 1 ? 'fleet.description.onOne' : 'fleet.description.on', { count: sshCount, interval: intervalLabel(t, settings.intervalMinutes) })
        : settings?.reachability
            ? t(sshCount === 1 ? 'fleet.description.reachOne' : 'fleet.description.reach', { count: sshCount, interval: intervalLabel(t, reachIntervalMinutes(settings)) })
            : t(sshCount === 1 ? 'fleet.description.offOne' : 'fleet.description.off', { count: sshCount });

    const chip = (value: StateFilter, label: string, count: number, tone?: string) => {
        const active = filters.state === value;
        return (
            <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((current) => ({ ...current, state: active && value !== 'all' ? 'all' : value }))}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus-ring',
                    active ? 'border-brand-500/40 bg-brand-500/15 text-brand-200' : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06]'
                )}
            >
                {tone && <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', tone)} />}
                {label}
                <span className={cn('font-mono tabular-nums', active ? 'text-brand-100' : 'text-zinc-400')}>{count}</span>
            </button>
        );
    };

    const flagChip = (key: 'reboot' | 'security', label: string, count: number, Icon: typeof RotateCw) => {
        const active = filters[key];
        if (!count && !active) return null;
        return (
            <button
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((current) => ({ ...current, [key]: !current[key] }))}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus-ring',
                    active ? 'border-brand-500/40 bg-brand-500/15 text-brand-200' : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06]'
                )}
            >
                <Icon className="h-3 w-3" aria-hidden="true" />
                {label}
                <span className={cn('font-mono tabular-nums', active ? 'text-brand-100' : 'text-zinc-400')}>{count}</span>
            </button>
        );
    };

    const loading = (serversStatus === 'loading' && servers.length === 0) || (status === 'connecting' && !settings);
    const automatic = Boolean(settings && (settings.enabled || settings.reachability));

    return (
        <Modal
            open
            onClose={onClose}
            title={t('fleet.title')}
            description={description}
            icon={<HeartPulse className="h-4 w-4" />}
            widthClass="max-w-[min(100rem,calc(100vw-2rem))]"
            className="h-[calc(100vh-2rem)]"
            bodyClassName="flex flex-col gap-3 overflow-hidden px-4 py-3"
        >
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('fleet.summary.label')}>
                {chip('all', t('fleet.filters.all'), counts.all)}
                {chip('attention', t('fleet.filters.attention'), counts.attention)}
                <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />
                {STATE_FILTERS.filter((state) => counts[state] > 0 || filters.state === state).map((state) => chip(
                    state,
                    state === 'unknown' ? t('fleet.state.unchecked') : t(`fleet.state.${state}`),
                    counts[state],
                    STATE_STYLE[state].dot
                ))}
                {(rebootCount > 0 || securityCount > 0 || filters.reboot || filters.security) && <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />}
                {flagChip('reboot', t('fleet.filters.reboot'), rebootCount, RotateCw)}
                {flagChip('security', t('fleet.filters.security'), securityCount, ShieldAlert)}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                    <Input
                        ref={searchRef}
                        type="search"
                        aria-label={t('fleet.filters.search')}
                        value={filters.query}
                        onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                        placeholder={t('fleet.filters.searchPlaceholder')}
                        className="h-8 pl-8 text-xs"
                        maxLength={200}
                    />
                </div>
                <div className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="text-xs text-zinc-400">{t('fleet.filters.groupBy')}</span>
                    <div className="w-36">
                        <Select
                            aria-label={t('fleet.filters.groupBy')}
                            value={prefs.group}
                            onChange={(value) => setPrefs((current) => ({ ...current, group: value as GroupMode }))}
                            options={[
                                { value: 'none', label: t('fleet.filters.groupNone') },
                                { value: 'group', label: t('fleet.filters.groupGroup') },
                                { value: 'tag', label: t('fleet.filters.groupTag') }
                            ]}
                            className="h-8 text-xs"
                        />
                    </div>
                </div>
                {filtered && (
                    <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
                        <X className="h-3.5 w-3.5" aria-hidden="true" />{t('fleet.filters.clear')}
                    </Button>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {status === 'offline' && (
                        <span role="status" className="inline-flex items-center gap-1 text-xs text-amber-300">
                            <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />{t('fleet.feed.offline')}
                        </span>
                    )}
                    {/* Alerts are on but the browser was never asked: ask from here. */}
                    {automatic && settings?.notifications && permission === 'default' && (
                        <Button size="sm" variant="ghost" onClick={() => void askPermission()}>
                            <Bell className="h-3.5 w-3.5" aria-hidden="true" />{t('fleet.settings.notificationsAllow')}
                        </Button>
                    )}
                    <IconButton
                        label={t('fleet.actions.settings')}
                        active={showSettings}
                        aria-expanded={showSettings}
                        aria-controls={`${id}-settings`}
                        onClick={() => setShowSettings((open) => !open)}
                    >
                        <Settings2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <Button size="sm" variant="primary" loading={checkingAll} disabled={sshCount === 0} onClick={() => void checkAll()} title={t('fleet.actions.checkAllHint')}>
                        {!checkingAll && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('fleet.actions.checkAll')}
                    </Button>
                </div>
            </div>

            {showSettings && (
                <div id={`${id}-settings`} className="rounded-xl border border-white/10 bg-ink-900/50 p-4">
                    <FleetSettings showHeading={false} className="max-w-3xl" />
                </div>
            )}

            {settings && !settings.enabled && sshCount > 0 && !showSettings && (
                <div className="flex flex-wrap items-start gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3">
                    <HeartPulse className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
                    <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm font-medium text-zinc-100">{settings.reachability ? t('fleet.off.reachTitle') : t('fleet.off.title')}</p>
                        <p className="text-xs text-zinc-300">
                            {t(settings.reachability ? 'fleet.off.reachText' : 'fleet.off.text', { interval: intervalLabel(t, settings.intervalMinutes) })}
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="subtle" onClick={() => void checkAll()} loading={checkingAll}>{t('fleet.off.checkOnce')}</Button>
                        <Button size="sm" variant="primary" onClick={turnOnHealthChecks}>
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />{settings.reachability ? t('fleet.off.enableHealth') : t('fleet.off.enable')}
                        </Button>
                    </div>
                </div>
            )}

            <div ref={boxRef} className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/5 scrollbar-thin">
                {loading ? (
                    <div className="space-y-2 p-3" role="status" aria-busy="true">
                        <span className="sr-only">{t('fleet.feed.loading')}</span>
                        {[0, 1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-9 rounded-lg" />)}
                    </div>
                ) : sshCount === 0 ? (
                    <EmptyState icon={<HeartPulse className="h-5 w-5" />} title={t('fleet.empty.noServers')} description={t('fleet.empty.noServersText')} />
                ) : shown === 0 ? (
                    filters.state === 'attention' && !filters.query && !filters.reboot && !filters.security
                        ? <EmptyState icon={<HeartPulse className="h-5 w-5" />} title={t('fleet.empty.allGood')} description={t('fleet.empty.allGoodText')} />
                        : (
                            <EmptyState
                                icon={<Search className="h-5 w-5" />}
                                title={t('fleet.empty.noMatch')}
                                actions={<Button size="sm" onClick={() => setFilters(NO_FILTERS)}>{t('fleet.filters.clear')}</Button>}
                            />
                        )
                ) : (
                    <table className={cn('w-full table-fixed border-collapse text-left text-xs', TABLE_WIDTH[layout])} data-layout={layout}>
                        <caption className="sr-only">{t('fleet.title')}</caption>
                        <thead className="sticky top-0 z-10 bg-ink-750 text-[11px] uppercase tracking-wider text-zinc-400">
                            <tr>
                                {columns.map((column, index) => (
                                    <SortHeader key={column.key ?? `static-${index}`} column={column} sort={prefs.sort} direction={prefs.direction} onSort={onSort} />
                                ))}
                            </tr>
                        </thead>
                        {groups.map((group) => {
                            const attention = group.rows.filter((row) => needsAttention(row.state)).length;
                            return (
                                <tbody key={group.key}>
                                    {prefs.group !== 'none' && (
                                        <tr className="border-t border-white/10 bg-white/[0.025]">
                                            <th scope="rowgroup" colSpan={columns.length} className="px-2 py-1.5 text-left text-[11px] font-semibold text-zinc-300">
                                                <span className="normal-case">{group.name ?? (prefs.group === 'tag' ? t('fleet.groups.untagged') : t('fleet.groups.none'))}</span>
                                                <span className="ml-2 font-normal text-zinc-400">
                                                    {group.rows.length === 1 ? t('fleet.groups.countOne') : t('fleet.groups.count', { count: group.rows.length })}
                                                    {attention > 0 && <> · <span className="text-amber-300">{t('fleet.filters.attention')}: {attention}</span></>}
                                                </span>
                                            </th>
                                        </tr>
                                    )}
                                    {group.rows.map((row) => (
                                        <FleetTableRow
                                            key={`${group.key}-${row.server.id}`}
                                            row={row}
                                            settings={settings}
                                            now={now}
                                            actions={actions}
                                            names={names}
                                            layout={layout}
                                            metricColumns={metricColumns}
                                        />
                                    ))}
                                </tbody>
                            );
                        })}
                    </table>
                )}
            </div>

            {/* The connection of a server on hold (or of its jump host), fixed without opening it. */}
            {editing && (
                <LazyDialog onClose={() => setEditing(null)}>
                    <AddServerModal isOpen onClose={() => setEditing(null)} onSaved={() => void loadServers({ fresh: true })} initialData={editing} servers={servers} />
                </LazyDialog>
            )}
        </Modal>
    );
}
