import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, FileKey, KeyRound, Lock, Sparkles, Undo2, UserRound, X } from 'lucide-react';
import type { IdentitySummary } from '@shared/identities';
import { ApiError } from '@/lib/api';
import { useT } from '@/i18n';
import { Badge, Button, Checkbox, Field, Input, Modal, PasswordInput, SegmentedControl, Textarea, useConfirm } from '@/components/ui';
import { identitiesApi } from './api';
import { keyTypeLabel } from './describe';
import {
    buildIdentityPayload, formFromIdentity, keyModes, usesPassphrase, validateIdentityForm,
    type IdentityForm, type IdentityFormErrors, type KeyMode
} from './identityForm';

interface IdentityEditorProps {
    open: boolean;
    // Edit mode when set.
    identity: IdentitySummary | null;
    // Key mode of a new identity (the "Generate key pair" entry point).
    initialMode?: KeyMode;
    // Servers that use it (edit mode), for the notice.
    serverCount: number;
    onClose: () => void;
    onSaved: (identity: IdentitySummary, generated: boolean) => void;
}

const MODE_ICONS: Record<KeyMode, React.ReactNode> = {
    keep: <Check className="h-3.5 w-3.5" />,
    none: <X className="h-3.5 w-3.5" />,
    generate: <Sparkles className="h-3.5 w-3.5" />,
    paste: <KeyRound className="h-3.5 w-3.5" />,
    file: <FileKey className="h-3.5 w-3.5" />
};

