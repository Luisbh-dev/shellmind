import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Clock, Database, Edit2, FileCode, KeyRound, Languages, MessageSquare, Monitor, Moon, Palette, PanelsTopLeft, Plus, Search, Settings, Sun, X
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ServerSummary } from '@shared/types';
import Sidebar from '@/components/Sidebar';
import type { SettingsSection } from '@/components/SettingsModal';
import { ApiError, api } from '@/lib/api';
import { lazyWithRetry } from '@/lib/lazy';
import { createLogger } from '@/lib/logger';
import { isDesktopApp } from '@/lib/platform';
import { useViewportWidth } from '@/lib/useElementSize';
import { LANGUAGES, setLanguage, useLanguagePreference, useT, type LanguagePreference } from '@/i18n';
import { ingestTerminalOutput, resetTerminalIssues, useTerminalIssues } from '@/lib/terminalIssues';
import { MAX_OPEN_SERVERS, QUEUED_COMMAND_TTL_MS, useAppStore, type ConnectionInfo } from '@/store/appStore';
import { describeOpenWork, pickEviction } from '@/store/openServers';
import { loadServers, updateServers, useServers } from '@/store/servers';
import { clearTerminalOutput } from '@/store/terminalOutput';
import { getAvailableTabs, getDefaultTab, tabLabelKey } from '@/workspace/registry';
import { useTabAvailability } from '@/workspace/tabAvailability';
import { TERMINAL_TAB_ID, type WorkspaceServer, type WorkspaceTab } from '@/workspace/types';
import { actionRegistry, formatShortcut, isActionAvailable, isMacPlatform } from '@/workspace/actions/registry';
import {
    ErrorBoundary, IconButton, Kbd, LazyDialog, Menu, PanelSkeleton, ResizeHandle, StatusDot, Tabs, hasOpenOverlay, statusLabel, tabDomId,
    tabPanelDomId, useConfirm, usePersistentSize, useToast, type ConnState
} from '@/components/ui';
import { focusableElements } from '@/components/ui/focus';
import { Logo } from '@/components/Logo';
import { useAppearance } from '@/features/appearance/store';
import { THEME_PREFERENCES, type ThemePreference } from '@/features/appearance/model';
import { WelcomeScreen } from '@/features/welcome/WelcomeScreen';
import { CommandPalette } from '@/features/palette/CommandPalette';
import type { PaletteItem } from '@/features/palette/items';
import { buildShortcutGroups } from '@/features/palette/shortcutList';
import { APP_SHORTCUTS, isKeyboardCaptureTarget, isShellKey, isTerminalTarget, matchAppShortcut, tabShortcut } from '@/features/palette/shortcuts';
import { sortServers, withOrder } from '@/features/organization/organize';
import { useOrganizationPrefs } from '@/features/organization/prefs';
import { ServerIcon, TYPE_ICONS, serverSubtitle } from '@/features/organization/serverVisuals';
import { combineConnState, useRdpSessionState } from '@/features/rdp/store';

const log = createLogger('app');

// Loaded on first use, so the app starts without their code (and the chat's
// Markdown renderer); workspace panels and global actions load the same way.
// A failed download is retried, and again on "Reload panel" (src/lib/lazy.tsx).
const Chat = lazyWithRetry(() => import('@/features/chat/ChatPanel'));
const AddServerModal = lazyWithRetry(() => import('@/components/AddServerModal'));
const SettingsModal = lazyWithRetry(() => import('@/components/SettingsModal'));
const SshConfigImport = lazyWithRetry(async () => ({ default: (await import('@/features/organization/SshConfigImport')).SshConfigImport }));

// --- Layout -------------------------------------------------------------------

const SIDEBAR = { initial: 272, min: 220, max: 420 };
const CHAT = { initial: 380, min: 320, max: 640 };
// The workspace keeps at least this much room; the side panels give way.
const MIN_WORKSPACE = 420;
// How often queued commands are checked for expiry.
const QUEUE_SWEEP_MS = 10_000;

const THEME_ICONS: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

// Connection fields whose change needs a reconnect to take effect.
const targetOf = (server: ServerSummary) =>
    JSON.stringify([server.ip, server.type, server.port, server.ssh_port, server.username, server.jump_server_id, server.ftp_secure]);

// The saved row without what changes outside an edit: the OS a session
// detects, the manual order and the favourite flag. Panels reconnect when
// their server object is replaced, so only an edit should replace it.
const editableFields = (server: ServerSummary) => {
    const { os_detail: _osDetail, sort_order: _sortOrder, favorite: _favorite, ...rest } = server;
    return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
};

// Ids of a server's tabs and panels: every open server has its own set.
const panelPrefix = (serverId: number) => `workspace-${serverId}`;

// The keyboard regions F6 moves between, in order.
const REGIONS = ['sidebar', 'workspace', 'chat-panel'] as const;

// A server's workspace tabs: the one on screen, and every tab opened at least
// once (only those are mounted; they then stay mounted).
type TabState = { current: string; visited: string[] };

// What the header and the chat show for an open server no panel has reported
// a connection for yet: connecting, unless its terminal waits for its tab to
// be opened (a Windows server on its Remote Desktop), which leaves it idle.
function unreportedState(server: WorkspaceServer, state: TabState): ConnState {
    const terminal = getAvailableTabs(server).find((tab) => tab.id === TERMINAL_TAB_ID);
    return terminal && !terminal.mountsWithServer?.(server) && !state.visited.includes(TERMINAL_TAB_ID) ? 'idle' : 'connecting';
}

