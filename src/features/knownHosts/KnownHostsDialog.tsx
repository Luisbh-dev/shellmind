import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Copy, KeyRound, Search, Trash2 } from 'lucide-react';
import { normalizeHost, routeHops, savedJumpRoute } from '@shared/hostRoutes';
import { effectivePort } from '@shared/ports';
import { formatHostPort } from '@shared/tunnels';
import type { KnownHost, ServerSummary } from '@shared/types';
import { Button, IconButton, Modal, Spinner, useConfirm, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { copyText } from '@/lib/clipboard';
import { formatDateTime } from '@/lib/format';
import { useServers } from '@/store/servers';
import { knownHostsApi } from './api';

// `route`: the jump hosts the key was seen through, first hop first ([] when
// the host is reached directly); `label` names the pin with its route.
type Row = KnownHost & { address: string; route: string[]; label: string; servers: string[] };

// Saved SSH servers reached at this host:port through this pin's jump route
// (the same address behind another bastion is another machine).
function serversUsing(host: KnownHost, servers: ServerSummary[]): string[] {
    const byId = new Map(servers.map((server) => [server.id, server]));
    return servers
        .filter((server) => (server.type === 'linux' || server.type === 'windows')
            && normalizeHost(server.ip) === host.host
            && effectivePort(server, 'terminal') === host.port
            && savedJumpRoute(server, (id) => byId.get(id)) === (host.via ?? ''))
        .map((server) => server.name);
}

function matches(row: Row, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [row.address, ...row.route, row.key_type, row.fingerprint, ...row.servers].some((value) => value.toLowerCase().includes(needle));
}

// Every pinned SSH host key, searchable, each one can be forgotten.
export function KnownHostsDialog({ onClose }: GlobalActionProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const searchId = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const [hosts, setHosts] = useState<KnownHost[] | null>(null);
    // Only labels rows with server names: a failure leaves them unlabelled.
    const { servers } = useServers();
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [forgetting, setForgetting] = useState<number | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        knownHostsApi.list({ signal: controller.signal }).then(
            (data) => {
                setHosts(data);
                setError(null);
            },
            (err: unknown) => {
                if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
            }
        );
        return () => controller.abort();
    }, [reloadToken]);

    const rows = useMemo<Row[]>(
        () => (hosts ?? []).map((host) => {
            const address = formatHostPort(host.host, host.port);
            const route = routeHops(host.via);
            const label = route.length ? t('knownHosts.addressVia', { address, route: route.join(' → ') }) : address;
            return { ...host, address, route, label, servers: serversUsing(host, servers) };
        }),
        [hosts, servers, t]
    );
    const visible = rows.filter((row) => matches(row, query));

    const forget = useCallback(async (row: Row) => {
        const ok = await confirm({
            title: t('knownHosts.confirmForget.title'),
            message: t('knownHosts.confirmForget.message', { host: row.label }),
            confirmLabel: t('knownHosts.confirmForget.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        setForgetting(row.id);
        try {
            await knownHostsApi.forget(row.id);
            setHosts((current) => current?.filter((host) => host.id !== row.id) ?? current);
            toast.success(t('knownHosts.forgotten', { host: row.label }));
        } catch (err) {
            toast.error(t('knownHosts.forgetFailed'), err instanceof Error ? err.message : String(err));
        } finally {
            setForgetting(null);
        }
    }, [confirm, t, toast]);

    const copyFingerprint = async (fingerprint: string) => {
        try {
            await copyText(fingerprint);
            toast.success(t('knownHosts.copied'));
        } catch {
            toast.error(t('knownHosts.copyFailed'));
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            widthClass="max-w-3xl"
            icon={<KeyRound className="h-4 w-4" />}
            title={t('knownHosts.title')}
            description={t('knownHosts.description')}
        >
            <div className="space-y-3">
                <div className="flex items-center gap-3">
                    <label htmlFor={searchId} className="sr-only">{t('knownHosts.search')}</label>
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                        <input
                            ref={searchRef}
                            id={searchId}
                            type="search"
                            value={query}
                            placeholder={t('knownHosts.searchPlaceholder')}
                            onChange={(event) => setQuery(event.target.value)}
                            className="w-full rounded-lg border border-white/10 bg-ink-900/70 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-brand-500/70"
                        />
                    </div>
                    {hosts && (
                        <span role="status" className="shrink-0 text-xs text-zinc-500">
                            {t('knownHosts.count', { shown: visible.length, total: rows.length })}
                        </span>
                    )}
                </div>

                {!hosts && !error && (
                    <p className="flex items-center gap-2 py-6 text-sm text-zinc-400">
                        <Spinner className="h-4 w-4" />
                        {t('knownHosts.loading')}
                    </p>
                )}
                {error && (
                    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                        <span>{t('knownHosts.loadFailed')} {error}</span>
                        <Button size="sm" variant="ghost" onClick={() => setReloadToken((token) => token + 1)}>{t('knownHosts.retry')}</Button>
                    </div>
                )}
                {hosts && rows.length === 0 && <p className="py-6 text-center text-sm text-zinc-400">{t('knownHosts.empty')}</p>}
                {hosts && rows.length > 0 && visible.length === 0 && (
                    <p className="py-6 text-center text-sm text-zinc-400">{t('knownHosts.noMatches', { query: query.trim() })}</p>
                )}

                {visible.length > 0 && (
                    <ul aria-label={t('knownHosts.listLabel')} className="max-h-[55vh] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                        {visible.map((row) => (
                            <li key={row.id} className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
                                <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-sm text-zinc-100">{row.address}</span>
                                        {row.route.length > 0 && (
                                            <span className="text-xs text-zinc-400">
                                                {t('knownHosts.via')} <span className="font-mono text-zinc-300">{row.route.join(' → ')}</span>
                                            </span>
                                        )}
                                        <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{row.key_type}</span>
                                    </div>
                                    <code className="block break-all font-mono text-xs text-zinc-300">{row.fingerprint}</code>
                                    <p className="text-[11px] text-zinc-500">
                                        {t('knownHosts.firstSeen', { date: formatDateTime(row.created_at, language) })}
                                        {' · '}
                                        {row.servers.length ? t('knownHosts.usedBy', { servers: row.servers.join(', ') }) : t('knownHosts.notUsed')}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    <IconButton size="sm" label={t('knownHosts.copyFingerprint', { host: row.label })} onClick={() => void copyFingerprint(row.fingerprint)}>
                                        <Copy className="h-3.5 w-3.5" />
                                    </IconButton>
                                    <Button
                                        size="sm"
                                        variant="subtle"
                                        loading={forgetting === row.id}
                                        aria-label={t('knownHosts.forgetLabel', { host: row.label })}
                                        className="text-rose-300 hover:text-rose-200"
                                        onClick={() => void forget(row)}
                                    >
                                        {forgetting !== row.id && <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                        {t('knownHosts.forget')}
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Modal>
    );
}
