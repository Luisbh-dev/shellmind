// Settings > Keychain (W7-S2): identities, the credentials several servers
// share. Rotating a password or a key is one edit (or one rotation that
// installs the new key first); keys can be generated and installed on
// servers; the SSH agent's status is shown above the list.
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Server, Sparkles, Trash2, Upload } from 'lucide-react';
import type { IdentityDependent, IdentitySummary } from '@shared/identities';
import { ApiError } from '@/lib/api';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { Badge, Button, EmptyState, Menu, Spinner, useConfirm, useToast, type MenuItem } from '@/components/ui';
import { loadServers, useServers } from '@/store/servers';
import { identitiesApi } from './api';
import { AgentStatusCard } from './AgentStatusCard';
import { AssignDialog } from './AssignDialog';
import { credentialsOf, keyTypeLabel, serversUsing } from './describe';
import { IdentityEditor } from './IdentityEditor';
import type { KeyMode } from './identityForm';
import { InstallKeyDialog } from './InstallKeyDialog';
import { PublicKey } from './PublicKey';
import { RotateKeyDialog } from './RotateKeyDialog';
import { loadIdentities, upsertIdentity, useIdentities } from './store';

type EditorState = { open: boolean; identity: IdentitySummary | null; mode: KeyMode };

const CREDENTIAL_TONES = { password: 'neutral', key: 'brand', keyFile: 'brand', agent: 'info' } as const;