// Create or edit an identity: name, username, password, a key (kept,
// generated, pasted or read from a file) and the SSH agent. Secrets are
// write-only, like a server's: blank keeps the saved one.
export function IdentityEditor({ open, identity, initialMode = 'none', serverCount, onClose, onSaved }: IdentityEditorProps) {
    const t = useT();
    const confirm = useConfirm();
    const [form, setForm] = useState<IdentityForm>(() => formFromIdentity(identity, initialMode));
    const [errors, setErrors] = useState<IdentityFormErrors>({});
    const [serverError, setServerError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const initial = useRef<IdentityForm>(form);
    const formRef = useRef<HTMLFormElement>(null);
    const serverErrorRef = useRef<HTMLDivElement>(null);
    const isEdit = identity !== null;

    useEffect(() => {
        if (!open) return;
        const start = formFromIdentity(identity, initialMode);
        initial.current = start;
        setForm(start);
        setErrors({});
        setServerError(null);
    }, [open, identity, initialMode]);

    const set = (patch: Partial<IdentityForm>) => setForm((current) => ({ ...current, ...patch }));
    const dirty = JSON.stringify(form) !== JSON.stringify(initial.current);
    const fieldError = (key: keyof IdentityFormErrors) => (errors[key] ? t(errors[key] as string) : undefined);

    const requestClose = async () => {
        if (saving) return;
        if (dirty && !(await confirm({
            title: t('identities.editor.discard.title'),
            message: t('identities.editor.discard.message'),
            confirmLabel: t('identities.editor.discard.confirm'),
            cancelLabel: t('identities.editor.discard.cancel'),
            tone: 'danger'
        }))) return;
        onClose();
    };

    // A refused save says why where it can be seen: on the field at fault
    // when it is on screen, else in the alert at the top of the form.
    const focusInvalid = () => window.setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
    useEffect(() => {
        if (serverError) serverErrorRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, [serverError]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (saving) return;
        const found = validateIdentityForm(form);
        setErrors(found);
        setServerError(null);
        if (Object.keys(found).length > 0) {
            focusInvalid();
            return;
        }
        setSaving(true);
        try {
            const payload = buildIdentityPayload(form, identity);
            const saved = identity ? await identitiesApi.update(identity.id, payload) : await identitiesApi.create(payload);
            onSaved(saved, payload.generate_key === true);
        } catch (error) {
            const field = error instanceof ApiError ? (error.details?.field as string | undefined) : undefined;
            if (error instanceof ApiError && error.code === 'IDENTITY_NAME_TAKEN') {
                setErrors({ name: 'identities.editor.errors.nameTaken' });
                focusInvalid();
            } else if (error instanceof ApiError && error.code === 'INVALID_PRIVATE_KEY' && form.keyMode === 'paste') {
                setErrors({ privateKey: 'identities.editor.errors.keyInvalid' });
                focusInvalid();
            } else if (error instanceof ApiError && error.code === 'INVALID_PRIVATE_KEY') {
                // No key field on screen (the key is kept or read from a file).
                setServerError(t('identities.editor.errors.keyInvalid'));
            } else if (field === 'private_key_path') {
                setErrors({ keyPath: 'identities.editor.errors.keyOrFile' });
                focusInvalid();
            } else {
                setServerError(error instanceof ApiError && !error.isNetworkError ? error.message : t('identities.errors.backend'));
            }
        } finally {
            setSaving(false);
        }
    };

    // "Saved · Remove" next to a stored secret's label.
    const savedBadge = (stored: boolean, removing: boolean, toggle: () => void, secret: string) => {
        if (!stored) return null;
        return (
            <span className="inline-flex items-center gap-1">
                <Badge tone={removing ? 'danger' : 'success'}>
                    {removing ? t('identities.editor.willRemove') : <><Check className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{t('identities.editor.saved')}</>}
                </Badge>
                <button
                    type="button"
                    onClick={toggle}
                    className="rounded px-1 text-[11px] font-medium text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline focus-ring"
                    aria-label={removing ? t('identities.editor.keepLabel', { secret }) : t('identities.editor.removeLabel', { secret })}
                >
                    {removing ? <Undo2 className="inline h-3 w-3" aria-hidden="true" /> : t('identities.editor.remove')}
                </button>
            </span>
        );
    };

    const modes = keyModes(identity);
    const storedPassphrase = Boolean(identity?.has_passphrase) && form.keyMode !== 'generate' && form.keyMode !== 'none';

    return (
        <Modal
            open={open}
            onClose={() => void requestClose()}
            title={isEdit ? t('identities.editor.editTitle') : t('identities.editor.newTitle')}
            description={t('identities.editor.description')}
            icon={<UserRound className="h-4 w-4" />}
            widthClass="max-w-lg"
            dismissible={!saving}
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={() => void requestClose()} disabled={saving}>{t('common.cancel')}</Button>
                    <Button variant="primary" size="sm" type="submit" form="identity-editor-form" loading={saving}>
                        {isEdit ? t('identities.editor.save') : form.keyMode === 'generate' ? t('identities.editor.createAndGenerate') : t('identities.editor.create')}
                    </Button>
                </>
            }
        >
            <form id="identity-editor-form" ref={formRef} onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
                {serverError && (
                    <div ref={serverErrorRef} role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-words">{serverError}</span>
                    </div>
                )}
                {isEdit && serverCount > 0 && (
                    <p className="flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-100">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />
                        {t(serverCount === 1 ? 'identities.editor.usedBy.one' : 'identities.editor.usedBy.other', { count: serverCount })}
                    </p>
                )}

                <div className="grid grid-cols-2 gap-3">
                    <Field label={t('identities.editor.name')} required error={fieldError('name')}>
                        <Input
                            required
                            value={form.name}
                            onChange={(event) => set({ name: event.target.value })}
                            placeholder={t('identities.editor.namePlaceholder')}
                            maxLength={128}
                            data-autofocus
                        />
                    </Field>
                    <Field label={t('identities.editor.username')} hint={t('identities.editor.usernameHint')}>
                        <Input
                            value={form.username}
                            onChange={(event) => set({ username: event.target.value })}
                            placeholder="deploy"
                            autoCapitalize="off"
                            spellCheck={false}
                            maxLength={255}
                        />
                    </Field>
                </div>

                <Field
                    label={t('identities.editor.password')}
                    labelExtra={savedBadge(Boolean(identity?.has_password), form.removePassword, () => set({ removePassword: !form.removePassword }), t('identities.secrets.password'))}
                    hint={t('identities.editor.passwordHint')}
                >
                    <PasswordInput
                        value={form.password}
                        onChange={(event) => set({ password: event.target.value })}
                        placeholder={identity?.has_password && !form.removePassword ? t('identities.editor.keepPlaceholder') : t('identities.editor.passwordPlaceholder')}
                        autoComplete="new-password"
                        disabled={form.removePassword}
                    />
                </Field>

                <Field group label={t('identities.editor.key')}>
                    <SegmentedControl<KeyMode>
                        value={form.keyMode}
                        onChange={(keyMode) => set({ keyMode })}
                        options={modes.map((mode) => ({
                            value: mode,
                            label: t(`identities.editor.keyModes.${mode}`),
                            icon: MODE_ICONS[mode],
                            hint: t(`identities.editor.keyModeHints.${mode}`)
                        }))}
                    />
                </Field>

                {form.keyMode === 'keep' && identity?.fingerprint && (
                    <div className="space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                            <Badge tone="neutral">{keyTypeLabel(identity.key_type ?? '')}</Badge>
                            <code className="break-all font-mono text-zinc-300">{identity.fingerprint}</code>
                            {Boolean(identity.has_passphrase) && (
                                <Badge tone="success">
                                    <Lock className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
                                    {t('identities.editor.keptPassphrase')}
                                </Badge>
                            )}
                        </p>
                        {Boolean(identity.has_passphrase) && <p className="text-xs text-zinc-500">{t('identities.editor.keptPassphraseHint')}</p>}
                    </div>
                )}
                {form.keyMode === 'generate' && (
                    <div className="space-y-3 rounded-lg border border-brand-500/20 bg-brand-500/[0.05] p-3">
                        <p className="text-xs text-zinc-300">{t('identities.editor.generateNote')}</p>
                        <Field label={t('identities.editor.comment')} hint={t('identities.editor.commentHint')}>
                            <Input
                                value={form.comment}
                                onChange={(event) => set({ comment: event.target.value })}
                                placeholder={`shellmind:${form.name.trim() || t('identities.editor.namePlaceholder')}`}
                                maxLength={128}
                                spellCheck={false}
                                className="font-mono"
                            />
                        </Field>
                    </div>
                )}
                {form.keyMode === 'paste' && (
                    <Field label={t('identities.editor.privateKey')} error={fieldError('privateKey')} hint={identity?.has_private_key ? t('identities.editor.replaceKeyHint') : undefined}>
                        <Textarea
                            value={form.privateKey}
                            onChange={(event) => set({ privateKey: event.target.value })}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            rows={5}
                            spellCheck={false}
                            className="font-mono text-xs"
                        />
                    </Field>
                )}
                {form.keyMode === 'file' && (
                    <Field label={t('identities.editor.keyPath')} required error={fieldError('keyPath')} hint={t('identities.editor.keyPathHint')}>
                        <Input
                            value={form.keyPath}
                            onChange={(event) => set({ keyPath: event.target.value })}
                            placeholder="~/.ssh/id_ed25519"
                            spellCheck={false}
                            className="font-mono"
                        />
                    </Field>
                )}
                {usesPassphrase(form) && (
                    <Field
                        label={t('identities.editor.passphrase')}
                        labelExtra={storedPassphrase ? savedBadge(true, form.removePassphrase, () => set({ removePassphrase: !form.removePassphrase }), t('identities.secrets.passphrase')) : null}
                        hint={form.keyMode === 'generate' ? t('identities.editor.passphraseGenerateHint') : t('identities.editor.passphraseHint')}
                    >
                        <PasswordInput
                            value={form.passphrase}
                            onChange={(event) => set({ passphrase: event.target.value })}
                            placeholder={storedPassphrase && !form.removePassphrase ? t('identities.editor.keepPlaceholder') : t('identities.editor.passphrasePlaceholder')}
                            autoComplete="new-password"
                            disabled={storedPassphrase && form.removePassphrase}
                        />
                    </Field>
                )}

                <Checkbox
                    checked={form.useAgent}
                    onChange={(useAgent) => set({ useAgent })}
                    label={t('identities.editor.useAgent')}
                    description={t('identities.editor.useAgentHint')}
                />
            </form>
        </Modal>
    );
}
