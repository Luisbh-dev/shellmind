import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, FileKey, KeyRound, Lock, Server, Undo2, UserRound } from 'lucide-react';
import type { ServerSummary, ServerType } from '@shared/types';
import { defaultPort } from '@shared/ports';
import { ApiError, api } from '@/lib/api';
import { useT } from '@/i18n';
import {
    Badge, Button, Checkbox, Field, Input, Modal, PasswordInput, SegmentedControl, Select, TagInput, Textarea,
    useConfirm, useToast
} from '@/components/ui';
import { ColorPicker } from '@/features/organization/ColorPicker';
import { allGroups, allTags } from '@/features/organization/organize';
import { TYPE_ICONS } from '@/features/organization/serverVisuals';
import {
    EMPTY_FORM, NO_REMOVALS, buildPayload, formFromServer, hasStored, isSshType, secretsToClear, signsInViaIdentity, validateForm,
    type AuthMethod, type FormErrors, type SecretField, type SecretRemovals, type ServerForm
} from '@/features/organization/serverForm';
import { describeIdentity } from '@/features/identities/describe';
import { loadIdentities, useIdentities } from '@/features/identities/store';

interface AddServerModalProps {
    isOpen: boolean;
    onClose: () => void;
    // The saved server, as the backend answered (created or updated).
    onSaved: (server: ServerSummary, mode: 'create' | 'edit') => void;
    // Edit mode when set.
    initialData?: ServerSummary | null;
    // Saved servers: jump host choices and group / tag suggestions.
    servers: ServerSummary[];
}

const TYPES: ServerType[] = ['linux', 'windows', 'ftp', 's3', 'local'];

// Local CLI presets: each opens the local shell (scoped to the CLI for the
// cloud ones) and optionally runs a context command on connect.
const CLI_PRESETS: { value: string; initial: string }[] = [
    { value: 'shell', initial: '' },
    { value: 'azure', initial: 'az account show --output table' },
    { value: 'aws', initial: 'aws sts get-caller-identity' },
    { value: 'gcloud', initial: 'gcloud config list' },
    { value: 'kubectl', initial: 'kubectl config get-contexts' },
    { value: 'docker', initial: 'docker version' },
    { value: 'custom', initial: '' }
];

type SaveResponse = { data: ServerSummary };

// The form a server is edited from (an empty one for a new server).
const startForm = (server?: ServerSummary | null): ServerForm => (server ? formFromServer(server) : EMPTY_FORM);

