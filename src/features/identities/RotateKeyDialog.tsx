import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import type { IdentitySummary } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { ApiError } from '@/lib/api';
import { useT } from '@/i18n';
import { Button, Checkbox, Field, Modal, PasswordInput } from '@/components/ui';
import { rotateKeyStream } from './api';
import { InstallProgress } from './InstallProgress';
import { applyInstallEvent, startRun, summarize, type InstallRun } from './progress';

interface RotateKeyDialogProps {
    identity: IdentitySummary;
    // The servers that use the identity (the new key is installed on them).
    dependents: ServerSummary[];
    onClose: () => void;
    onFinished: () => void;
}

// Key rotation: a new key is installed on every server of the identity and
// checked before it replaces the stored one.
export function RotateKeyDialog({ identity, dependents, onClose, onFinished }: RotateKeyDialogProps) {
    const t = useT();
    const [passphrase, setPassphrase] = useState('');
    // A blank field keeps the current passphrase; this stores the new key without one.
    const [noPassphrase, setNoPassphrase] = useState(false);
    const [force, setForce] = useState(false);
    // Take the previous key out of the servers' authorized_keys afterwards.
    const [removeOld, setRemoveOld] = useState(true);
    const [run, setRun] = useState<InstallRun | null>(null);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);
    const running = run !== null && !run.done;

    useEffect(() => () => controller.current?.abort(), []);

    const start = async () => {
        const abort = new AbortController();
        controller.current = abort;
        setError(null);
        setRun(startRun(dependents.map((server) => ({ serverId: server.id, name: server.name }))));
        try {
            const newPassphrase = noPassphrase ? { passphrase: '' } : passphrase ? { passphrase } : {};
            await rotateKeyStream(identity.id, { ...newPassphrase, force, removeOld }, (event) => setRun((current) => current && applyInstallEvent(current, event)), abort.signal);
            setRun((current) => current && (current.done ? current : { ...current, done: true }));
        } catch (err) {
            if (abort.signal.aborted) {
                setRun((current) => current && { ...current, done: true, cancelled: true });
                return;
            }
            setRun(null);
            setError(err instanceof ApiError && !err.isNetworkError ? err.message : t('identities.errors.backend'));
        } finally {
            onFinished();
        }
    };

    const failed = run ? summarize(run).failed + summarize(run).unverified + summarize(run).cancelled : 0;
    // Servers where the previous key could not be removed: it still signs in there.
    const keptOld = run ? run.rows.filter((row) => row.removal?.status === 'failed').length : 0;

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!running}
            widthClass="max-w-xl"
            icon={<RefreshCw className="h-4 w-4" />}
            title={t('identities.rotate.title', { name: identity.name })}
            description={t('identities.rotate.description')}
            footer={
                running ? (
                    <Button variant="secondary" size="sm" onClick={() => controller.current?.abort()}>{t('identities.install.stop')}</Button>
                ) : run ? (
                    <Button variant="primary" size="sm" onClick={onClose}>{t('identities.install.close')}</Button>
                ) : (
                    <>
                        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
                        <Button variant="primary" size="sm" onClick={() => void start()}>{t('identities.rotate.start')}</Button>
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
                {!run && (
                    <>
                        <p className="text-sm text-zinc-300">
                            {dependents.length > 0
                                ? t(dependents.length === 1 ? 'identities.rotate.steps.one' : 'identities.rotate.steps.other', { count: dependents.length })
                                : t('identities.rotate.noServers')}
                        </p>
                        {dependents.length > 0 && (
                            <p className="text-xs text-zinc-400">{dependents.map((server) => server.name).join(', ')}</p>
                        )}
                        {dependents.length > 0 && (
                            <Checkbox
                                checked={removeOld}
                                onChange={setRemoveOld}
                                label={t('identities.rotate.removeOld')}
                                description={t(removeOld ? 'identities.rotate.removeOldHint' : 'identities.rotate.oldKeyNote')}
                            />
                        )}
                        <Field label={t('identities.rotate.passphrase')} hint={noPassphrase ? undefined : t('identities.rotate.passphraseHint')}>
                            <PasswordInput
                                value={noPassphrase ? '' : passphrase}
                                onChange={(event) => setPassphrase(event.target.value)}
                                placeholder={identity.has_passphrase && !noPassphrase ? t('identities.rotate.keepPassphrase') : t('identities.editor.passphrasePlaceholder')}
                                autoComplete="new-password"
                                disabled={noPassphrase}
                            />
                        </Field>
                        {Boolean(identity.has_passphrase) && (
                            <Checkbox
                                checked={noPassphrase}
                                onChange={setNoPassphrase}
                                label={t('identities.rotate.noPassphrase')}
                                description={t('identities.rotate.noPassphraseHint')}
                            />
                        )}
                        {dependents.length > 0 && (
                            <Checkbox
                                checked={force}
                                onChange={setForce}
                                label={t('identities.rotate.force')}
                                description={t('identities.rotate.forceHint')}
                            />
                        )}
                    </>
                )}
                {run && (
                    <>
                        {run.rows.length > 0 && <InstallProgress run={run} label={t('identities.install.progressLabel')} />}
                        {run.error && <p role="alert" className="text-xs text-rose-300">{run.error}</p>}
                        {run.rotated?.replaced && (
                            <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-100">
                                <CheckCircle className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" />
                                <span>
                                    {t('identities.rotate.replaced')}{' '}
                                    <code className="break-all font-mono text-emerald-50">{run.rotated.fingerprint}</code>
                                </span>
                            </div>
                        )}
                        {run.done && keptOld > 0 && (
                            <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                                <span>{t(keptOld === 1 ? 'identities.rotate.removal.keptOne' : 'identities.rotate.removal.keptOther', { count: keptOld })}</span>
                            </div>
                        )}
                        {run.rotated && !run.rotated.replaced && (
                            <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                                <span>{run.cancelled ? t('identities.rotate.cancelled') : t('identities.rotate.notReplaced', { count: failed })}</span>
                            </div>
                        )}
                        {run.done && !run.rotated && run.cancelled && <p className="text-xs text-zinc-400">{t('identities.rotate.cancelled')}</p>}
                    </>
                )}
            </div>
        </Modal>
    );
}
