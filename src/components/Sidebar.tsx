import { useMemo, useRef, useState } from "react";
import {
    AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Edit2, FileCode, Moon, MoreHorizontal, Play, Plus, RotateCcw,
    Search, Server as ServerIcon, Settings, Star, StarOff, StickyNote, Sun, Tag, Trash2, X
} from "lucide-react";
import type { ServerSummary } from "@shared/types";
import { cn } from "@/lib/cn";
import { ApiError, api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/relativeTime";
import { useLanguage, useT } from "@/i18n";
import { Trans } from "@/i18n/Trans";
import { useAppStore } from "@/store/appStore";
import { describeOpenWork } from "@/store/openServers";
import type { ServersStatus } from "@/store/servers";
import {
    Button, ContextMenu, EmptyState, IconButton, Kbd, Menu, Skeleton, StatusDot, statusLabel, useConfirm, useToast,
    type ConnState, type MenuItem
} from "@/components/ui";
import { useAppearance } from "@/features/appearance/store";
import { colorStyle } from "@/features/organization/colors";
import {
    allTags, filterServers, groupServers, isFavorite, moveInGroup, SORT_MODES, sortServers, type ServerGroup
} from "@/features/organization/organize";
import { useOrganizationPrefs } from "@/features/organization/prefs";
import { ServerIcon as ServerTypeIcon, serverBadge, serverSubtitle } from "@/features/organization/serverVisuals";
// --- W7-S1 fleet board: health dot ---
import { HealthDot, isStale, stateName, stateReason, useFleetAlerts, useFleetFeed, useFleetStore } from "@/features/fleet/public";
import { needsAttention, type FleetSnapshot } from "@shared/fleet";
import { combineConnState, useRdpStore } from "@/features/rdp/store";

export type { ServersStatus };

interface SidebarProps {
    servers: ServerSummary[];
    status: ServersStatus;
    error?: string | null;
    onRetry: () => void;
    activeServerId?: number;
    // Servers open in the workspace (the active one included).
    openServerIds?: readonly number[];
    onSelectServer: (server: ServerSummary) => void;
    // Closes an open server (the app asks first when that loses work).
    onCloseServer?: (server: ServerSummary) => void;
    onAddServer: () => void;
    onImportSshConfig: () => void;
    onEditServer: (server: ServerSummary) => void;
    onOpenSettings: () => void;
    onServerDeleted: (id: number) => void;
    // New manual order (all ids); the app saves it.
    onReorder: (ids: number[]) => void;
    // Pins or unpins a server at the top; the app saves it.
    onToggleFavorite?: (server: ServerSummary) => void;
    // Display form of the Settings shortcut, shown on the Settings button.
    settingsShortcut: string;
}

const MAX_ROW_TAGS = 3;
const NO_OPEN: readonly number[] = [];

const rowKey = (server: ServerSummary) => `row-${server.id}`;
const groupKey = (group: ServerGroup) => `group-${group.favorites ? "favorites" : group.key || "ungrouped"}`;

export default function Sidebar({
    servers, status, error, onRetry, activeServerId, openServerIds = NO_OPEN, onSelectServer, onCloseServer, onAddServer,
    onImportSshConfig, onEditServer, onOpenSettings, onServerDeleted, onReorder, onToggleFavorite, settingsShortcut
}: SidebarProps) {
    const [query, setQuery] = useState("");
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [contextMenu, setContextMenu] = useState<{ server: ServerSummary; group: ServerGroup; position: number; x: number; y: number } | null>(null);
    // The one list entry Tab reaches (roving tabindex): arrows move it.
    const [rovingId, setRovingId] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const toast = useToast();
    const confirm = useConfirm();
    const t = useT();
    const language = useLanguage();
    const connections = useAppStore((state) => state.connections);
    // --- W7-S1 fleet board: the sidebar is always there, so it keeps the
    // fleet feed (and its alerts) on for the whole session.
    useFleetFeed();
    useFleetAlerts({ toast: (title, description) => toast.warning(title, description) });
    const fleetSnapshots = useFleetStore((state) => state.snapshots);
    const fleetSettings = useFleetStore((state) => state.settings);
    // W7-S6: a row's dot also counts its Remote Desktop session.
    const desktopSessions = useRdpStore((state) => state.sessions);
    const { collapsed, sortMode, recent, toggleGroup, setSortMode } = useOrganizationPrefs();
    const resolvedTheme = useAppearance((state) => state.resolvedTheme);
    const setAppearance = useAppearance((state) => state.setAppearance);

    const tags = useMemo(() => allTags(servers), [servers]);
    const activeTagFilter = tagFilter.filter((tag) => tags.includes(tag));
    const visible = useMemo(
        () => sortServers(filterServers(servers, query, activeTagFilter), sortMode, recent),
        [servers, query, activeTagFilter, sortMode, recent]
    );
    const groups = useMemo(() => groupServers(visible), [visible]);
    const showGroupHeaders = groups.some((group) => group.name !== null || group.favorites);
    const hasNamedGroups = groups.some((group) => group.name !== null);
    const filtering = query.trim() !== "" || activeTagFilter.length > 0;
    const isCollapsedGroup = (group: ServerGroup) => showGroupHeaders && !filtering && collapsed.includes(group.key);

    // The entries the arrow keys move between, in order: group headers (not
    // while searching, when they are disabled) and the rows of open groups.
    const entryIds = groups.flatMap((group) => [
        ...(showGroupHeaders && !filtering ? [groupKey(group)] : []),
        ...(isCollapsedGroup(group) ? [] : group.servers.map(rowKey))
    ]);
    const activeRow = activeServerId === undefined ? undefined : `row-${activeServerId}`;
    const tabStop = rovingId && entryIds.includes(rovingId)
        ? rovingId
        : activeRow && entryIds.includes(activeRow) ? activeRow : entryIds[0];

    const toggleTag = (tag: string) =>
        setTagFilter((current) => (current.includes(tag) ? current.filter((other) => other !== tag) : [...current, tag]));

    const clearFilters = () => {
        setQuery("");
        setTagFilter([]);
    };

    const handleDelete = async (server: ServerSummary) => {
        // An open server's sessions end with it.
        const work = openServerIds.includes(server.id) ? describeOpenWork(server.id) : [];
        const ok = await confirm({
            title: t("sidebar.deleteDialog.title"),
            message: (
                <div className="space-y-2">
                    <p><Trans k="sidebar.deleteDialog.message" values={{ name: <span className="text-zinc-100 font-medium">{server.name}</span> }} /></p>
                    {work.length > 0 && (
                        <>
                            <p>{t("sidebar.deleteDialog.openWork")}</p>
                            <ul className="list-disc space-y-0.5 pl-5">{work.map((item) => <li key={item}>{item}</li>)}</ul>
                        </>
                    )}
                </div>
            ),
            confirmLabel: t("sidebar.deleteDialog.confirm"),
            tone: "danger"
        });
        if (!ok) return;

        try {
            await api.del(`/api/servers/${server.id}`);
            toast.success(t("sidebar.deleted"), server.name);
            onServerDeleted(server.id);
        } catch (err) {
            if (err instanceof ApiError && err.code === "JUMP_HOST_IN_USE") {
                const dependents = Array.isArray(err.details?.dependents) ? err.details.dependents as Array<{ name?: unknown }> : [];
                const names = dependents.map((dependent) => String(dependent.name ?? "")).filter(Boolean).join(", ");
                toast.error(t("sidebar.deleteFailed"), t("sidebar.jumpHostInUse", { names }));
            } else {
                toast.error(t("sidebar.deleteFailed"), err instanceof ApiError ? err.message : undefined);
            }
        }
    };

    const move = (server: ServerSummary, delta: -1 | 1) => {
        const ids = moveInGroup(servers, server.id, delta);
        if (ids) onReorder(ids);
    };

    const navigable = () =>
        Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-roving-id]") ?? [])
            .filter((element) => !element.disabled && !element.closest("[hidden]"));

    // Arrow keys move between rows, like a list; the entry they reach becomes
    // the list's tab stop.
    const onListKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const items = navigable();
        const index = items.indexOf(event.currentTarget);
        const target = event.key === "ArrowDown" ? items[index + 1]
            : event.key === "ArrowUp" ? items[index - 1]
                : event.key === "Home" ? items[0]
                    : event.key === "End" ? items[items.length - 1]
                        : undefined;
        if (!target) return;
        event.preventDefault();
        target.focus();
    };

    // --- W7-S1 fleet board: the health dot of a server that needs attention
    // (a healthy one gets none, so the dots stand out).
    const fleetHealth = (server: ServerSummary): { snapshot: FleetSnapshot; label: string; stale: boolean } | null => {
        const snapshot = fleetSnapshots[server.id];
        if (!snapshot || !needsAttention(snapshot.state)) return null;
        const state = stateName(t, { state: snapshot.state, snapshot });
        const checked = snapshot.checkedAt ? t("fleet.sidebar.checked", { when: formatRelativeTime(snapshot.checkedAt, Date.now(), language) }) : null;
        return {
            snapshot,
            stale: isStale(snapshot, fleetSettings),
            label: [
                t("fleet.sidebar.health", { state }),
                stateReason(t, language, snapshot, 2, (id) => servers.find((other) => other.id === id)?.name),
                checked
            ].filter(Boolean).join(" · ")
        };
    };

    // The name a screen reader announces for a row: the visible text first,
    // in the order it is shown (name, address), then the rest.
    const rowLabel = (server: ServerSummary, connection: ConnState | undefined, open: boolean) => [
        server.name,
        serverSubtitle(server),
        serverBadge(server),
        connection ? statusLabel(connection) : null,
        fleetHealth(server)?.label ?? null,
        open && server.id !== activeServerId ? t("sidebar.openInBackground") : null,
        server.tags?.length ? t("sidebar.rowTags", { tags: server.tags.join(", ") }) : null,
        server.notes ? t("sidebar.rowNotes") : null
    ].filter(Boolean).join(", ");

    // Tooltip: the full name (rows truncate long ones), the OS and when it
    // was last opened here.
    const rowTooltip = (server: ServerSummary, open: boolean) => [
        server.name,
        server.os_detail && server.type !== "local" ? server.os_detail : null,
        open ? t("sidebar.openHint") : null,
        recent[server.id] ? t("sidebar.lastUsed", { when: formatRelativeTime(recent[server.id], Date.now(), language) }) : null,
        server.notes ? `\n${server.notes}` : null
    ].filter(Boolean).join("\n");

    const rowActions = (server: ServerSummary, group: ServerGroup, position: number): MenuItem[] => {
        const canMove = sortMode === "manual";
        const favorite = isFavorite(server);
        return [
            ...(onToggleFavorite ? [{
                id: "favorite",
                label: favorite ? t("sidebar.removeFavorite") : t("sidebar.addFavorite"),
                icon: favorite ? <StarOff className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />,
                onSelect: () => onToggleFavorite(server)
            }] : []),
            {
                id: "up",
                label: t("sidebar.moveUp"),
                icon: <ArrowUp className="h-3.5 w-3.5" />,
                disabled: !canMove || position === 0,
                hint: canMove ? undefined : t("sidebar.manualOnly"),
                onSelect: () => move(server, -1)
            },
            {
                id: "down",
                label: t("sidebar.moveDown"),
                icon: <ArrowDown className="h-3.5 w-3.5" />,
                disabled: !canMove || position === group.servers.length - 1,
                onSelect: () => move(server, 1)
            },
            ...(onCloseServer && openServerIds.includes(server.id) ? [{
                id: "close",
                label: t("sidebar.closeServer"),
                icon: <X className="h-3.5 w-3.5" />,
                onSelect: () => onCloseServer(server)
            }] : []),
            {
                id: "delete",
                label: t("sidebar.delete"),
                icon: <Trash2 className="h-3.5 w-3.5" />,
                danger: true,
                onSelect: () => void handleDelete(server)
            }
        ];
    };

    const openContextMenu = (server: ServerSummary, group: ServerGroup, position: number, x: number, y: number) =>
        setContextMenu({ server, group, position, x, y });

    const renderRow = (server: ServerSummary, group: ServerGroup, position: number) => {
        const isActive = activeServerId === server.id;
        const isOpen = openServerIds.includes(server.id);
        const connection = combineConnState(connections[server.id]?.state, desktopSessions[server.id]?.state);
        const health = fleetHealth(server);
        const accent = colorStyle(server.color);
        const subtitle = serverSubtitle(server);
        const favorite = isFavorite(server);
        const rowTags = server.tags ?? [];
        const id = rowKey(server);
        return (
            <li key={server.id} className="group/row relative">
                {accent && (
                    <span
                        aria-hidden="true"
                        className={cn("absolute left-0 top-2 bottom-2 z-10 w-[3px] rounded-full", accent.className)}
                        style={accent.style}
                    />
                )}
                <button
                    type="button"
                    data-server-row
                    data-roving-id={id}
                    data-open={isOpen || undefined}
                    tabIndex={tabStop === id ? 0 : -1}
                    aria-label={rowLabel(server, connection, isOpen)}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelectServer(server)}
                    onFocus={() => setRovingId(id)}
                    onKeyDown={(event) => {
                        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                            event.preventDefault();
                            const box = event.currentTarget.getBoundingClientRect();
                            openContextMenu(server, group, position, box.left + 24, box.top + box.height / 2);
                            return;
                        }
                        onListKeyDown(event);
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        openContextMenu(server, group, position, event.clientX, event.clientY);
                    }}
                    title={rowTooltip(server, isOpen)}
                    className={cn(
                        "flex w-full min-w-0 items-center gap-2.5 rounded-lg border py-1.5 pl-2 pr-2 text-left transition-colors duration-150 focus-ring",
                        isActive
                            ? "border-brand-500/30 bg-brand-500/10"
                            : isOpen
                                ? "border-transparent bg-white/[0.03] hover:bg-white/[0.05]"
                                : "border-transparent hover:bg-white/[0.04] active:bg-white/[0.06]"
                    )}
                >
                    <span
                        className={cn(
                            "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                            isActive ? "border-brand-500/20 bg-ink-900/60" : "border-white/5 bg-white/[0.035]"
                        )}
                    >
                        <ServerTypeIcon server={server} />
                        {connection && (
                            <StatusDot
                                state={connection}
                                label={statusLabel(connection)}
                                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 ring-2 ring-ink-850"
                            />
                        )}
                        {health && (
                            <HealthDot
                                state={health.snapshot.state}
                                stale={health.stale}
                                label={health.label}
                                className="absolute -right-1 -top-1"
                            />
                        )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="flex min-w-0 items-center gap-1.5">
                            {/* Only the width cuts a name (tags sit below); the tooltip has it whole. */}
                            <span className={cn("truncate text-[13px] font-medium leading-5", isActive ? "text-zinc-50" : "text-zinc-200")}>{server.name}</span>
                            {server.notes && <StickyNote className="h-3 w-3 shrink-0 text-zinc-500" role="img" aria-label={t("sidebar.hasNotes")} />}
                        </span>
                        {subtitle && <span className="truncate font-mono text-[11px] leading-4 text-zinc-400">{subtitle}</span>}
                        {rowTags.length > 0 && (
                            <span className="flex min-w-0 flex-wrap gap-1 pt-1">
                                {rowTags.slice(0, MAX_ROW_TAGS).map((tag) => (
                                    <span key={tag} className="max-w-[7rem] truncate rounded-md bg-white/[0.06] px-1.5 text-[10px] leading-4 text-zinc-300">#{tag}</span>
                                ))}
                                {rowTags.length > MAX_ROW_TAGS && <span className="text-[10px] leading-4 text-zinc-400">+{rowTags.length - MAX_ROW_TAGS}</span>}
                            </span>
                        )}
                    </span>
                    {/* Open in the workspace (its sessions keep running); the close button shows on hover. */}
                    {isOpen && <span aria-hidden="true" data-open-marker className="h-1.5 w-1.5 shrink-0 rounded-full bg-focus" />}
                </button>
                {/* Floats over the row's end while hovered or focused, so it never squeezes the name.
                    Out of the Tab order: Shift+F10 (or the Menu key) on the row offers the same. */}
                <div
                    className={cn(
                        "absolute right-1.5 top-1.5 z-20 flex items-center gap-0.5 rounded-lg border border-white/10 bg-ink-750 p-0.5 shadow-soft",
                        "pointer-events-none opacity-0 transition-opacity duration-150",
                        "group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100"
                    )}
                >
                    {onToggleFavorite && (
                        <IconButton
                            size="sm"
                            variant="ghost"
                            tabIndex={-1}
                            className={cn("h-6 w-6", favorite && "text-amber-400 hover:text-amber-300")}
                            label={favorite ? t("sidebar.removeFavoriteNamed", { name: server.name }) : t("sidebar.addFavoriteNamed", { name: server.name })}
                            tooltip={favorite ? t("sidebar.removeFavorite") : t("sidebar.addFavorite")}
                            aria-pressed={favorite}
                            onClick={() => onToggleFavorite(server)}
                        >
                            <Star className={cn("h-3.5 w-3.5", favorite && "fill-current")} aria-hidden="true" />
                        </IconButton>
                    )}
                    <IconButton
                        size="sm"
                        variant="ghost"
                        tabIndex={-1}
                        className="h-6 w-6"
                        label={t("sidebar.editServer", { name: server.name })}
                        tooltip={t("sidebar.edit")}
                        onClick={() => onEditServer(server)}
                    >
                        <Edit2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </IconButton>
                    <Menu
                        label={t("sidebar.moreActions", { name: server.name })}
                        triggerTabIndex={-1}
                        triggerClassName="inline-flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
                        items={rowActions(server, group, position)}
                    >
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </Menu>
                    {isOpen && onCloseServer && (
                        <IconButton
                            size="sm"
                            variant="ghost"
                            tabIndex={-1}
                            className="h-6 w-6"
                            label={t("sidebar.closeServerNamed", { name: server.name })}
                            tooltip={t("sidebar.closeServer")}
                            onClick={() => onCloseServer(server)}
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                    )}
                </div>
            </li>
        );
    };

    const groupTitle = (group: ServerGroup) =>
        group.favorites ? t("sidebar.favorites") : group.name ?? (hasNamedGroups ? t("sidebar.ungrouped") : t("sidebar.otherConnections"));

    const renderGroup = (group: ServerGroup) => {
        const listId = `server-group-${group.favorites ? "favorites" : group.key || "ungrouped"}`.replace(/[^\w-]/g, "_");
        // A search shows matches even inside collapsed groups.
        const isCollapsed = isCollapsedGroup(group);
        const list = (
            <ul id={listId} className="space-y-0.5" hidden={isCollapsed}>
                {group.servers.map((server, position) => renderRow(server, group, position))}
            </ul>
        );
        if (!showGroupHeaders) return <div key={group.key}>{list}</div>;
        const title = groupTitle(group);
        const id = groupKey(group);
        return (
            <section key={group.key} aria-label={title}>
                <h3>
                    <button
                        type="button"
                        data-group-toggle
                        data-roving-id={id}
                        tabIndex={tabStop === id ? 0 : -1}
                        aria-expanded={!isCollapsed}
                        aria-controls={listId}
                        onClick={() => toggleGroup(group.key)}
                        onFocus={() => setRovingId(id)}
                        onKeyDown={onListKeyDown}
                        disabled={filtering}
                        className="mb-0.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400 transition-colors hover:text-zinc-200 focus-ring disabled:cursor-default"
                    >
                        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-150", !isCollapsed && "rotate-90")} aria-hidden="true" />
                        {group.favorites && <Star className="h-3 w-3 shrink-0 fill-current text-amber-400" aria-hidden="true" />}
                        <span className="min-w-0 flex-1 truncate">{title}</span>
                        <span className="rounded bg-white/[0.05] px-1.5 font-mono text-[10px] font-medium leading-4 text-zinc-400">{group.servers.length}</span>
                    </button>
                </h3>
                {list}
            </section>
        );
    };

    const renderList = () => {
        if (status === "loading" && servers.length === 0) {
            return (
                <div className="space-y-1 px-1 pt-1" role="status" aria-busy="true">
                    <span className="sr-only">{t("sidebar.loading")}</span>
                    {[0, 1, 2, 3].map((key) => (
                        <div key={key} className="flex items-center gap-2.5 px-1 py-1.5" aria-hidden="true">
                            <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                            <div className="min-w-0 flex-1 space-y-1.5">
                                <Skeleton className={cn("h-3", key % 2 ? "w-2/3" : "w-1/2")} />
                                <Skeleton className="h-2.5 w-3/4" />
                            </div>
                        </div>
                    ))}
                </div>
            );
        }
        if (status === "error" && servers.length === 0) {
            return (
                <div role="alert" className="mx-1 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-200">
                    <p className="flex items-start gap-1.5 font-medium">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {t("sidebar.loadFailed")}
                    </p>
                    {error && <p className="mt-1 break-words text-rose-200/80">{error}</p>}
                    <Button size="sm" variant="secondary" className="mt-2.5" onClick={onRetry}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("sidebar.retry")}
                    </Button>
                </div>
            );
        }
        if (servers.length === 0) {
            return (
                <EmptyState
                    size="sm"
                    icon={<ServerIcon className="h-5 w-5" />}
                    title={t("sidebar.empty")}
                    description={t("sidebar.emptyHint")}
                    actions={(
                        <div className="flex flex-col items-center gap-1.5">
                            <Button size="sm" variant="primary" onClick={onAddServer}>
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t("sidebar.addConnection")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={onImportSshConfig}>
                                <FileCode className="h-3.5 w-3.5" aria-hidden="true" /> {t("sidebar.importSshConfig")}
                            </Button>
                        </div>
                    )}
                />
            );
        }
        if (visible.length === 0) {
            return (
                <div role="status">
                    <EmptyState
                        size="sm"
                        icon={<Search className="h-5 w-5" />}
                        title={t("sidebar.noMatches")}
                        actions={<Button size="sm" variant="ghost" onClick={clearFilters}>{t("sidebar.clearFilters")}</Button>}
                    />
                </div>
            );
        }
        return <div className="space-y-3">{groups.map(renderGroup)}</div>;
    };

    const nextTheme = resolvedTheme === "dark" ? "light" : "dark";

    return (
        <nav aria-label={t("sidebar.label")} className="flex h-full min-h-0 flex-col text-zinc-400">
            {/* Search, sort and add */}
            <div className="flex items-center gap-1.5 p-3 pb-2">
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                    <input
                        type="search"
                        placeholder={t("sidebar.filterPlaceholder")}
                        aria-label={t("sidebar.filterLabel")}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            const first = e.key === "ArrowDown" ? navigable()[0] : undefined;
                            if (first) {
                                e.preventDefault();
                                first.focus();
                            }
                        }}
                        className={cn(
                            "h-8 w-full rounded-lg border border-white/10 bg-ink-900/70 pl-8 text-xs text-zinc-200 placeholder:text-zinc-500 outline-none transition-colors hover:border-white/15 focus-field focus:bg-ink-900 [&::-webkit-search-cancel-button]:hidden",
                            // Room for the clear button only while there is something to clear,
                            // so the placeholder fits the narrow sidebar.
                            query ? "pr-7" : "pr-2"
                        )}
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => setQuery("")}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-200 focus-ring"
                            aria-label={t("sidebar.clearFilter")}
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    )}
                </div>
                <Menu
                    label={t("sidebar.sortLabel", { mode: t(`sidebar.sort.${sortMode}`) })}
                    triggerClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100"
                    items={SORT_MODES.map((mode) => ({
                        id: mode,
                        label: t(`sidebar.sort.${mode}`),
                        checked: sortMode === mode,
                        onSelect: () => setSortMode(mode)
                    }))}
                >
                    <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Menu>
                <Menu
                    label={t("sidebar.addMenu")}
                    triggerClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-on-brand shadow-soft transition-colors hover:bg-brand-400"
                    items={[
                        { id: "new", label: t("sidebar.addConnection"), icon: <Plus className="h-3.5 w-3.5" />, onSelect: onAddServer },
                        { id: "import", label: t("sidebar.importSshConfig"), icon: <FileCode className="h-3.5 w-3.5" />, onSelect: onImportSshConfig }
                    ]}
                >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                </Menu>
            </div>

            {/* Tag filter */}
            {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 px-3 pb-2" role="group" aria-label={t("sidebar.tagFilter")}>
                    <Tag className="mr-0.5 h-3 w-3 text-zinc-400" aria-hidden="true" />
                    {tags.map((tag) => {
                        const on = activeTagFilter.includes(tag);
                        return (
                            <button
                                key={tag}
                                type="button"
                                aria-pressed={on}
                                onClick={() => toggleTag(tag)}
                                className={cn(
                                    "max-w-[8rem] truncate rounded-full border px-2 py-px text-[11px] leading-4 transition-colors focus-ring",
                                    on ? "border-brand-500/40 bg-brand-500/15 text-brand-200" : "border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-200"
                                )}
                            >
                                {tag}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* List */}
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
                {renderList()}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-1 border-t border-white/5 p-2">
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-ring"
                >
                    <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-left">{t("sidebar.settings")}</span>
                    <span className="hidden shrink-0 xl:inline-flex" aria-hidden="true">
                        <Kbd>{settingsShortcut}</Kbd>
                    </span>
                </button>
                <IconButton
                    variant="ghost"
                    label={t(`sidebar.theme.${nextTheme}`)}
                    onClick={() => setAppearance({ theme: nextTheme })}
                >
                    {nextTheme === "light" ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
                </IconButton>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    label={t("sidebar.moreActions", { name: contextMenu.server.name })}
                    onClose={() => setContextMenu(null)}
                    items={[
                        {
                            id: "open",
                            label: t("sidebar.open"),
                            icon: <Play className="h-3.5 w-3.5" />,
                            onSelect: () => onSelectServer(contextMenu.server)
                        },
                        {
                            id: "edit",
                            label: t("sidebar.edit"),
                            icon: <Edit2 className="h-3.5 w-3.5" />,
                            onSelect: () => onEditServer(contextMenu.server)
                        },
                        "separator",
                        ...rowActions(contextMenu.server, contextMenu.group, contextMenu.position).flatMap((item): Array<MenuItem | "separator"> =>
                            item.id === "delete" ? ["separator", item] : [item])
                    ]}
                />
            )}
        </nav>
    );
}