export default function AddServerModal({ isOpen, onClose, onSaved, initialData, servers }: AddServerModalProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    // The form holds the server being edited from its first render: filled in
    // by an effect instead, a field changed before that effect ran (the dialog
    // is on screen by then) went back to the saved value.
    const [form, setForm] = useState<ServerForm>(() => startForm(initialData));
    const [removals, setRemovals] = useState<SecretRemovals>(NO_REMOVALS);
    const [errors, setErrors] = useState<FormErrors>({});
    const [serverError, setServerError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const initialForm = useRef<ServerForm>(form);
    // What the form was last started from while open (null while closed).
    const startedFrom = useRef<{ data: ServerSummary | null | undefined } | null>(isOpen ? { data: initialData } : null);
    const formRef = useRef<HTMLFormElement>(null);
    const serverErrorRef = useRef<HTMLDivElement>(null);
    const groupListId = useId();
    const isEdit = Boolean(initialData);
    // W7-S2: saved identities (Settings > Keychain) a server can sign in with.
    const { identities } = useIdentities();

    // A failed save says why where it can be seen: the alert sits at the top
    // of a body that may be scrolled to its end, so it is brought into view
    // and takes the focus (keyboard and screen reader users land on it).
    useEffect(() => {
        if (!serverError) return;
        serverErrorRef.current?.scrollIntoView?.({ block: 'nearest' });
        serverErrorRef.current?.focus({ preventScroll: true });
    }, [serverError]);

    useEffect(() => {
        if (!isOpen) {
            startedFrom.current = null;
            return;
        }
        // Identities added in Settings since the last time.
        void loadIdentities();
        // Opened again, or for another server: it starts over.
        if (startedFrom.current && startedFrom.current.data === initialData) return;
        startedFrom.current = { data: initialData };
        const start = startForm(initialData);
        initialForm.current = start;
        setForm(start);
        setRemovals(NO_REMOVALS);
        setErrors({});
        setServerError(null);
    }, [initialData, isOpen]);

    const set = (patch: Partial<ServerForm>) => setForm((prev) => ({ ...prev, ...patch }));
    const dirty = JSON.stringify(form) !== JSON.stringify(initialForm.current) || Object.values(removals).some(Boolean);

    const { type } = form;
    const ssh = isSshType(type);
    const fieldError = (key: keyof FormErrors) => (errors[key] ? t(errors[key]!) : undefined);
    // A preset saved before they were checked is shown as the error it is.
    const presetKnown = CLI_PRESETS.some((preset) => preset.value === form.cli_preset);

    const requestClose = async () => {
        if (isSaving) return;
        if (dirty) {
            const discard = await confirm({
                title: t('addServer.discard.title'),
                message: t('addServer.discard.message'),
                confirmLabel: t('addServer.discard.confirm'),
                cancelLabel: t('addServer.discard.cancel'),
                tone: 'danger'
            });
            if (!discard) return;
        }
        onClose();
    };

    const jumpOptions = useMemo(() => [
        { value: '', label: t('addServer.jump.none') },
        ...servers
            .filter((server) => isSshType(server.type) && server.id !== initialData?.id && server.jump_server_id !== initialData?.id)
            .map((server) => ({ value: String(server.id), label: server.name, description: server.username ? `${server.username}@${server.ip}` : server.ip }))
    ], [servers, initialData?.id, t]);

    const groups = useMemo(() => allGroups(servers), [servers]);
    const tagSuggestions = useMemo(() => allTags(servers), [servers]);
    const willClear = secretsToClear(form, initialData, removals);

    const identity = identities.find((item) => String(item.id) === form.identity_id) ?? null;
    const viaIdentity = signsInViaIdentity(form);
    const identityOptions = useMemo(() => [
        { value: '', label: t('addServer.identity.own'), description: t('addServer.identity.ownHint') },
        ...identities.map((item) => ({ value: String(item.id), label: item.name, description: describeIdentity(t, item) }))
    ], [identities, t]);

    const save = async (keepSecrets: boolean): Promise<void> => {
        const payload = { ...buildPayload(form, initialData, removals), ...(keepSecrets ? { keep_secrets: true } : {}) };
        try {
            const response = initialData
                ? await api.put<SaveResponse>(`/api/servers/${initialData.id}`, payload)
                : await api.post<SaveResponse>('/api/servers', payload);
            toast.success(isEdit ? t('addServer.updated') : t('addServer.added'), response.data.name);
            onSaved(response.data, isEdit ? 'edit' : 'create');
            onClose();
        } catch (error) {
            if (error instanceof ApiError && error.code === 'SECRETS_RETARGET' && !keepSecrets) {
                const fields = Array.isArray(error.details?.kept) ? error.details.kept as SecretField[] : [];
                const kept = fields.map((field) => t(`addServer.secrets.${field}`)).join(', ');
                const keep = await confirm({
                    title: t('addServer.retarget.title'),
                    message: t('addServer.retarget.message', { secrets: kept }),
                    confirmLabel: t('addServer.retarget.keep'),
                    cancelLabel: t('addServer.retarget.cancel')
                });
                if (keep) return save(true);
                setServerError(t('addServer.retarget.declined'));
                return;
            }
            setServerError(error instanceof ApiError && !error.isNetworkError ? error.message : t('addServer.errors.backend'));
        }
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        // Enter in a field while a save is running.
        if (isSaving) return;
        const found = validateForm(form, initialData, removals);
        setErrors(found);
        setServerError(null);
        if (Object.keys(found).length > 0) {
            // Focus the first invalid control.
            window.setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
            return;
        }
        setIsSaving(true);
        try {
            await save(false);
        } finally {
            setIsSaving(false);
        }
    };

    // "Saved" status of a stored secret, with a way to remove it on save.
    const secretStatus = (field: SecretField) => {
        if (!hasStored(initialData, field)) return null;
        const removing = removals[field];
        return (
            <span className="inline-flex items-center gap-1">
                <Badge tone={removing ? 'danger' : 'success'}>
                    {removing ? t('addServer.secrets.willRemove') : <><Check className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{t('addServer.secrets.saved')}</>}
                </Badge>
                <button
                    type="button"
                    onClick={() => setRemovals((prev) => ({ ...prev, [field]: !prev[field] }))}
                    className="rounded px-1 text-[11px] font-medium text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline focus-ring"
                    aria-label={removing
                        ? t('addServer.secrets.undoRemoveLabel', { secret: t(`addServer.secrets.${field}`) })
                        : t('addServer.secrets.removeLabel', { secret: t(`addServer.secrets.${field}`) })}
                >
                    {removing ? <Undo2 className="inline h-3 w-3" aria-hidden="true" /> : t('addServer.secrets.remove')}
                </button>
            </span>
        );
    };

    const secretPlaceholder = (field: SecretField, fallback: string) =>
        hasStored(initialData, field) && !removals[field] ? t('addServer.secrets.keepPlaceholder') : fallback;

    const portField = (key: 'port' | 'ssh_port', label: string, placeholder: number | null) => (
        <Field label={label} error={fieldError(key)}>
            <Input
                inputMode="numeric"
                value={form[key]}
                onChange={(e) => set({ [key]: e.target.value.replace(/[^\d]/g, '') })}
                placeholder={placeholder === null ? undefined : String(placeholder)}
                maxLength={5}
            />
        </Field>
    );

    const authOptions: { value: AuthMethod; label: string; icon: React.ReactNode }[] = [
        { value: 'password', label: t('addServer.auth.password'), icon: <Lock className="h-3.5 w-3.5" /> },
        { value: 'key', label: t('addServer.auth.key'), icon: <KeyRound className="h-3.5 w-3.5" /> },
        { value: 'keyFile', label: t('addServer.auth.keyFile'), icon: <FileKey className="h-3.5 w-3.5" /> }
    ];

    const preset = CLI_PRESETS.find((p) => p.value === form.cli_preset);

    // A Windows server's password is also its Remote Desktop credential, so
    // it stays (after the key fields) when SSH signs in with a key.
    const passwordField = (
        <Field
            label={type === 'windows' ? t('addServer.fields.windowsPassword') : t('addServer.fields.password')}
            labelExtra={secretStatus('password')}
            hint={type === 'windows' && form.auth !== 'password' ? t('addServer.hints.windowsPasswordWithKey') : undefined}
        >
            <PasswordInput
                value={form.password}
                onChange={(e) => set({ password: e.target.value })}
                placeholder={secretPlaceholder('password', t('addServer.hints.passwordPlaceholder'))}
                autoComplete="new-password"
                disabled={removals.password}
            />
        </Field>
    );

    return (
        <Modal
            open={isOpen}
            onClose={() => void requestClose()}
            title={isEdit ? t('addServer.editTitle') : t('addServer.newTitle')}
            description={isEdit ? t('addServer.editDescription') : t('addServer.newDescription')}
            icon={<Server className="w-4 h-4" />}
            widthClass="max-w-xl"
            dismissible={!isSaving}
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={() => void requestClose()} disabled={isSaving}>{t('common.cancel')}</Button>
                    <Button variant="primary" size="sm" type="submit" form="add-server-form" loading={isSaving}>
                        {isEdit ? t('addServer.saveChanges') : t('addServer.add')}
                    </Button>
                </>
            }
        >
            <form id="add-server-form" ref={formRef} onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-5">
                {serverError && (
                    <div
                        ref={serverErrorRef}
                        role="alert"
                        tabIndex={-1}
                        className="flex scroll-my-2 items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 outline-none focus-visible:shadow-[0_0_0_2px_rgb(var(--c-focus-ring))]"
                    >
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-words">{serverError}</span>
                    </div>
                )}

                <Field group label={t('addServer.typeLabel')} hint={t(`addServer.types.${type}.hint`)}>
                    <SegmentedControl<ServerType>
                        variant="cards"
                        value={type}
                        onChange={(next) => set({ type: next })}
                        options={TYPES.map((value) => {
                            const Icon = TYPE_ICONS[value];
                            return { value, label: t(`addServer.types.${value}.label`), icon: <Icon className="h-5 w-5" />, hint: t(`addServer.types.${value}.hint`) };
                        })}
                    />
                </Field>

                <Field label={t('addServer.fields.name')} required error={fieldError('name')}>
                    <Input
                        required
                        value={form.name}
                        onChange={(e) => set({ name: e.target.value })}
                        placeholder={t(`addServer.namePlaceholder.${type}`)}
                        maxLength={200}
                    />
                </Field>

                {type === 'local' && (
                    <div className="space-y-3.5">
                        <Field
                            label={t('addServer.fields.cliPreset')}
                            hint={presetKnown ? t(`addServer.presets.${form.cli_preset}.note`) : undefined}
                            error={fieldError('cli_preset') ?? (presetKnown ? undefined : t('addServer.errors.unknownPreset'))}
                        >
                            <Select
                                value={form.cli_preset}
                                onChange={(value) => {
                                    const next = CLI_PRESETS.find((p) => p.value === value);
                                    set({
                                        cli_preset: value,
                                        initial_command: next && next.value !== 'custom' ? next.initial : form.initial_command
                                    });
                                }}
                                options={CLI_PRESETS.map((p) => ({
                                    value: p.value,
                                    label: t(`addServer.presets.${p.value}.label`),
                                    description: t(`addServer.presets.${p.value}.note`)
                                }))}
                            />
                        </Field>
                        {form.cli_preset === 'custom' && (
                            <Field label={t('addServer.fields.command')} hint={t('addServer.hints.command')}>
                                <Input value={form.command} onChange={(e) => set({ command: e.target.value })} placeholder="wsl -d Ubuntu" className="font-mono" />
                            </Field>
                        )}
                        <Field label={t('addServer.fields.initialCommand')} hint={t('addServer.hints.initialCommand')}>
                            <Input
                                value={form.initial_command}
                                onChange={(e) => set({ initial_command: e.target.value })}
                                placeholder={preset?.initial || 'az account show'}
                                className="font-mono"
                            />
                        </Field>
                        <Field label={t('addServer.fields.cwd')}>
                            <Input value={form.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder={t('addServer.hints.cwd')} className="font-mono" />
                        </Field>
                    </div>
                )}

                {(ssh || type === 'ftp') && (
                    <div className="space-y-3.5">
                        <div className="grid grid-cols-3 gap-3">
                            <Field className="col-span-2" label={t('addServer.fields.host')} required error={fieldError('ip')}>
                                <Input
                                    required
                                    value={form.ip}
                                    onChange={(e) => set({ ip: e.target.value })}
                                    placeholder="192.168.1.10"
                                    autoCapitalize="off"
                                    spellCheck={false}
                                />
                            </Field>
                            {portField(
                                'port',
                                type === 'windows' ? t('addServer.fields.rdpPort') : type === 'ftp' ? t('addServer.fields.ftpPort') : t('addServer.fields.sshPort'),
                                defaultPort(type, type === 'windows' ? 'rdp' : 'terminal')
                            )}
                        </div>

                        {type === 'windows' && (
                            <div className="grid grid-cols-3 gap-3">
                                <Field className="col-span-2" label={t('addServer.fields.domain')} hint={t('addServer.hints.domain')}>
                                    <Input value={form.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="CORP" autoCapitalize="off" />
                                </Field>
                                {portField('ssh_port', t('addServer.fields.openSshPort'), defaultPort('windows', 'terminal'))}
                            </div>
                        )}

                        {ssh && (identities.length > 0 || form.identity_id) && (
                            <Field label={t('addServer.identity.label')} hint={identity ? undefined : t('addServer.identity.hint')}>
                                <Select value={form.identity_id} onChange={(value) => set({ identity_id: value })} options={identityOptions} />
                            </Field>
                        )}

                        <Field
                            label={t('addServer.fields.username')}
                            required={ssh && !identity}
                            error={fieldError('username')}
                            hint={ssh && identity
                                ? identity.username ? t('addServer.identity.usernameFromIdentity', { username: identity.username }) : t('addServer.identity.usernameDefault')
                                : type === 'windows' ? t('addServer.hints.windowsSsh') : undefined}
                        >
                            <Input
                                required={ssh && !identity}
                                value={form.username}
                                onChange={(e) => set({ username: e.target.value })}
                                placeholder={(ssh && identity?.username) || (type === 'windows' ? 'Administrator' : type === 'ftp' ? 'anonymous' : 'root')}
                                autoCapitalize="off"
                                spellCheck={false}
                            />
                        </Field>

                        {ssh && identity && (
                            <div className="space-y-3 rounded-lg border border-brand-500/20 bg-brand-500/[0.05] p-3">
                                <p className="flex items-start gap-2 text-xs text-zinc-300">
                                    <UserRound className="mt-px h-3.5 w-3.5 shrink-0 text-brand-300" aria-hidden="true" />
                                    <span>
                                        {t('addServer.identity.signsInWith', { name: identity.name })}{' '}
                                        <span className="text-zinc-400">{describeIdentity(t, identity)}</span>
                                    </span>
                                </p>
                                {type === 'windows' && !form.keepOwn && (identity.has_password ? (
                                    <p className="flex items-start gap-2 text-xs text-zinc-400">
                                        <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                        {t('addServer.identity.windowsRdp')}
                                    </p>
                                ) : (
                                    <p className="flex items-start gap-2 text-xs text-amber-200">
                                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                                        {t('addServer.identity.windowsNoRdp')}
                                    </p>
                                ))}
                                <Checkbox
                                    checked={form.keepOwn}
                                    onChange={(keepOwn) => set({ keepOwn })}
                                    label={t('addServer.identity.keepOwn')}
                                    description={t('addServer.identity.keepOwnHint')}
                                />
                            </div>
                        )}

                        {ssh && !viaIdentity && (
                            <Field group label={t('addServer.fields.auth')}>
                                <SegmentedControl<AuthMethod> value={form.auth} onChange={(auth) => set({ auth })} options={authOptions} />
                            </Field>
                        )}

                        {(type === 'ftp' || (ssh && !viaIdentity && form.auth === 'password')) && passwordField}

                        {ssh && !viaIdentity && form.auth === 'key' && (
                            <Field label={t('addServer.fields.privateKey')} labelExtra={secretStatus('privateKey')} error={fieldError('privateKey')}>
                                <Textarea
                                    value={form.privateKey}
                                    onChange={(e) => set({ privateKey: e.target.value })}
                                    placeholder={secretPlaceholder('privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----')}
                                    rows={5}
                                    spellCheck={false}
                                    disabled={removals.privateKey}
                                    className="font-mono text-xs"
                                />
                            </Field>
                        )}

                        {ssh && !viaIdentity && form.auth === 'keyFile' && (
                            <Field label={t('addServer.fields.keyPath')} required error={fieldError('private_key_path')} hint={t('addServer.hints.keyPath')}>
                                <Input
                                    value={form.private_key_path}
                                    onChange={(e) => set({ private_key_path: e.target.value })}
                                    placeholder="~/.ssh/id_ed25519"
                                    className="font-mono"
                                    spellCheck={false}
                                />
                            </Field>
                        )}

                        {ssh && !viaIdentity && form.auth !== 'password' && (
                            <Field label={t('addServer.fields.passphrase')} labelExtra={secretStatus('passphrase')}>
                                <PasswordInput
                                    value={form.passphrase}
                                    onChange={(e) => set({ passphrase: e.target.value })}
                                    placeholder={secretPlaceholder('passphrase', t('addServer.hints.passphrase'))}
                                    autoComplete="off"
                                    disabled={removals.passphrase}
                                />
                            </Field>
                        )}

                        {type === 'windows' && !viaIdentity && form.auth !== 'password' && passwordField}

                        {type === 'ftp' && (
                            <Checkbox
                                checked={form.ftp_secure}
                                onChange={(ftpSecure) => set({ ftp_secure: ftpSecure })}
                                label={t('addServer.fields.ftpSecure')}
                                description={t('addServer.hints.ftpSecure')}
                            />
                        )}

                        {ssh && (
                            <Field label={t('addServer.fields.jumpHost')} hint={t('addServer.hints.jumpHost')}>
                                <Select value={form.jump_server_id} onChange={(value) => set({ jump_server_id: value })} options={jumpOptions} />
                            </Field>
                        )}

                        {ssh && (identity?.use_agent || form.agent_forward) && (
                            <Checkbox
                                checked={form.agent_forward}
                                onChange={(agentForward) => set({ agent_forward: agentForward })}
                                label={t('addServer.agentForward.label')}
                                description={identity?.use_agent ? t('addServer.agentForward.hint') : t('addServer.agentForward.needsAgent')}
                            />
                        )}
                    </div>
                )}

                {type === 's3' && (
                    <div className="space-y-3.5">
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t('addServer.fields.provider')}>
                                <Select
                                    value={form.s3_provider}
                                    onChange={(value) => set({ s3_provider: value })}
                                    options={[
                                        { value: 'aws', label: t('addServer.s3.aws') },
                                        { value: 'other', label: t('addServer.s3.other') }
                                    ]}
                                />
                            </Field>
                            <Field label={t('addServer.fields.bucket')} required error={fieldError('s3_bucket')}>
                                <Input required value={form.s3_bucket} onChange={(e) => set({ s3_bucket: e.target.value })} placeholder="my-backups" spellCheck={false} />
                            </Field>
                        </div>
                        {form.s3_provider === 'aws' ? (
                            <Field label={t('addServer.fields.region')}>
                                <Input value={form.s3_region} onChange={(e) => set({ s3_region: e.target.value })} placeholder="us-east-1" />
                            </Field>
                        ) : (
                            <Field label={t('addServer.fields.endpoint')} required error={fieldError('s3_endpoint')}>
                                <Input required value={form.s3_endpoint} onChange={(e) => set({ s3_endpoint: e.target.value })} placeholder="https://s3.example.com" spellCheck={false} />
                            </Field>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t('addServer.fields.accessKey')} required error={fieldError('s3_access_key')}>
                                <Input required value={form.s3_access_key} onChange={(e) => set({ s3_access_key: e.target.value })} placeholder="AKIA..." spellCheck={false} />
                            </Field>
                            <Field label={t('addServer.fields.secretKey')} labelExtra={secretStatus('s3_secret_key')} error={fieldError('s3_secret_key')}>
                                <PasswordInput
                                    value={form.s3_secret_key}
                                    onChange={(e) => set({ s3_secret_key: e.target.value })}
                                    placeholder={secretPlaceholder('s3_secret_key', t('addServer.hints.s3SecretPlaceholder'))}
                                    autoComplete="off"
                                    disabled={removals.s3_secret_key}
                                />
                            </Field>
                        </div>
                    </div>
                )}

                {isEdit && willClear.length > 0 && (
                    <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {t('addServer.secrets.clearNotice', { secrets: willClear.map((field) => t(`addServer.secrets.${field}`)).join(', ') })}
                    </p>
                )}

                <fieldset className="space-y-3.5 border-t border-white/5 pt-4">
                    <legend className="mb-1 pr-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">{t('addServer.organization')}</legend>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label={t('addServer.fields.group')}>
                            <Input
                                value={form.group_name}
                                onChange={(e) => set({ group_name: e.target.value })}
                                placeholder={t('addServer.hints.group')}
                                list={groups.length ? groupListId : undefined}
                                maxLength={128}
                            />
                        </Field>
                        <Field group label={t('addServer.fields.color')}>
                            <ColorPicker value={form.color} onChange={(color) => set({ color })} />
                        </Field>
                    </div>
                    {groups.length > 0 && (
                        <datalist id={groupListId}>
                            {groups.map((group) => <option key={group} value={group} />)}
                        </datalist>
                    )}
                    <Field label={t('addServer.fields.tags')} hint={t('addServer.hints.tags')}>
                        <TagInput value={form.tags} onChange={(tags) => set({ tags })} suggestions={tagSuggestions} placeholder="prod, web" />
                    </Field>
                    <Field label={t('addServer.fields.notes')}>
                        <Textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} maxLength={16384} />
                    </Field>
                </fieldset>
            </form>
        </Modal>
    );
}