// The tab strip of the active server. Scrolls when the tabs do not fit, and
// then also offers every tab from a menu.
function WorkspaceTabBar({ tabs, server, current, onSelect }: {
    tabs: WorkspaceTab[];
    server: WorkspaceServer;
    current: string | undefined;
    onSelect: (id: string) => void;
}) {
    const t = useT();
    const stripRef = useRef<HTMLDivElement>(null);
    const [overflowing, setOverflowing] = useState(false);
    const prefix = panelPrefix(server.id);

    // The current tab scrolls into view: when it is picked from the menu or
    // a shortcut, picked again, and whenever the strip changes width (the
    // "All tabs" button appearing narrows it, after the tab was chosen).
    // After layout, so the button is already there.
    const scrollCurrent = useCallback(() => {
        if (!current) return;
        requestAnimationFrame(() => document.getElementById(tabDomId(prefix, current))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    }, [current, prefix]);
    const scrollRef = useRef(scrollCurrent);
    useEffect(() => {
        scrollRef.current = scrollCurrent;
    });

    useEffect(() => {
        const strip = stripRef.current;
        if (!strip || typeof ResizeObserver === 'undefined') return;
        let width = strip.clientWidth;
        const check = () => {
            setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
            if (strip.clientWidth !== width) {
                width = strip.clientWidth;
                scrollRef.current();
            }
        };
        const observer = new ResizeObserver(check);
        observer.observe(strip);
        // The tabs themselves change width with the language.
        if (strip.firstElementChild) observer.observe(strip.firstElementChild);
        check();
        return () => observer.disconnect();
    }, [tabs.length]);

    useEffect(scrollCurrent, [scrollCurrent, overflowing]);

    const items = tabs.map((tab, index) => ({
        id: tab.id,
        label: t(tabLabelKey(tab, server)),
        icon: <tab.icon className="h-4 w-4" />,
        title: index < 9 ? `${t(tabLabelKey(tab, server))} (${formatShortcut(tabShortcut(index))})` : undefined
    }));

    return (
        <div className="flex h-9 shrink-0 items-stretch border-b border-white/5 bg-ink-850/40">
            <div ref={stripRef} className="min-w-0 flex-1 overflow-x-auto scrollbar-hide">
                <Tabs
                    idPrefix={prefix}
                    aria-label={t('app.tabs.label')}
                    variant="bar"
                    className="w-max min-w-full"
                    value={current ?? ''}
                    onChange={(id) => {
                        onSelect(id);
                        if (id === current) scrollCurrent();
                    }}
                    items={items}
                />
            </div>
            {overflowing && (
                <div className="flex shrink-0 items-center border-l border-white/5 px-1">
                    <Menu
                        label={t('app.tabs.all')}
                        triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
                        items={items.map((item) => ({
                            id: item.id,
                            label: item.label,
                            checked: item.id === current,
                            onSelect: () => {
                                onSelect(item.id);
                                if (item.id === current) scrollCurrent();
                            }
                        }))}
                    >
                        <PanelsTopLeft className="h-4 w-4" aria-hidden="true" />
                    </Menu>
                </div>
            )}
        </div>
    );
}

// The panels of one open server. Hidden while another server is on screen:
// its terminals, transfers and editor keep running. A tab's panel mounts the
// first time it is opened (a hidden Files tab opens no file session). The
// `hidden` attribute on background servers and tabs is what window-level key
// handlers inside them check (isOnScreen), so they leave those keys alone.
function ServerPanels({ server, active, tabs, state, onOsDetected }: {
    server: WorkspaceServer;
    active: boolean;
    tabs: WorkspaceTab[];
    state: TabState;
    onOsDetected: (serverId: number, os: string) => void;
}) {
    const t = useT();
    const prefix = panelPrefix(server.id);
    const serverId = server.id;
    // Per server: a background terminal's output never feeds another
    // server's issue detection.
    const handleOsDetected = useCallback((os: string) => onOsDetected(serverId, os), [onOsDetected, serverId]);
    const handleTerminalOutput = useCallback((data: string) => ingestTerminalOutput(serverId, data), [serverId]);

    // Panels that crashed (or whose code did not load) and wait for "Reload
    // panel". When the one reporting the server's connection is among them,
    // nobody reports it: the header, the sidebar and the chat then say the
    // server failed instead of "Connecting" for good.
    const [failures, setFailures] = useState<Record<string, string>>({});
    const failure = Object.values(failures).join(' · ');
    useEffect(() => {
        const store = useAppStore.getState();
        if (!failure || store.connections[serverId]) return undefined;
        const info: ConnectionInfo = { state: 'error', error: failure };
        store.setConnection(serverId, info);
        return () => {
            if (useAppStore.getState().connections[serverId] === info) useAppStore.getState().clearConnection(serverId);
        };
    }, [failure, serverId]);
    const setFailure = (tabId: string, message: string | null) => setFailures((current) => {
        if (message === null && !(tabId in current)) return current;
        const next = { ...current };
        if (message === null) delete next[tabId];
        else next[tabId] = message;
        return next;
    });

    return (
        <div data-server-panels={server.id} hidden={!active} className={clsx('absolute inset-0', active ? 'block' : 'hidden')}>
            {tabs.map((tab) => {
                const isCurrent = tab.id === state.current;
                return (
                    <div
                        key={tab.id}
                        id={tabPanelDomId(prefix, tab.id)}
                        role="tabpanel"
                        aria-labelledby={tabDomId(prefix, tab.id)}
                        tabIndex={-1}
                        hidden={!isCurrent}
                        className={clsx('absolute inset-0 bg-ink-900 outline-none', isCurrent ? 'block' : 'hidden')}
                    >
                        {state.visited.includes(tab.id) && (
                            <ErrorBoundary
                                scope="panel"
                                label={t(tabLabelKey(tab, server))}
                                onError={() => setFailure(tab.id, t('app.errorBoundary.panelTitle', { panel: t(tabLabelKey(tab, server)) }))}
                                onReset={() => setFailure(tab.id, null)}
                            >
                                <Suspense fallback={<PanelSkeleton />}>
                                    <tab.Component
                                        server={server}
                                        isActive={active && isCurrent}
                                        onOsDetected={handleOsDetected}
                                        onTerminalOutput={handleTerminalOutput}
                                    />
                                </Suspense>
                            </ErrorBoundary>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// The AI chat of one open server (or of no server on the welcome screen),
// kept mounted while hidden: an answer in progress, the draft and Auto-Run
// survive switching servers. Its issue card reads that server's terminal.
function ServerChat({ server, active, unreported = 'connecting' }: { server: WorkspaceServer | null; active: boolean; unreported?: ConnState }) {
    const t = useT();
    const serverId = server?.id;
    const terminalState = useAppStore((state) => (serverId == null ? undefined : state.connections[serverId]?.state));
    // W7-S6: the greeting counts a Remote Desktop session; commands still need the terminal.
    const connectionState = combineConnState(terminalState, useRdpSessionState(serverId)) ?? unreported;
    const { terminalIssues, dismissTerminalIssue, clearTerminalIssues } = useTerminalIssues(serverId);
    return (
        <div data-chat-server={serverId ?? 'none'} hidden={!active} className={clsx('min-h-0 min-w-0 flex-1', active ? 'flex flex-col' : 'hidden')}>
            <ErrorBoundary scope="panel" label={t('app.chat.panel')}>
                <Suspense fallback={<PanelSkeleton variant="chat" />}>
                    <Chat
                        activeServer={server}
                        connectionState={connectionState}
                        shellState={terminalState ?? unreported}
                        terminalIssues={terminalIssues}
                        onDismissTerminalIssue={dismissTerminalIssue}
                        onClearTerminalIssues={clearTerminalIssues}
                    />
                </Suspense>
            </ErrorBoundary>
        </div>
    );
}

// The workspace focus target of a region: the active sidebar row, the
// visible panel's first control, the chat's composer.
function focusRegion(region: typeof REGIONS[number]): boolean {
    const root = document.getElementById(region);
    if (!root || root.closest('.hidden')) return false;
    let target: HTMLElement | null | undefined;
    if (region === 'sidebar') {
        target = root.querySelector<HTMLElement>('[data-server-row][tabindex="0"]') ?? focusableElements(root)[0];
    } else if (region === 'chat-panel') {
        target = root.querySelector<HTMLElement>('[data-chat-server]:not(.hidden) textarea') ?? focusableElements(root)[0];
    } else {
        const panel = root.querySelector<HTMLElement>('[data-server-panels]:not(.hidden) [role="tabpanel"]:not(.hidden)');
        target = (panel && (panel.querySelector<HTMLElement>('.xterm textarea') ?? focusableElements(panel)[0] ?? panel))
            ?? focusableElements(root)[0] ?? root;
    }
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
}

function App() {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const languagePreference = useLanguagePreference();
    const themePreference = useAppearance((state) => state.prefs.theme);
    const setAppearance = useAppearance((state) => state.setAppearance);

    const { servers, status: serversStatus, error: serversError } = useServers();
    const openServerIds = useAppStore((state) => state.openServerIds);
    const activeServerId = useAppStore((state) => state.activeServerId);
    const activateServer = useAppStore((state) => state.activateServer);
    const closeServerInStore = useAppStore((state) => state.closeServer);
    const [osDetails, setOsDetails] = useState<Record<number, string>>({});
    const [tabStates, setTabStates] = useState<Record<number, TabState>>({});

    const [editor, setEditor] = useState<{ open: boolean; server: ServerSummary | null }>({ open: false, server: null });
    const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({ open: false, section: 'general' });
    const [sshImportOpen, setSshImportOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);

    const [sidebarWidth, setSidebarWidth, resetSidebarWidth] = usePersistentSize('shellmind.layout.sidebar', SIDEBAR.initial, SIDEBAR.min, SIDEBAR.max);
    const [chatWidth, setChatWidth, resetChatWidth] = usePersistentSize('shellmind.layout.chat', CHAT.initial, CHAT.min, CHAT.max);
    const viewportWidth = useViewportWidth();

    const isChatOpen = useAppStore((state) => state.chatOpen);
    const setChatOpen = useAppStore((state) => state.setChatOpen);
    const discardCommands = useAppStore((state) => state.discardCommands);
    const forgetServer = useAppStore((state) => state.forgetServer);
    const liveConnState = useAppStore((state) =>
        activeServerId == null ? undefined : state.connections[activeServerId]?.state
    );
    const queuedCommandCount = useAppStore((state) =>
        activeServerId == null ? 0 : state.pendingCommands[activeServerId]?.length ?? 0
    );
    // Reported by the server's focused terminal tab, or by its file session
    // when it has no terminal (S3).
    const connState: ConnState = liveConnState ?? 'connecting';
    // W7-S6: what the header shows also counts a Remote Desktop session.
    const activeDesktopState = useRdpSessionState(activeServerId);
    const activeActionId = useAppStore((state) => state.activeActionId);
    const openAction = useAppStore((state) => state.openAction);
    const closeAction = useAppStore((state) => state.closeAction);
    const recent = useOrganizationPrefs((state) => state.recent);
    const markUsed = useOrganizationPrefs((state) => state.markUsed);
    const forgetRecent = useOrganizationPrefs((state) => state.forgetServer);

    // --- Open servers -------------------------------------------------------------

    // The object each open server's panels get: the saved row plus the OS its
    // session detected. It is replaced only by an edit of the row (or a newly
    // detected OS), so a refresh for any other reason leaves the sessions alone.
    const workspaceCache = useRef(new Map<number, { key: string; os?: string; server: WorkspaceServer }>());
    const workspaceServer = useCallback((row: ServerSummary): WorkspaceServer => {
        const key = editableFields(row);
        const os = osDetails[row.id];
        const cached = workspaceCache.current.get(row.id);
        if (cached && cached.key === key && cached.os === os) return cached.server;
        const server: WorkspaceServer = os ? { ...row, os_detail: os, osDetail: os } : { ...row, osDetail: cached?.os };
        workspaceCache.current.set(row.id, { key, os, server });
        return server;
    }, [osDetails]);

    // In a stable order (by id), so switching servers never moves their DOM.
    const openServers = useMemo(() => [...openServerIds].sort((a, b) => a - b)
        .map((id) => servers.find((server) => server.id === id))
        .filter((server): server is ServerSummary => Boolean(server))
        .map(workspaceServer), [openServerIds, servers, workspaceServer]);
    const activeServer = openServers.find((server) => server.id === activeServerId) ?? null;

    // W8-T2: renders again when a tab's availability changes while servers
    // are open (the Kubernetes tab once kubectl has been looked for).
    useTabAvailability();
    const tabsOf = useCallback((server: WorkspaceServer) => getAvailableTabs(server), []);
    // A server opens on its default tab. The panels that mount with the
    // server (mountsWithServer: its terminal, except on Windows) are mounted
    // while it is open, shown or not (an FTP server opens on Files): the
    // terminal reports the server's connection to the header, the sidebar
    // and the chat, and runs the commands queued for the server.
    const tabStateOf = (server: WorkspaceServer): TabState => {
        const known = tabStates[server.id];
        const tabs = tabsOf(server);
        const current = known && tabs.some((tab) => tab.id === known.current) ? known.current : getDefaultTab(server)?.id ?? TERMINAL_TAB_ID;
        const always = [current, ...tabs.filter((tab) => tab.mountsWithServer?.(server)).map((tab) => tab.id)];
        const visited = [...new Set([...(known?.visited ?? []), ...always])];
        return known && known.current === current && visited.length === known.visited.length ? known : { current, visited };
    };

    // Shows `tabId` of the server (mounting its panel if needed).
    const showTab = useCallback((serverId: number, tabId: string, options: { focus?: boolean } = {}) => {
        setTabStates((current) => {
            const known = current[serverId];
            if (known?.current === tabId && known.visited.includes(tabId)) return current;
            const visited = known?.visited.includes(tabId) ? known.visited : [...(known?.visited ?? []), tabId];
            return { ...current, [serverId]: { current: tabId, visited } };
        });
        // A shortcut that switched tabs moves focus to the new panel (the
        // terminal focuses itself when it shows).
        if (options.focus) requestAnimationFrame(() => {
            if (!document.activeElement?.closest('.xterm')) focusRegion('workspace');
        });
    }, []);

    const rememberTabs = useCallback((serverId: number, opened: TabState) => {
        setTabStates((current) => (current[serverId] ? current : { ...current, [serverId]: opened }));
    }, []);

    // Everything kept for a closed server goes with its panels.
    const forgetClosed = (serverId: number) => {
        clearTerminalOutput(serverId);
        resetTerminalIssues(serverId);
        workspaceCache.current.delete(serverId);
        setTabStates((current) => {
            if (!(serverId in current)) return current;
            const next = { ...current };
            delete next[serverId];
            return next;
        });
    };

    const closeServerNow = (serverId: number) => {
        const name = servers.find((server) => server.id === serverId)?.name ?? '';
        const discarded = closeServerInStore(serverId);
        forgetClosed(serverId);
        if (discarded.length) toast.info(t('app.commandQueue.discardedOnClose', { count: discarded.length, name }));
    };

    // Closing ends the server's sessions: asked first when that loses work.
    const confirmClose = async (serverId: number, purpose: 'close' | 'evict', opening?: ServerSummary): Promise<boolean> => {
        const work = describeOpenWork(serverId);
        if (!work.length) return true;
        const name = servers.find((server) => server.id === serverId)?.name ?? '';
        return confirm({
            title: purpose === 'close' ? t('app.openServers.closeTitle', { name }) : t('app.openServers.evictTitle', { name }),
            message: (
                <div className="space-y-2">
                    <p>{purpose === 'close'
                        ? t('app.openServers.closeMessage', { name })
                        : t('app.openServers.evictMessage', { name, opening: opening?.name ?? '', max: MAX_OPEN_SERVERS })}</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                        {work.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                </div>
            ),
            confirmLabel: t('app.openServers.close', { name }),
            tone: 'danger'
        });
    };

    const requestCloseServer = async (serverId: number) => {
        if (!useAppStore.getState().openServerIds.includes(serverId)) return;
        if (await confirmClose(serverId, 'close')) closeServerNow(serverId);
    };

    const handleSelectServer = async (server: ServerSummary) => {
        const { openServerIds: open, activeServerId: active } = useAppStore.getState();
        // The open session stays as it is (re-selecting used to reset it).
        if (server.id === active) return;
        if (!open.includes(server.id)) {
            // Room for one more: the least recently used server without work
            // closes; if all have some, the least recently used one, after asking.
            const eviction = pickEviction(open, server.id);
            if (eviction) {
                if (eviction.work.length && !(await confirmClose(eviction.serverId, 'evict', server))) return;
                closeServerNow(eviction.serverId);
            }
        }
        activateServer(server.id);
        markUsed(server.id);
    };

    // Saved servers that disappeared (deleted elsewhere) close with their panels.
    useEffect(() => {
        if (serversStatus !== 'ready') return;
        for (const id of openServerIds) {
            if (!servers.some((server) => server.id === id)) {
                closeServerInStore(id);
                forgetClosed(id);
            }
        }
    });

    const openEditor = (server: ServerSummary | null) => setEditor({ open: true, server });
    const closeEditor = () => setEditor((current) => ({ ...current, open: false }));

    const handleSaved = async (saved: ServerSummary, mode: 'create' | 'edit') => {
        const before = servers.find((server) => server.id === saved.id);
        await loadServers({ fresh: true });
        const connected = useAppStore.getState().connections[saved.id]?.state === 'connected';
        if (mode === 'edit' && openServerIds.includes(saved.id) && before && targetOf(before) !== targetOf(saved) && connected) {
            toast.info(t('app.reconnectHint'));
        }
    };

    const handleServerDeleted = (id: number) => {
        forgetServer(id);
        forgetClosed(id);
        forgetRecent(id);
        void loadServers({ fresh: true });
    };

    const handleReorder = (ids: number[]) => {
        updateServers((current) => withOrder(current, ids));
        api.post('/api/servers/reorder', { ids }).catch((error: unknown) => {
            toast.error(t('app.reorderFailed'), error instanceof ApiError ? error.message : undefined);
            void loadServers({ fresh: true });
        });
    };

    // Pinned at the top of the sidebar right away; undone if it cannot be saved.
    const handleToggleFavorite = (server: ServerSummary) => {
        const favorite = !server.favorite;
        const setFlag = (value: boolean) =>
            updateServers((current) => current.map((row) => (row.id === server.id ? { ...row, favorite: value ? 1 : 0 } : row)));
        setFlag(favorite);
        api.patch(`/api/servers/${server.id}/favorite`, { favorite }).catch((error: unknown) => {
            setFlag(!favorite);
            toast.error(t('sidebar.favoriteFailed'), error instanceof ApiError ? error.message : undefined);
        });
    };

    // The local shell connection, created (after asking) when there is none.
    const openLocalShell = async () => {
        // Only against the loaded list: otherwise an existing one would be created again.
        // After a failed load the list is fetched again first.
        if (serversStatus === 'loading') return;
        const list = serversStatus === 'ready' ? servers : await loadServers();
        if (!list) {
            toast.error(t('sidebar.loadFailed'), t('welcome.localShell.listFailed'));
            return;
        }
        const existing = list.find((server) => server.type === 'local' && (!server.cli_preset || server.cli_preset === 'shell'));
        if (existing) {
            await handleSelectServer(existing);
            return;
        }
        const name = t('welcome.localShell.name');
        const ok = await confirm({
            title: t('welcome.localShell.confirmTitle'),
            message: t('welcome.localShell.confirmMessage', { name }),
            confirmLabel: t('welcome.localShell.confirm')
        });
        if (!ok) return;
        try {
            const created = await api.post<{ data: ServerSummary }>('/api/servers', { name, type: 'local', ip: 'local', cli_preset: 'shell' });
            await loadServers({ fresh: true });
            if (created?.data) await handleSelectServer(created.data);
        } catch (error) {
            toast.error(t('welcome.localShell.failed'), error instanceof ApiError ? error.message : undefined);
        }
    };

    const handleOsDetected = useCallback((serverId: number, osName: string) => {
        setOsDetails((current) => (current[serverId] === osName ? current : { ...current, [serverId]: osName }));
        updateServers((current) => current.map((server) => (server.id === serverId ? { ...server, os_detail: osName } : server)));
        api.patch(`/api/servers/${serverId}/os`, { os_detail: osName }).catch((error: unknown) => log.warn('Could not save the detected OS', error));
    }, []);

    const openSettings = (section: SettingsSection = 'general') => setSettings({ open: true, section });
    const closeSettings = () => setSettings((current) => ({ ...current, open: false }));

    // --- Workspace --------------------------------------------------------------

    const chatEnabled = activeServer?.type !== 's3';
    const shouldShowChat = chatEnabled && isChatOpen;
    const chatToggleRef = useRef<HTMLButtonElement>(null);

    // Opened from the keyboard or the header, the chat takes the focus (its
    // composer); hidden with the focus inside, the focus goes to its toggle.
    const toggleChat = () => {
        if (!chatEnabled) return;
        if (isChatOpen) {
            const inside = document.getElementById('chat-panel')?.contains(document.activeElement);
            setChatOpen(false);
            if (inside) chatToggleRef.current?.focus();
        } else {
            setChatOpen(true);
            requestAnimationFrame(() => focusRegion('chat-panel'));
        }
    };

    const tabs = activeServer ? tabsOf(activeServer) : [];
    const activeTabState = activeServer ? tabStateOf(activeServer) : null;
    const currentTab = tabs.find((tab) => tab.id === activeTabState?.current);
    const headerConnState: ConnState = combineConnState(liveConnState, activeDesktopState)
        ?? (activeServer && activeTabState ? unreportedState(activeServer, activeTabState) : 'connecting');

    // A server just opened keeps the tabs it opened with (tabStateOf).
    useEffect(() => {
        if (activeServer && !tabStates[activeServer.id]) rememberTabs(activeServer.id, tabStateOf(activeServer));
    });

    // Commands queued for an open server run in its terminal (mounted while
    // the server is open); for the server on screen it comes to the front so
    // their output is visible.
    const pendingServers = useAppStore((state) => Object.keys(state.pendingCommands).map(Number).join(','));
    useEffect(() => {
        if (activeServerId == null || !pendingServers) return;
        if (pendingServers.split(',').map(Number).includes(activeServerId)) showTab(activeServerId, TERMINAL_TAB_ID);
    }, [pendingServers, activeServerId, queuedCommandCount, showTab]);

    // Commands nobody ran within QUEUED_COMMAND_TTL_MS are dropped (and said
    // so): they never run unattended later.
    const serversRef = useRef(servers);
    useEffect(() => {
        serversRef.current = servers;
    });
    useEffect(() => {
        const sweep = () => {
            const expired = useAppStore.getState().expireCommands();
            for (const [id, entries] of Object.entries(expired)) {
                const name = serversRef.current.find((server) => server.id === Number(id))?.name ?? '';
                toast.warning(t('app.commandQueue.expired', { count: entries.length, name, minutes: QUEUED_COMMAND_TTL_MS / 60_000 }));
            }
        };
        const timer = window.setInterval(sweep, QUEUE_SWEEP_MS);
        return () => window.clearInterval(timer);
    }, [toast, t]);

    // So does a terminal tab opened from elsewhere (the palette, Mod+Shift+T);
    // the first tab of a terminal panel that just mounted does not.
    useEffect(() => {
        if (activeServerId == null) return undefined;
        return useAppStore.subscribe((state, previous) => {
            const before = previous.terminalSessions[activeServerId];
            const after = state.terminalSessions[activeServerId];
            if (before && after && after.sessions.length > before.sessions.length) showTab(activeServerId, TERMINAL_TAB_ID);
        });
    }, [activeServerId, showTab]);

    // A tab of a server asked for from elsewhere (requestServerTab: the fleet
    // board, a notification): the server opens as if picked in the sidebar
    // (asking first if that closes one with work), then the tab shows if
    // the server has it.
    const serverTabRequest = useAppStore((state) => state.serverTabRequest);
    const selectServerRef = useRef(handleSelectServer);
    useEffect(() => {
        selectServerRef.current = handleSelectServer;
    });
    useEffect(() => {
        if (!serverTabRequest || !useAppStore.getState().consumeServerTabRequest(serverTabRequest.id)) return;
        const { serverId, tabId } = serverTabRequest;
        const server = serversRef.current.find((item) => item.id === serverId);
        if (!server) return;
        void selectServerRef.current(server).then(() => {
            const shown = useAppStore.getState().activeServerId === serverId;
            if (shown && getAvailableTabs(server).some((tab) => tab.id === tabId)) showTab(serverId, tabId, { focus: true });
        });
    }, [serverTabRequest, showTab]);

    // Global actions (src/workspace/actions): header buttons, keyboard
    // shortcuts and the surface of the open one.
    const headerActions = actionRegistry.header(activeServer);
    const openedAction = activeActionId ? actionRegistry.get(activeActionId) : undefined;
    const activeAction = openedAction && isActionAvailable(openedAction, activeServer) ? openedAction : undefined;

    useEffect(() => {
        if (activeActionId && !activeAction) closeAction();
    }, [activeActionId, activeAction, closeAction]);

    // F6 / Shift+F6: the next or previous region that can take the focus.
    const moveRegion = (direction: 1 | -1) => {
        const current = REGIONS.findIndex((region) => document.getElementById(region)?.contains(document.activeElement));
        for (let step = 1; step <= REGIONS.length; step++) {
            const index = ((current < 0 ? (direction === 1 ? -1 : 0) : current) + step * direction + REGIONS.length * 2) % REGIONS.length;
            if (focusRegion(REGIONS[index])) return;
        }
    };

    // Keyboard shortcuts, in the capture phase so they also work while the
    // terminal has focus; plain Ctrl+letter is left to the shell there.
    // Dialogs block them (except Mod+K closing the palette).
    const shortcutHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
    useEffect(() => {
        shortcutHandler.current = (event: KeyboardEvent) => {
            if (event.repeat || event.isComposing) return;
            // W7-S6: the remote desktop gets every key while it has the focus.
            if (isKeyboardCaptureTarget(event.target)) return;
            const inTerminal = isTerminalTarget(event.target);
            if (inTerminal && isShellKey(event)) return;
            const app = matchAppShortcut(event, undefined, { inTerminal });
            if (app) {
                event.preventDefault();
                event.stopPropagation();
                if (app.command === 'palette') {
                    if (paletteOpen) setPaletteOpen(false);
                    else if (!hasOpenOverlay()) setPaletteOpen(true);
                    return;
                }
                if (hasOpenOverlay()) return;
                if (app.command === 'tab') {
                    if (activeServer && tabs[app.index]) showTab(activeServer.id, tabs[app.index].id, { focus: true });
                } else if (app.command === 'region') {
                    moveRegion(app.direction);
                } else if (app.command === 'toggleChat') {
                    toggleChat();
                } else {
                    openSettings();
                }
                return;
            }
            if (hasOpenOverlay()) return;
            const action = actionRegistry.forShortcut(event, activeServer);
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            openAction(action.id);
        };
    });
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => shortcutHandler.current(event);
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);

    // --- Layout -----------------------------------------------------------------

    // Side panels shrink (chat first) so the workspace keeps MIN_WORKSPACE.
    const room = Math.max(0, viewportWidth - MIN_WORKSPACE);
    const chatSize = shouldShowChat ? Math.max(CHAT.min, Math.min(chatWidth, room - sidebarWidth)) : 0;
    const sidebarSize = Math.max(SIDEBAR.min, Math.min(sidebarWidth, room - chatSize));

    // Toasts sit left of the chat panel.
    useEffect(() => {
        document.documentElement.style.setProperty('--shellmind-toast-right', `${chatSize + 16}px`);
    }, [chatSize]);

    const desktop = isDesktopApp();
    const mac = isMacPlatform();
    const paletteShortcut = formatShortcut(APP_SHORTCUTS.palette);
    const settingsShortcut = formatShortcut(APP_SHORTCUTS.settings);

    // --- Command palette ----------------------------------------------------------

    const LANGUAGE_NAMES: Record<LanguagePreference, string> = { system: t('palette.commands.systemLanguage'), en: 'English', es: 'Español' };
    const paletteItems: PaletteItem[] = [
        ...sortServers(servers, 'recent', recent).map((server): PaletteItem => ({
            id: `server-${server.id}`,
            section: 'servers',
            label: server.name,
            detail: serverSubtitle(server),
            keywords: [server.ip, server.username, server.group_name, ...(server.tags ?? []), server.type, server.os_detail].filter(Boolean).join(' '),
            icon: TYPE_ICONS[server.type],
            iconNode: <ServerIcon server={server} />,
            run: () => void handleSelectServer(server)
        })),
        ...(activeServer ? tabs.map((tab, index): PaletteItem => ({
            id: `tab-${tab.id}`,
            section: 'tabs',
            label: t('palette.goToTab', { tab: t(tabLabelKey(tab, activeServer)) }),
            icon: tab.icon,
            shortcut: index < 9 ? formatShortcut(tabShortcut(index)) : undefined,
            run: () => showTab(activeServer.id, tab.id)
        })) : []),
        ...actionRegistry.available(activeServer).map((action): PaletteItem => ({
            id: `action-${action.id}`,
            section: 'actions',
            label: t(action.labelKey),
            keywords: action.keywords,
            icon: action.icon,
            shortcut: action.shortcut ? formatShortcut(action.shortcut) : undefined,
            run: () => openAction(action.id)
        })),
        { id: 'cmd-new', section: 'commands', label: t('palette.commands.newConnection'), icon: Plus, run: () => openEditor(null) },
        { id: 'cmd-import-ssh', section: 'commands', label: t('palette.commands.importSshConfig'), icon: FileCode, run: () => setSshImportOpen(true) },
        ...(activeServer ? [
            {
                id: 'cmd-edit', section: 'commands' as const, label: t('palette.commands.editActive', { name: activeServer.name }), icon: Edit2,
                run: () => openEditor(servers.find((server) => server.id === activeServer.id) ?? activeServer)
            },
            {
                id: 'cmd-close-server', section: 'commands' as const, label: t('palette.commands.closeActive', { name: activeServer.name }), icon: X,
                keywords: 'close disconnect cerrar desconectar',
                run: () => void requestCloseServer(activeServer.id)
            }
        ] : []),
        ...(chatEnabled ? [{
            id: 'cmd-chat', section: 'commands' as const, label: isChatOpen ? t('palette.commands.hideChat') : t('palette.commands.showChat'),
            icon: MessageSquare, shortcut: formatShortcut(APP_SHORTCUTS.toggleChat), run: toggleChat
        }] : []),
        { id: 'cmd-settings', section: 'commands', label: t('palette.commands.settings'), icon: Settings, shortcut: formatShortcut(APP_SHORTCUTS.settings), run: () => openSettings() },
        { id: 'cmd-data', section: 'commands', label: t('palette.commands.exportImport'), icon: Database, run: () => openSettings('data') },
        { id: 'cmd-appearance', section: 'commands', label: t('palette.commands.appearance'), icon: Palette, run: () => openSettings('appearance') },
        {
            id: 'cmd-keychain', section: 'commands', label: t('palette.commands.keychain'), icon: KeyRound,
            keywords: 'keychain identity identities keys ssh-agent pageant llavero identidad identidades claves',
            run: () => openSettings('keychain')
        },
        ...THEME_PREFERENCES.map((theme): PaletteItem => ({
            id: `cmd-theme-${theme}`,
            section: 'commands',
            label: t('palette.commands.theme', { theme: t(`appearance.theme.${theme}`) }),
            current: theme === themePreference,
            keywords: 'theme tema appearance apariencia light dark claro oscuro',
            icon: THEME_ICONS[theme],
            run: () => setAppearance({ theme })
        })),
        ...(['system', ...LANGUAGES] as LanguagePreference[]).map((language): PaletteItem => ({
            id: `cmd-language-${language}`,
            section: 'commands',
            label: t('palette.commands.language', { language: LANGUAGE_NAMES[language] }),
            current: language === languagePreference,
            keywords: 'language idioma lenguaje',
            icon: Languages,
            run: () => setLanguage(language)
        }))
    ];

    const shortcutGroups = buildShortcutGroups(t, actionRegistry.actions, mac);
    const skipToWorkspace = (event: React.MouseEvent) => {
        event.preventDefault();
        focusRegion('workspace');
    };

    return (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-ink-900 font-sans text-zinc-300">
            <a
                href="#workspace"
                onClick={skipToWorkspace}
                className="sr-only rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-on-brand focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-[90] focus-ring"
            >
                {t('app.skipToWorkspace')}
            </a>

            {/* Title bar: draggable in Electron, with room for the window controls overlay. */}
            <header
                className={clsx(
                    'app-titlebar app-drag flex h-10 shrink-0 items-center gap-3 border-b border-white/5 bg-ink-850',
                    desktop && mac && 'app-titlebar-mac'
                )}
            >
                <div className="flex shrink-0 items-center gap-2 text-zinc-100">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/20" aria-hidden="true">
                        <Logo className="h-3.5 w-3.5" />
                    </div>
                    <span className="text-sm font-semibold tracking-tight">ShellMind</span>
                </div>
                <span className="h-4 w-px shrink-0 bg-white/10" aria-hidden="true" />

                <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                    {activeServer ? (
                        <>
                            <StatusDot state={headerConnState} label={statusLabel(headerConnState)} />
                            <span className="min-w-0 truncate font-medium text-zinc-100" title={activeServer.name}>{activeServer.name}</span>
                            {activeServer.type !== 'local' && activeServer.ip && (
                                <span className="hidden min-w-0 shrink truncate font-mono text-xs text-zinc-400 lg:inline" title={activeServer.ip}>
                                    {activeServer.ip}
                                </span>
                            )}
                            {headerConnState !== 'connected' && (
                                <span
                                    className={clsx(
                                        'shrink-0 text-[11px] font-medium',
                                        headerConnState === 'error' ? 'text-rose-300' : headerConnState === 'connecting' ? 'text-amber-300' : 'text-zinc-400'
                                    )}
                                >
                                    · {statusLabel(headerConnState)}
                                </span>
                            )}
                            {openServerIds.length > 1 && (
                                <span className="hidden shrink-0 rounded-md bg-white/[0.05] px-1.5 text-[11px] text-zinc-400 md:inline" title={t('app.openServers.countHint', { max: MAX_OPEN_SERVERS })}>
                                    {t('app.openServers.count', { count: openServerIds.length })}
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="truncate text-zinc-400">{t('app.noConnection')}</span>
                    )}
                </div>

                {/* Named by its visible text (the placeholder, on narrow windows for screen readers only). */}
                <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    aria-keyshortcuts={mac ? 'Meta+K Meta+Shift+P' : 'Control+K Control+Shift+P'}
                    title={t('app.palette.open')}
                    className="flex h-7 shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2 text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-ring"
                >
                    <Search className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only xl:not-sr-only">{t('app.palette.placeholder')}</span>{' '}
                    <Kbd>{paletteShortcut}</Kbd>
                </button>

                <div className="flex shrink-0 items-center gap-1">
                    {headerActions.map((action) => {
                        const Icon = action.icon;
                        const label = t(action.labelKey);
                        return (
                            <IconButton
                                key={action.id}
                                variant="ghost"
                                label={label}
                                tooltip={action.shortcut ? `${label} (${formatShortcut(action.shortcut)})` : label}
                                className={clsx(activeAction?.id === action.id && 'text-brand-300')}
                                onClick={() => openAction(action.id)}
                            >
                                <Icon className="h-4 w-4" aria-hidden="true" />
                            </IconButton>
                        );
                    })}
                    <IconButton
                        ref={chatToggleRef}
                        variant="ghost"
                        label={t('app.chat.toggle')}
                        tooltip={`${isChatOpen ? t('app.chat.close') : t('app.chat.open')} (${formatShortcut(APP_SHORTCUTS.toggleChat)})`}
                        disabledReason={chatEnabled ? undefined : t('app.chat.disabledS3')}
                        aria-expanded={shouldShowChat}
                        aria-controls="chat-panel"
                        className={clsx(shouldShowChat && 'text-brand-300')}
                        onClick={toggleChat}
                    >
                        <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                </div>
            </header>

            <div className="flex min-h-0 flex-1">
                <aside
                    id="sidebar"
                    aria-label={t('app.sidebar')}
                    style={{ width: sidebarSize }}
                    className="flex min-h-0 shrink-0 bg-ink-850/60"
                >
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <Sidebar
                            servers={servers}
                            status={serversStatus}
                            error={serversError}
                            onRetry={() => void loadServers()}
                            activeServerId={activeServer?.id}
                            openServerIds={openServerIds}
                            onSelectServer={(server) => void handleSelectServer(server)}
                            onCloseServer={(server) => void requestCloseServer(server.id)}
                            onAddServer={() => openEditor(null)}
                            onImportSshConfig={() => setSshImportOpen(true)}
                            onEditServer={openEditor}
                            onOpenSettings={() => openSettings()}
                            onServerDeleted={handleServerDeleted}
                            onReorder={handleReorder}
                            onToggleFavorite={handleToggleFavorite}
                            settingsShortcut={settingsShortcut}
                        />
                    </div>
                    {/* Inside the panel it resizes, so it belongs to a landmark. */}
                    <ResizeHandle
                        panel="before"
                        value={sidebarSize}
                        min={SIDEBAR.min}
                        max={Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, room - chatSize))}
                        onChange={setSidebarWidth}
                        onReset={resetSidebarWidth}
                        label={t('app.resize.sidebar')}
                        controls="sidebar"
                        className="border-r border-white/5"
                    />
                </aside>

                <main id="workspace" tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col bg-ink-900 outline-none">
                    {activeServer && (
                        <WorkspaceTabBar
                            tabs={tabs}
                            server={activeServer}
                            current={currentTab?.id}
                            onSelect={(id) => showTab(activeServer.id, id)}
                        />
                    )}
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                        {/* Every open server keeps its panels; only the active one shows. */}
                        {openServers.map((server) => (
                            <ServerPanels
                                key={server.id}
                                server={server}
                                active={server.id === activeServer?.id}
                                tabs={tabsOf(server)}
                                state={tabStateOf(server)}
                                onOsDetected={handleOsDetected}
                            />
                        ))}

                        {activeServer && queuedCommandCount > 0 && connState !== 'connected' && (
                            <div
                                role="status"
                                className="absolute bottom-4 left-1/2 z-40 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-500/30 bg-ink-800/95 px-3.5 py-2.5 text-xs text-amber-200 shadow-panel backdrop-blur animate-slide-up"
                            >
                                <Clock className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                    {queuedCommandCount === 1
                                        ? t('app.commandQueue.one', { minutes: QUEUED_COMMAND_TTL_MS / 60_000 })
                                        : t('app.commandQueue.many', { count: queuedCommandCount, minutes: QUEUED_COMMAND_TTL_MS / 60_000 })}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => discardCommands(activeServer.id)}
                                    className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 font-medium text-zinc-200 hover:bg-white/5 transition-colors focus-ring"
                                >
                                    {t('app.commandQueue.discard')}
                                </button>
                            </div>
                        )}

                        {!activeServer && (
                            <WelcomeScreen
                                servers={servers}
                                loading={serversStatus === 'loading'}
                                recent={recent}
                                paletteShortcut={paletteShortcut}
                                onSelectServer={(server) => void handleSelectServer(server)}
                                onNewConnection={() => openEditor(null)}
                                onImportSshConfig={() => setSshImportOpen(true)}
                                onOpenLocalShell={() => void openLocalShell()}
                                onOpenPalette={() => setPaletteOpen(true)}
                                onOpenAppearance={() => openSettings('appearance')}
                            />
                        )}
                    </div>
                </main>

                {/* Kept mounted while closed (and for every open server): an answer
                    in progress, the draft and Auto-Run survive. */}
                <aside
                    id="chat-panel"
                    aria-label={t('app.chat.panel')}
                    style={{ width: chatSize || CHAT.min }}
                    className={clsx('min-h-0 shrink-0 bg-ink-850/30', shouldShowChat ? 'flex' : 'hidden')}
                >
                    <ResizeHandle
                        panel="after"
                        value={chatSize}
                        min={CHAT.min}
                        max={Math.max(CHAT.min, Math.min(CHAT.max, room - sidebarSize))}
                        onChange={setChatWidth}
                        onReset={resetChatWidth}
                        label={t('app.resize.chat')}
                        controls="chat-panel"
                        className="border-l border-white/5"
                    />
                    {openServers.filter((server) => server.type !== 's3').map((server) => (
                        <ServerChat key={server.id} server={server} active={server.id === activeServer?.id} unreported={unreportedState(server, tabStateOf(server))} />
                    ))}
                    {!activeServer && <ServerChat key="none" server={null} active />}
                </aside>
            </div>

            {/* Dialogs mount while open (each resets itself when opened). */}
            {editor.open && (
                <LazyDialog onClose={closeEditor}>
                    <AddServerModal
                        isOpen
                        onClose={closeEditor}
                        onSaved={(saved, mode) => void handleSaved(saved, mode)}
                        initialData={editor.server}
                        servers={servers}
                    />
                </LazyDialog>
            )}

            {settings.open && (
                <LazyDialog onClose={closeSettings}>
                    <SettingsModal
                        isOpen
                        initialSection={settings.section}
                        onClose={closeSettings}
                        shortcutGroups={shortcutGroups}
                        onServersImported={() => void loadServers({ fresh: true })}
                        onOpenSshImport={() => setSshImportOpen(true)}
                    />
                </LazyDialog>
            )}

            {sshImportOpen && (
                <LazyDialog onClose={() => setSshImportOpen(false)}>
                    <SshConfigImport
                        open
                        onClose={() => setSshImportOpen(false)}
                        onImported={() => void loadServers({ fresh: true })}
                    />
                </LazyDialog>
            )}

            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />

            {activeAction && (
                <LazyDialog key={activeAction.id} onClose={closeAction}>
                    <activeAction.Component onClose={closeAction} server={activeServer} />
                </LazyDialog>
            )}
            {actionRegistry.backgrounds.map(({ id, Background }) => <Background key={`background-${id}`} />)}
        </div>
    );
}

export default App;
