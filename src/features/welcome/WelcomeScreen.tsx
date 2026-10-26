import { useMemo } from 'react';
import {
    ArrowRight, Columns2, Container, FileCode, HeartPulse, KeyRound, ListChecks, Monitor, PackageCheck, Palette, Plus, Search,
    Stethoscope, TerminalSquare, type LucideIcon
} from 'lucide-react';
import type { ServerSummary } from '@shared/types';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/relativeTime';
import { useLanguage, useT } from '@/i18n';
import { Kbd, Skeleton } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { AttentionCard, FLEET_ACTION_ID } from '@/features/fleet/public';
import { manualOrder, type RecentMap } from '@/features/organization/organize';
import { PATCH_ACTION_ID } from '@/features/patch/public';
import { ServerIcon, serverSubtitle } from '@/features/organization/serverVisuals';
import { useAppStore } from '@/store/appStore';

const MAX_SERVERS = 6;

// Container widths (the panel shares the window with the sidebar and the chat).
// Narrow: each quick action is a row (icon, text, shortcut); wider: a card
// with the icon on top, two or four to a row.
const ACTION_CARD = cn(
    'group grid h-full w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-white/10 bg-ink-850/60 p-3 text-left shadow-soft',
    "[grid-template-areas:'icon_text_extra']",
    '[@container(min-width:26rem)]:grid-cols-[auto_minmax(0,1fr)] [@container(min-width:26rem)]:items-start [@container(min-width:26rem)]:p-4',
    "[@container(min-width:26rem)]:[grid-template-areas:'icon_extra'_'text_text']",
    'transition duration-150 hover:-translate-y-0.5 hover:border-white/20 hover:bg-ink-800 focus-ring motion-reduce:hover:translate-y-0',
    'disabled:pointer-events-none disabled:opacity-50'
);

type QuickAction = {
    id: string;
    icon: LucideIcon;
    // Classes of the icon tile.
    tone: string;
    title: string;
    text: string;
    shortcut?: string;
    disabled?: boolean;
    onClick: () => void;
};

// The release the "What's new" list below describes, which its heading
// names. A build may carry the list before its version is bumped; a test
// fails once the build's release moves past it while the list stays.
export const WHATS_NEW_RELEASE = '1.0';

const WHATS_NEW: Array<{ id: string; icon: LucideIcon }> = [
    { id: 'fleet', icon: HeartPulse },
    { id: 'panes', icon: Columns2 },
    { id: 'containers', icon: Container },
    { id: 'patch', icon: PackageCheck },
    { id: 'rdp', icon: Monitor },
    { id: 'diagnose', icon: Stethoscope },
    { id: 'jobs', icon: ListChecks },
    { id: 'security', icon: KeyRound },
    { id: 'appearance', icon: Palette }
];

// Recently opened servers first (newest first), otherwise the saved order.
export function welcomeServers(servers: ServerSummary[], recent: RecentMap, max = MAX_SERVERS): { recent: boolean; servers: ServerSummary[] } {
    const used = servers.filter((server) => recent[server.id]).sort((a, b) => recent[b.id] - recent[a.id]);
    if (used.length > 0) return { recent: true, servers: used.slice(0, max) };
    return { recent: false, servers: manualOrder(servers).slice(0, max) };
}

