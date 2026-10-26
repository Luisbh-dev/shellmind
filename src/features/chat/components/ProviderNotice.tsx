import { useCallback, useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { create } from 'zustand';
import { useT } from '@/i18n';
import { Trans } from '@/i18n/Trans';
import { LegalLink } from '@/components/LegalLink';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/appStore';

const ACK_KEY = 'shellmind.chat.minimaxNotice';

type ConfigStatus = {
    features?: { minimaxProxy?: { route?: string; baseUrl?: string; apiBaseUrl?: string } };
};

// Where MiniMax requests go: the ShellMind proxy (by default the author's
// service), or MiniMax itself with the user's own key (with the proxy as the
// fallback when MiniMax rejects that key).
export type MiniMaxRoute = { kind: 'proxy' | 'direct'; host: string; proxyHost: string };

const hostOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

function readAck(): string | null {
    try {
        return window.localStorage.getItem(ACK_KEY);
    } catch {
        return null;
    }
}

function writeAck(value: string) {
    try {
        window.localStorage.setItem(ACK_KEY, value);
    } catch {
        // Not persisted: the notice shows again next time.
    }
}

// The version of the notice's content: bumped when it names something new
// that is sent (v2: the evidence attached to a diagnosis), so it shows again.
const NOTICE_VERSION = 'v2';

const ackValue = (route: MiniMaxRoute) => `${NOTICE_VERSION}:${route.kind}:${route.host}`;

// Shared by the chats of every open server: one read of the route for all of
// them (again when the window regains focus), and one acknowledgement.
const useDisclosureStore = create<{ route: MiniMaxRoute | null; acknowledged: string | null }>(() => ({ route: null, acknowledged: null }));

// Chats that show the notice (MiniMax selected) and keep the route current.
let watchers = 0;
let controller: AbortController | null = null;
let readQueued = false;

function readRoute() {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    api.get<ConfigStatus>('/api/config/status', { signal: current.signal })
        .then((status) => {
            const info = status?.features?.minimaxProxy;
            const proxyHost = hostOf(info?.baseUrl);
            if (!proxyHost || controller !== current) return;
            const directHost = hostOf(info?.apiBaseUrl);
            useDisclosureStore.setState({
                route: info?.route === 'direct' && directHost
                    ? { kind: 'direct', host: directHost, proxyHost }
                    : { kind: 'proxy', host: proxyHost, proxyHost }
            });
        })
        .catch(() => undefined);
}

// Several chats asking at once (mounting together, a key saved in Settings)
// read the route once.
function requestRoute() {
    if (readQueued) return;
    readQueued = true;
    queueMicrotask(() => {
        readQueued = false;
        if (watchers > 0) readRoute();
    });
}

function watchRoute(): () => void {
    watchers += 1;
    if (watchers === 1) {
        useDisclosureStore.setState({ acknowledged: readAck() });
        window.addEventListener('focus', requestRoute);
    }
    return () => {
        watchers -= 1;
        if (watchers > 0) return;
        window.removeEventListener('focus', requestRoute);
        controller?.abort();
        controller = null;
        useDisclosureStore.setState({ route: null });
    };
}

// Before the first MiniMax request, the chat says where the data goes.
// Acknowledging it is remembered per route and host, so a new proxy or a
// newly added key shows the notice again. The route is read again whenever
// MiniMax is selected, an API key is saved or removed in Settings, or the
// window regains focus.
export function useMiniMaxDisclosure(active: boolean) {
    const route = useDisclosureStore((state) => state.route);
    const acknowledged = useDisclosureStore((state) => state.acknowledged);
    const configRevision = useAppStore((state) => state.aiConfigRevision);

    useEffect(() => (active ? watchRoute() : undefined), [active]);
    useEffect(() => {
        if (active) requestRoute();
    }, [active, configRevision]);

    const acknowledge = useCallback(() => {
        if (!route) return;
        writeAck(ackValue(route));
        useDisclosureStore.setState({ acknowledged: ackValue(route) });
    }, [route]);

    return { visible: active && route !== null && acknowledged !== ackValue(route), route, acknowledge };
}

export function ProviderNotice({ route, onAcknowledge }: { route: MiniMaxRoute; onAcknowledge: () => void }) {
    const t = useT();
    // No hosts in the text: the legal page describes the proxy.
    const legal = <LegalLink label={t('chat.provider.legalLink')} className="text-sky-50" />;
    return (
        <div role="note" className="mb-2 flex items-start gap-2 rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-[12px] leading-snug text-sky-100">
            <ShieldAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" />
            <p className="min-w-0 flex-1">
                <Trans k={route.kind === 'direct' ? 'chat.provider.direct' : 'chat.provider.proxy'} values={{ legal }} />
            </p>
            <button type="button" onClick={onAcknowledge} className="shrink-0 rounded-md border border-sky-400/30 px-2 py-0.5 text-[11px] font-medium text-sky-100 hover:bg-sky-500/20 focus-ring">
                {t('chat.provider.ack')}
            </button>
        </div>
    );
}
