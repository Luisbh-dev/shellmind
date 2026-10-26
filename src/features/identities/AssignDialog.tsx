import { useMemo, useState } from 'react';
import { AlertTriangle, Server } from 'lucide-react';
import type { IdentitySummary } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { ApiError } from '@/lib/api';
import { useT } from '@/i18n';
import { Button, Checkbox, Modal, useConfirm, useToast } from '@/components/ui';
import { identitiesApi } from './api';
import { hasOwnCredentials, isSshServer, serversUsing } from './describe';
import { ServerPicker } from './ServerPicker';

interface AssignDialogProps {
    identity: IdentitySummary;
    servers: ServerSummary[];
    identities: IdentitySummary[];
    // Servers the identity's key was just checked to sign in to (after an
    // install): preselected, and their own credentials are offered for removal.
    verified?: number[];
    onClose: () => void;
    onSaved: () => void;
}

const names = (servers: ServerSummary[]) => servers.map((server) => server.name).join(', ');

// "Use on servers": which SSH servers connect with the identity. Servers
// unticked here stop using it and sign in with their own credentials only.
// Newly ticked ones can drop their own credentials so the identity's are the
// ones used: offered by default only for servers an install just verified,
// and always confirmed, naming the servers that were not checked.
export function AssignDialog({ identity, servers, identities, verified = [], onClose, onSaved }: AssignDialogProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const sshServers = useMemo(() => servers.filter(isSshServer), [servers]);
    const using = useMemo(() => new Set(serversUsing(identity.id, sshServers).map((server) => server.id)), [identity.id, sshServers]);
    const [selected, setSelected] = useState<Set<number>>(() => new Set([...using, ...verified]));
    const [clearOwn, setClearOwn] = useState(verified.length > 0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toAdd = sshServers.filter((server) => selected.has(server.id) && !using.has(server.id));
    const toRemove = sshServers.filter((server) => !selected.has(server.id) && using.has(server.id));
    const withOwn = toAdd.filter(hasOwnCredentials);
    const unchecked = clearOwn ? withOwn.filter((server) => !verified.includes(server.id)) : [];
    // Unticked servers that only ever signed in with the identity.
    const leftWithout = toRemove.filter((server) => !hasOwnCredentials(server));
    const windowsLosingPassword = clearOwn && !identity.has_password && toAdd.some((server) => server.type === 'windows' && server.has_password);

    const save = async () => {
        if (clearOwn && withOwn.length > 0) {
            const ok = await confirm({
                title: t('identities.assign.confirm.title'),
                message: (
                    <div className="space-y-2">
                        <p>{t('identities.assign.confirm.message', { name: identity.name })}</p>
                        <p className="font-medium text-zinc-100">{names(withOwn)}</p>
                        {unchecked.length > 0 && <p className="text-amber-200">{t('identities.assign.confirm.unchecked', { name: identity.name, servers: names(unchecked) })}</p>}
                    </div>
                ),
                confirmLabel: t('identities.assign.confirm.confirm'),
                tone: 'danger'
            });
            if (!ok) return;
        }
        setSaving(true);
        setError(null);
        try {
            if (toAdd.length) await identitiesApi.assign({ identityId: identity.id, serverIds: toAdd.map((server) => server.id), clearOwnCredentials: clearOwn });
            if (toRemove.length) await identitiesApi.assign({ identityId: null, serverIds: toRemove.map((server) => server.id) });
            toast.success(t('identities.assign.saved', { name: identity.name }));
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof ApiError && !err.isNetworkError ? err.message : t('identities.errors.backend'));
        } finally {
            setSaving(false);
        }
    };

    const warning = (text: string) => (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
            <span className="break-words">{text}</span>
        </p>
    );

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!saving}
            widthClass="max-w-xl"
            icon={<Server className="h-4 w-4" />}
            title={t('identities.assign.title', { name: identity.name })}
            description={t('identities.assign.description')}
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
                    <Button variant="primary" size="sm" loading={saving} disabled={toAdd.length + toRemove.length === 0} onClick={() => void save()}>
                        {t('identities.assign.save')}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                {error && (
                    <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-words">{error}</span>
                    </div>
                )}
                <ServerPicker servers={sshServers} selected={selected} onChange={setSelected} identities={identities} label={t('identities.assign.serversLabel')} disabled={saving} />
                <Checkbox
                    checked={clearOwn}
                    onChange={setClearOwn}
                    disabled={saving}
                    label={t('identities.assign.clearOwn')}
                    description={withOwn.length
                        ? t(withOwn.length === 1 ? 'identities.assign.clearOwnHint.one' : 'identities.assign.clearOwnHint.other', { count: withOwn.length })
                        : t('identities.assign.clearOwnHintNone')}
                />
                {unchecked.length > 0 && warning(t('identities.assign.uncheckedNote', { name: identity.name, servers: names(unchecked) }))}
                {windowsLosingPassword && warning(t('identities.assign.windowsNote'))}
                {leftWithout.length > 0 && warning(t(leftWithout.length === 1 ? 'identities.assign.leftWithout.one' : 'identities.assign.leftWithout.other', { servers: names(leftWithout) }))}
                {(toAdd.length > 0 || toRemove.length > 0) && (
                    <p role="status" className="text-xs text-zinc-400">
                        {[
                            toAdd.length ? t(toAdd.length === 1 ? 'identities.assign.willAdd.one' : 'identities.assign.willAdd.other', { count: toAdd.length }) : null,
                            toRemove.length ? t(toRemove.length === 1 ? 'identities.assign.willRemove.one' : 'identities.assign.willRemove.other', { count: toRemove.length }) : null
                        ].filter(Boolean).join(' · ')}
                    </p>
                )}
            </div>
        </Modal>
    );
}
