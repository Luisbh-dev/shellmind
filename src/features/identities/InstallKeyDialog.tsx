import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import type { IdentitySummary } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { ApiError } from '@/lib/api';
import { useT } from '@/i18n';
import { Button, Modal } from '@/components/ui';
import { installKeyStream } from './api';
import { isSshServer, serversUsing } from './describe';
import { InstallProgress } from './InstallProgress';
import { applyInstallEvent, startRun, verifiedServers, type InstallRun } from './progress';
import { PublicKey } from './PublicKey';
import { ServerPicker } from './ServerPicker';

interface InstallKeyDialogProps {
    identity: IdentitySummary;
    servers: ServerSummary[];
    identities: IdentitySummary[];
    onClose: () => void;
    // Offers moving the servers the key now signs in to onto the identity.
    onUseIdentity: (serverIds: number[]) => void;
}

// "Install public key on servers": pick servers, then follow each one
// (added / already there / signs in with the key alone).
export function InstallKeyDialog({ identity, servers, identities, onClose, onUseIdentity }: InstallKeyDialogProps) {
    const t = useT();
    const sshServers = useMemo(() => servers.filter(isSshServer), [servers]);
    const [selected, setSelected] = useState<Set<number>>(() => new Set(serversUsing(identity.id, sshServers).map((server) => server.id)));
    const [run, setRun] = useState<InstallRun | null>(null);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);
    const running = run !== null && !run.done;

    useEffect(() => () => controller.current?.abort(), []);

    const start = async () => {
        const chosen = sshServers.filter((server) => selected.has(server.id));
        if (chosen.length === 0) return;
        const abort = new AbortController();
        controller.current = abort;
        setError(null);
        setRun(startRun(chosen.map((server) => ({ serverId: server.id, name: server.name }))));
        try {
            await installKeyStream(identity.id, { serverIds: chosen.map((server) => server.id) }, (event) => setRun((current) => current && applyInstallEvent(current, event)), abort.signal);
            setRun((current) => current && (current.done ? current : { ...current, done: true }));
        } catch (err) {
            if (abort.signal.aborted) {
                setRun((current) => current && { ...current, done: true, cancelled: true });
                return;
            }
            setRun(null);
            setError(err instanceof ApiError && !err.isNetworkError ? err.message : t('identities.errors.backend'));
        }
    };

    const newlyUsable = run?.done ? verifiedServers(run).filter((serverId) => sshServers.find((server) => server.id === serverId)?.identity_id !== identity.id) : [];

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!running}
            widthClass="max-w-xl"
            icon={<Upload className="h-4 w-4" />}
            title={t('identities.install.title', { name: identity.name })}
            description={t('identities.install.description')}
            footer={
                running ? (
                    <Button variant="secondary" size="sm" onClick={() => controller.current?.abort()}>{t('identities.install.stop')}</Button>
                ) : run ? (
                    <>
                        {newlyUsable.length > 0 && (
                            <Button variant="secondary" size="sm" onClick={() => onUseIdentity(newlyUsable)}>
                                {t(newlyUsable.length === 1 ? 'identities.install.useIdentity.one' : 'identities.install.useIdentity.other', { name: identity.name, count: newlyUsable.length })}
                            </Button>
                        )}
                        <Button variant="primary" size="sm" onClick={onClose}>{t('identities.install.close')}</Button>
                    </>
                ) : (
                    <>
                        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
                        <Button variant="primary" size="sm" disabled={selected.size === 0} onClick={() => void start()}>
                            {t(selected.size === 1 ? 'identities.install.start.one' : 'identities.install.start.other', { count: selected.size })}
                        </Button>
                    </>
                )
            }
        >
            <div className="space-y-4">
                {error && (
                    <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-words">{error}</span>
                    </div>
                )}
                {identity.public_key && <PublicKey value={identity.public_key} name={identity.name} />}
                {run ? (
                    <>
                        <InstallProgress run={run} label={t('identities.install.progressLabel')} />
                        {run.error && <p role="alert" className="text-xs text-rose-300">{run.error}</p>}
                        {run.done && newlyUsable.length > 0 && <p className="text-xs text-zinc-400">{t('identities.install.useIdentityHint', { name: identity.name })}</p>}
                    </>
                ) : (
                    <ServerPicker
                        servers={sshServers}
                        selected={selected}
                        onChange={setSelected}
                        identities={identities}
                        label={t('identities.install.serversLabel')}
                    />
                )}
            </div>
        </Modal>
    );
}