export function WelcomeScreen({
    servers, loading, recent, paletteShortcut, onSelectServer, onNewConnection, onImportSshConfig, onOpenLocalShell, onOpenPalette,
    onOpenAppearance
}: {
    servers: ServerSummary[];
    loading: boolean;
    recent: RecentMap;
    paletteShortcut: string;
    onSelectServer: (server: ServerSummary) => void;
    onNewConnection: () => void;
    onImportSshConfig: () => void;
    onOpenLocalShell: () => void;
    onOpenPalette: () => void;
    onOpenAppearance: () => void;
}) {
    const t = useT();
    const language = useLanguage();
    const shown = useMemo(() => welcomeServers(servers, recent), [servers, recent]);
    const now = Date.now();

    const actions: QuickAction[] = [
        { id: 'new', icon: Plus, tone: 'bg-brand-500/15 text-brand-300 ring-brand-500/25', title: t('welcome.newConnection.title'), text: t('welcome.newConnection.text'), onClick: onNewConnection },
        { id: 'import', icon: FileCode, tone: 'bg-sky-500/15 text-sky-300 ring-sky-500/25', title: t('welcome.importSsh.title'), text: t('welcome.importSsh.text'), onClick: onImportSshConfig },
        { id: 'local', icon: TerminalSquare, tone: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/25', title: t('welcome.localShell.title'), text: t('welcome.localShell.text'), disabled: loading, onClick: onOpenLocalShell },
        { id: 'palette', icon: Search, tone: 'bg-violet-500/15 text-violet-300 ring-violet-500/25', title: t('welcome.palette.title'), text: t('welcome.palette.text'), shortcut: paletteShortcut, onClick: onOpenPalette }
    ];

    return (
        <div
            className="absolute inset-0 overflow-y-auto scrollbar-thin"
            style={{ backgroundImage: 'radial-gradient(70% 45% at 50% 0%, rgb(var(--c-brand-500) / 0.09), transparent 70%)' }}
        >
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center gap-9 px-6 py-10 animate-fade-in [container-type:inline-size]">
                {/* Hero */}
                <div className="flex flex-col items-center gap-4 text-center [@container(min-width:30rem)]:flex-row [@container(min-width:30rem)]:text-left">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-400 shadow-glow ring-1 ring-brand-500/25">
                        <Logo className="h-9 w-9" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">{t('welcome.title')}</h1>
                        <p className="mt-1 text-sm text-zinc-400">{t('welcome.subtitle')}</p>
                    </div>
                </div>

                {/* Quick actions */}
                <section aria-labelledby="welcome-actions">
                    <h2 id="welcome-actions" className="sr-only">{t('welcome.actions')}</h2>
                    {/* One row of four, or two rows of two: never three and one. */}
                    <ul className="grid grid-cols-1 gap-3 [@container(min-width:26rem)]:grid-cols-2 [@container(min-width:44rem)]:grid-cols-4">
                        {actions.map((action) => (
                            <li key={action.id}>
                                <button type="button" onClick={action.onClick} disabled={action.disabled} className={ACTION_CARD}>
                                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg ring-1 [grid-area:icon]', action.tone)}>
                                        <action.icon className="h-[18px] w-[18px]" aria-hidden="true" />
                                    </span>
                                    <span className="min-w-0 [grid-area:text]">
                                        <span className="block text-sm font-medium text-zinc-100">{action.title}</span>
                                        <span className="mt-0.5 block text-xs text-zinc-400">{action.text}</span>
                                    </span>
                                    <span className="justify-self-end [grid-area:extra]">
                                        {action.shortcut
                                            ? <Kbd>{action.shortcut}</Kbd>
                                            : <ArrowRight className="h-4 w-4 text-zinc-500 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>

                {/* Servers the fleet health checks found in trouble */}
                <AttentionCard servers={servers} />

                {/* Recent (or saved) connections */}
                {(loading || shown.servers.length > 0) && (
                    <section aria-labelledby="welcome-servers" aria-busy={loading || undefined}>
                        <h2 id="welcome-servers" className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                            {shown.recent ? t('welcome.recent') : t('welcome.connections')}
                        </h2>
                        {loading && shown.servers.length === 0 ? (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2" role="status">
                                <span className="sr-only">{t('welcome.loading')}</span>
                                {[0, 1, 2].map((key) => <Skeleton key={key} className="h-[3.75rem] rounded-xl" />)}
                            </div>
                        ) : (
                            <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
                                {shown.servers.map((server) => {
                                    const subtitle = serverSubtitle(server);
                                    const at = recent[server.id];
                                    return (
                                        <li key={server.id}>
                                            <button
                                                type="button"
                                                onClick={() => onSelectServer(server)}
                                                title={server.name}
                                                className="group flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.05] focus-ring"
                                            >
                                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]">
                                                    <ServerIcon server={server} className="h-[18px] w-[18px]" />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium text-zinc-100">{server.name}</span>
                                                    <span className="block truncate text-xs text-zinc-400">
                                                        {at ? t('welcome.lastOpened', { when: formatRelativeTime(at, now, language) }) : subtitle || t('welcome.notOpened')}
                                                    </span>
                                                </span>
                                                <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                )}

                {/* What's new */}
                <section aria-labelledby="welcome-new" className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
                    <h2 id="welcome-new" className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand-300" aria-hidden="true">{WHATS_NEW_RELEASE}</span>
                        {t('welcome.whatsNew.title', { version: WHATS_NEW_RELEASE })}
                    </h2>
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 gap-y-3">
                        {WHATS_NEW.map(({ id, icon: Icon }) => {
                            const content = (
                                <>
                                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden="true" />
                                    <span className="min-w-0">
                                        <span className="block text-[13px] font-medium text-zinc-200">{t(`welcome.whatsNew.${id}.title`)}</span>
                                        <span className="block text-xs text-zinc-400">{t(`welcome.whatsNew.${id}.text`)}</span>
                                    </span>
                                </>
                            );
                            const action = id === 'fleet' ? FLEET_ACTION_ID : id === 'patch' ? PATCH_ACTION_ID : null;
                            const open = id === 'appearance' ? onOpenAppearance
                                : action ? () => useAppStore.getState().openAction(action)
                                    : null;
                            return (
                                <li key={id}>
                                    {open ? (
                                        <button type="button" onClick={open} className="-m-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-white/[0.04] focus-ring">
                                            {content}
                                        </button>
                                    ) : (
                                        <div className="flex items-start gap-2.5">{content}</div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            </div>
        </div>
    );
}
