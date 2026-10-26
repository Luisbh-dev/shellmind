import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink } from 'lucide-react';
import { buildRdpFileContent, type RdpClientKind, type RdpLaunchInput, type RdpLaunchResult, type RdpSupport } from '@shared/rdp';
import { Button } from '@/components/ui';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { safeFileName, saveText } from '@/lib/download';
import { createLogger } from '@/lib/logger';
import type { WorkspaceServer } from '@/workspace/types';

const log = createLogger('rdp');

type Phase =
    | { kind: 'idle' }
    | { kind: 'launching' }
    | { kind: 'launched'; client: RdpClientKind }
    | { kind: 'error'; message: string };

const LAUNCH_TIMEOUT_MS = 20_000;

// "Open in external client": the operating system's Remote Desktop app on
// the computer running ShellMind (mstsc with the saved credentials, FreeRDP,
// Remmina), one launch per click, or a .rdp file to open anywhere.
export function NativeLaunch({ server, port }: { server: WorkspaceServer; port: number }) {
    const t = useT();
    const [support, setSupport] = useState<RdpSupport | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const launchingRef = useRef(false);
    const serverIdRef = useRef(server.id);

    useEffect(() => {
        serverIdRef.current = server.id;
        setPhase({ kind: 'idle' });
        launchingRef.current = false;
        const controller = new AbortController();
        api.get<{ data: RdpSupport }>('/api/rdp/native', { signal: controller.signal })
            .then(({ data }) => setSupport(data))
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                // The launch itself reports what is wrong.
                log.warn('Could not check for a Remote Desktop client', error);
                setSupport({ supported: true, client: null, platform: '' });
            });
        return () => controller.abort();
    }, [server.id]);

    const launch = async () => {
        if (launchingRef.current) return;
        launchingRef.current = true;
        const serverId = server.id;
        setPhase({ kind: 'launching' });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LAUNCH_TIMEOUT_MS);
        let next: Phase;
        try {
            const body: RdpLaunchInput = { serverId };
            const { data } = await api.post<{ data: RdpLaunchResult }>('/api/rdp/launch', body, { signal: controller.signal });
            next = { kind: 'launched', client: data.client };
        } catch (error) {
            const message = controller.signal.aborted
                ? t('rdp.external.timeout')
                : error instanceof ApiError || error instanceof Error ? error.message : String(error);
            next = { kind: 'error', message };
        } finally {
            clearTimeout(timer);
            launchingRef.current = false;
        }
        if (serverIdRef.current === serverId) setPhase(next);
    };

    const download = () => {
        const content = buildRdpFileContent({ host: server.ip, port, username: server.username, domain: server.domain });
        saveText(`${safeFileName(server.name, 'remote-desktop')}.rdp`, content, 'application/x-rdp');
    };

    const unsupported = support !== null && !support.supported;
    return (
        <div className="space-y-3">
            <div>
                <h3 className="text-sm font-semibold text-zinc-100">{t('rdp.external.title')}</h3>
                <p className="mt-0.5 text-xs text-zinc-400">{t('rdp.external.hint')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
                {support === null ? (
                    <p role="status" className="text-xs text-zinc-400">{t('rdp.external.checking')}</p>
                ) : !unsupported && (
                    <Button size="sm" variant="secondary" loading={phase.kind === 'launching'} onClick={() => void launch()}>
                        {phase.kind !== 'launching' && <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t(phase.kind === 'launching' ? 'rdp.external.opening' : 'rdp.external.open')}
                    </Button>
                )}
                <Button size="sm" variant="ghost" onClick={download}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('rdp.external.download')}
                </Button>
            </div>
            {unsupported && <p role="note" className="text-xs text-amber-300">{t('rdp.external.unsupported', { platform: support.platform })}</p>}
            {phase.kind === 'launched' && (
                <div role="status" className="flex items-start gap-2 text-xs text-emerald-300">
                    <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <p>
                        {t('rdp.external.launched', { client: t(`rdp.external.clients.${phase.client}`), host: server.ip })}{' '}
                        <span className="text-zinc-400">{t(phase.client === 'mstsc' && server.has_password ? 'rdp.external.credentialsNote' : 'rdp.external.promptNote')}</span>
                    </p>
                </div>
            )}
            {phase.kind === 'error' && (
                <p role="alert" className="text-xs text-rose-300">
                    <span className="font-semibold">{t('rdp.external.failed')}: </span>{phase.message}
                </p>
            )}
        </div>
    );
}