function IdentityCard({
    identity, serverCount, expanded, onToggleKey, onEdit, onInstall, onAssign, onRotate, onDelete
}: {
    identity: IdentitySummary;
    serverCount: number;
    expanded: boolean;
    onToggleKey: () => void;
    onEdit: () => void;
    onInstall: () => void;
    onAssign: () => void;
    onRotate: () => void;
    onDelete: () => void;
}) {
    const t = useT();
    const hasKey = Boolean(identity.has_private_key || identity.private_key_path);
    const credentials = credentialsOf(identity);
    const menu: MenuItem[] = [
        { id: 'assign', label: t('identities.actions.assign'), icon: <Server className="h-3.5 w-3.5" />, onSelect: onAssign },
        ...(identity.has_private_key ? [{ id: 'rotate', label: t('identities.actions.rotate'), icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: onRotate }] : []),
        { id: 'delete', label: t('identities.actions.delete'), icon: <Trash2 className="h-3.5 w-3.5" />, onSelect: onDelete, danger: true }
    ];

    return (
        <li className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04] text-zinc-300" aria-hidden="true">
                    <KeyRound className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <h4 className="truncate text-sm font-medium text-zinc-100">{identity.name}</h4>
                        {credentials.map((credential) => (
                            <Badge key={credential} tone={CREDENTIAL_TONES[credential]}>
                                {credential === 'key' && identity.key_type
                                    ? t('identities.credentials.keyOfType', { type: keyTypeLabel(identity.key_type) })
                                    : t(`identities.credentials.${credential}`)}
                            </Badge>
                        ))}
                        {credentials.length === 0 && <Badge tone="warning">{t('identities.credentials.none')}</Badge>}
                    </div>
                    <p className="text-xs text-zinc-400">
                        {identity.username
                            ? <>{t('identities.card.user')} <code className="font-mono text-zinc-300">{identity.username}</code></>
                            : t('identities.card.noUser')}
                        <span aria-hidden="true"> · </span>
                        {serverCount === 0
                            ? t('identities.card.unused')
                            : t(serverCount === 1 ? 'identities.card.usedBy.one' : 'identities.card.usedBy.other', { count: serverCount })}
                    </p>
                    {identity.private_key_path && (
                        <p className="truncate text-xs text-zinc-400">
                            {t('identities.card.keyFile')} <code className="font-mono text-zinc-300">{identity.private_key_path}</code>
                        </p>
                    )}
                    {identity.fingerprint && (
                        <button
                            type="button"
                            onClick={onToggleKey}
                            aria-expanded={expanded}
                            className="inline-flex max-w-full items-center gap-1 rounded text-left font-mono text-[11px] text-zinc-400 hover:text-zinc-200 focus-ring"
                        >
                            <span className="truncate">{identity.fingerprint}</span>
                            <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
                            <span className="sr-only">{t(expanded ? 'identities.card.hideKey' : 'identities.card.showKey')}</span>
                        </button>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {hasKey && (
                        <Button size="sm" variant="subtle" onClick={onInstall} aria-label={t('identities.actions.installLabel', { name: identity.name })}>
                            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">{t('identities.actions.install')}</span>
                        </Button>
                    )}
                    <Button size="sm" variant="subtle" onClick={onEdit} aria-label={t('identities.actions.editLabel', { name: identity.name })}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="hidden sm:inline">{t('identities.actions.edit')}</span>
                    </Button>
                    <Menu items={menu} label={t('identities.actions.more', { name: identity.name })} triggerClassName="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                    </Menu>
                </div>
            </div>
            {expanded && identity.public_key && <PublicKey value={identity.public_key} name={identity.name} className="mt-3" />}
        </li>
    );
}

export function KeychainSettings() {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const { identities, status, error } = useIdentities();
    const { servers, status: serversStatus } = useServers();
    const [editor, setEditor] = useState<EditorState>({ open: false, identity: null, mode: 'none' });
    const [installFor, setInstallFor] = useState<IdentitySummary | null>(null);
    // `verified`: servers an install just checked the key signs in to.
    const [assignFor, setAssignFor] = useState<{ identity: IdentitySummary; verified?: number[] } | null>(null);
    const [rotateFor, setRotateFor] = useState<IdentitySummary | null>(null);
    const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
    // From the loaded server list (it follows assignments at once), else the backend's count.
    const counts = useMemo(() => new Map(identities.map((identity) => [
        identity.id,
        serversStatus === 'ready' ? serversUsing(identity.id, servers).length : identity.server_count
    ])), [identities, servers, serversStatus]);

    // After a change (an assignment, a deleted identity): a fresh list.
    const refresh = () => {
        void loadIdentities();
        void loadServers({ fresh: true });
    };

    // Imports (Settings › Data) may have added identities since the last load.
    useEffect(() => {
        void loadIdentities();
    }, []);

    const openEditor = (identity: IdentitySummary | null, mode: KeyMode = 'none') => setEditor({ open: true, identity, mode });

    const remove = async (identity: IdentitySummary) => {
        const ok = await confirm({
            title: t('identities.delete.title'),
            message: t('identities.delete.message', { name: identity.name }),
            confirmLabel: t('identities.delete.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        try {
            await identitiesApi.remove(identity.id);
            toast.success(t('identities.delete.done', { name: identity.name }));
            void loadIdentities();
        } catch (err) {
            if (err instanceof ApiError && err.code === 'IDENTITY_IN_USE') {
                const dependents = Array.isArray(err.details?.dependents) ? err.details.dependents as IdentityDependent[] : [];
                toast.error(t('identities.delete.inUse', { name: identity.name }), dependents.map((server) => server.name).join(', '));
            } else {
                toast.error(t('identities.delete.failed'), err instanceof ApiError && !err.isNetworkError ? err.message : t('identities.errors.backend'));
            }
        }
    };

    const toggleKey = (id: number) => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-md space-y-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">{t('identities.title')}</h3>
                    <p className="text-xs text-zinc-400">{t('identities.description')}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => openEditor(null, 'generate')}>
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> {t('identities.generate')}
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => openEditor(null)}>
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t('identities.new')}
                    </Button>
                </div>
            </div>

            <AgentStatusCard />

            {status === 'loading' && identities.length === 0 && (
                <p role="status" className="flex items-center gap-2 py-6 text-sm text-zinc-400">
                    <Spinner className="h-4 w-4" /> {t('identities.loading')}
                </p>
            )}
            {status === 'error' && (
                <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                    <span className="break-words">{t('identities.loadFailed')} {error}</span>
                    <Button size="sm" variant="ghost" onClick={refresh}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t('identities.retry')}
                    </Button>
                </div>
            )}
            {status === 'ready' && identities.length === 0 && (
                <EmptyState
                    icon={<KeyRound className="h-5 w-5" />}
                    title={t('identities.empty.title')}
                    description={t('identities.empty.description')}
                    className="rounded-xl border border-dashed border-white/10 py-8"
                />
            )}
            {identities.length > 0 && (
                <ul aria-label={t('identities.listLabel')} className="space-y-2">
                    {identities.map((identity) => (
                        <IdentityCard
                            key={identity.id}
                            identity={identity}
                            serverCount={counts.get(identity.id) ?? identity.server_count}
                            expanded={expanded.has(identity.id)}
                            onToggleKey={() => toggleKey(identity.id)}
                            onEdit={() => openEditor(identity)}
                            onInstall={() => setInstallFor(identity)}
                            onAssign={() => setAssignFor({ identity })}
                            onRotate={() => setRotateFor(identity)}
                            onDelete={() => void remove(identity)}
                        />
                    ))}
                </ul>
            )}

            <IdentityEditor
                open={editor.open}
                identity={editor.identity}
                initialMode={editor.mode}
                serverCount={editor.identity ? counts.get(editor.identity.id) ?? 0 : 0}
                onClose={() => setEditor((current) => ({ ...current, open: false }))}
                onSaved={(saved, generated) => {
                    upsertIdentity(saved);
                    setEditor((current) => ({ ...current, open: false }));
                    toast.success(editor.identity ? t('identities.saved', { name: saved.name }) : t('identities.created', { name: saved.name }));
                    if (generated) setExpanded((current) => new Set(current).add(saved.id));
                    refresh();
                }}
            />
            {installFor && (
                <InstallKeyDialog
                    identity={installFor}
                    servers={servers}
                    identities={identities}
                    onClose={() => {
                        setInstallFor(null);
                        refresh();
                    }}
                    onUseIdentity={(serverIds) => {
                        setAssignFor({ identity: installFor, verified: serverIds });
                        setInstallFor(null);
                    }}
                />
            )}
            {assignFor && (
                <AssignDialog
                    identity={assignFor.identity}
                    servers={servers}
                    identities={identities}
                    verified={assignFor.verified}
                    onClose={() => setAssignFor(null)}
                    onSaved={refresh}
                />
            )}
            {rotateFor && (
                <RotateKeyDialog
                    identity={rotateFor}
                    dependents={serversUsing(rotateFor.id, servers)}
                    onClose={() => setRotateFor(null)}
                    onFinished={refresh}
                />
            )}
        </div>
    );
}
