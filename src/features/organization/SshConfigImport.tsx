import { useEffect, useId, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileCode, FileUp, KeyRound, Network } from 'lucide-react';
import type {
    SshConfigApplyEntry,
    SshConfigApplyRequest,
    SshConfigApplyResult,
    SshConfigEntry,
    SshConfigPreview,
    SshConfigPreviewRequest,
    SshConfigWarning
} from '@shared/organization';
import { cn } from '@/lib/cn';
import { ApiError, api } from '@/lib/api';
import { useT, type TranslateFn } from '@/i18n';
import { Badge, Button, Field, Input, Modal, SegmentedControl, Spinner, Textarea } from '@/components/ui';
import { ImportReportList } from './ImportReportList';

type Source = 'file' | 'paste';
type Step = 'source' | 'preview' | 'result';

export function warningText(t: TranslateFn, warning: SshConfigWarning): string {
    return t(`organization.sshImport.warnings.${warning.code}`, { detail: warning.detail ?? '' });
}

function target(entry: SshConfigEntry): string {
    const user = entry.user ? `${entry.user}@` : '';
    const port = entry.port ? `:${entry.port}` : '';
    return `${user}${entry.host}${port}`;
}

interface SshConfigImportProps {
    open: boolean;
    onClose: () => void;
    // Called after servers were created (the list should be refreshed).
    onImported: (result: SshConfigApplyResult) => void;
}

/** Wizard: read or paste an OpenSSH client config, pick hosts, create them. */
export function SshConfigImport({ open, onClose, onImported }: SshConfigImportProps) {
    const t = useT();
    const [step, setStep] = useState<Step>('source');
    const [source, setSource] = useState<Source>('file');
    const [text, setText] = useState('');
    const [preview, setPreview] = useState<SshConfigPreview | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    // null: the default group name, in the current language.
    const [group, setGroup] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<SshConfigApplyResult | null>(null);
    const listLabelId = useId();

    useEffect(() => {
        if (!open) return;
        setStep('source');
        setPreview(null);
        setResult(null);
        setError(null);
        setGroup(null);
    }, [open]);

    const groupName = group ?? t('organization.sshImport.defaultGroup');

    const errorText = (err: unknown) => (err instanceof ApiError ? err.message : t('organization.sshImport.failed'));

    const loadPreview = async () => {
        setBusy(true);
        setError(null);
        try {
            const request: SshConfigPreviewRequest = source === 'paste' ? { text } : {};
            const data = await api.post<SshConfigPreview>('/api/import/ssh-config/preview', request);
            setPreview(data);
            setSelected(new Set(data.entries.filter((entry) => !entry.duplicateOf).map((entry) => entry.alias)));
            setStep('preview');
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const apply = async () => {
        if (!preview) return;
        setBusy(true);
        setError(null);
        try {
            const entries = preview.entries
                .filter((entry) => selected.has(entry.alias))
                .map(({ alias, host, port, user, identityFile, proxyJump, proxyJumpSavedId, identityAgent }): SshConfigApplyEntry =>
                    ({ alias, host, port, user, identityFile, proxyJump, proxyJumpSavedId, ...(identityAgent ? { identityAgent } : {}) }));
            const request: SshConfigApplyRequest = { entries, group_name: groupName.trim() || null };
            const data = await api.post<SshConfigApplyResult>('/api/import/ssh-config/apply', request);
            setResult(data);
            setStep('result');
            if (data.created.length) onImported(data);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const toggle = (alias: string) => setSelected((current) => {
        const next = new Set(current);
        if (next.has(alias)) next.delete(alias);
        else next.add(alias);
        return next;
    });

    const selectable = preview?.entries.filter((entry) => !entry.duplicateOf) ?? [];
    const allSelected = selectable.length > 0 && selectable.every((entry) => selected.has(entry.alias));
    const aliases = new Set(preview?.entries.map((entry) => entry.alias));

    const footer = step === 'source' ? (
        <>
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={source === 'paste' && !text.trim()}
                onClick={() => void loadPreview()}
            >
                {t('organization.sshImport.preview')}
            </Button>
        </>
    ) : step === 'preview' ? (
        <>
            <Button variant="ghost" size="sm" onClick={() => setStep('source')} disabled={busy} className="mr-auto">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t('organization.sshImport.back')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={selected.size === 0} onClick={() => void apply()}>
                {t('organization.sshImport.importCount', { count: selected.size })}
            </Button>
        </>
    ) : (
        <Button variant="primary" size="sm" onClick={onClose} data-autofocus>{t('organization.sshImport.done')}</Button>
    );

    return (
        <Modal
            open={open}
            onClose={onClose}
            dismissible={!busy}
            title={t('organization.sshImport.title')}
            description={t('organization.sshImport.description')}
            icon={<FileCode className="h-4 w-4" />}
            widthClass="max-w-2xl"
            footer={footer}
        >
            {error && (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="break-words">{error}</span>
                </div>
            )}

            {step === 'source' && (
                <div className="space-y-4">
                    <SegmentedControl<Source>
                        aria-label={t('organization.sshImport.sourceLabel')}
                        value={source}
                        onChange={setSource}
                        options={[
                            { value: 'file', label: t('organization.sshImport.sourceFile'), icon: <FileUp className="h-3.5 w-3.5" /> },
                            { value: 'paste', label: t('organization.sshImport.sourcePaste'), icon: <FileCode className="h-3.5 w-3.5" /> }
                        ]}
                    />
                    {source === 'file' ? (
                        <p className="text-sm text-zinc-300">{t('organization.sshImport.fileHint')}</p>
                    ) : (
                        <Field label={t('organization.sshImport.pasteLabel')} hint={t('organization.sshImport.pasteHint')}>
                            <Textarea
                                value={text}
                                onChange={(event) => setText(event.target.value)}
                                rows={10}
                                spellCheck={false}
                                placeholder={'Host web\n    HostName 192.168.1.10\n    User deploy'}
                                className="font-mono text-xs"
                            />
                        </Field>
                    )}
                </div>
            )}

            {step === 'preview' && preview && (
                <div className="space-y-4">
                    {preview.source && (
                        <p className="text-xs text-zinc-400">
                            {t('organization.sshImport.readFrom')} <code className="font-mono text-zinc-300">{preview.source}</code>
                        </p>
                    )}
                    {preview.warnings.length > 0 && (
                        <ul className="space-y-1 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                            {preview.warnings.map((warning, index) => (
                                <li key={index} className="flex items-start gap-1.5">
                                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    <span className="break-words">{warningText(t, warning)}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {preview.entries.length === 0 ? (
                        <p className="py-6 text-center text-sm text-zinc-400">{t('organization.sshImport.noHosts')}</p>
                    ) : (
                        <>
                            <div className="flex items-center justify-between gap-3">
                                <h3 id={listLabelId} className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                                    {preview.entries.length === 1
                                        ? t('organization.sshImport.hostsOne')
                                        : t('organization.sshImport.hostsMany', { count: preview.entries.length })}
                                </h3>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={selectable.length === 0}
                                    onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((entry) => entry.alias)))}
                                >
                                    {allSelected ? t('organization.sshImport.selectNone') : t('organization.sshImport.selectAll')}
                                </Button>
                            </div>
                            <ul aria-labelledby={listLabelId} className="max-h-[42vh] space-y-1 overflow-y-auto scrollbar-thin rounded-lg border border-white/5 p-1">
                                {preview.entries.map((entry) => {
                                    const id = `ssh-import-${entry.alias}`;
                                    const checked = selected.has(entry.alias);
                                    // A jump alias that is already saved: its hosts go through the saved copy.
                                    const savedJump = preview.entries.find((other) => other.alias === entry.proxyJump)?.duplicateOf;
                                    const jumpNotSelected = entry.proxyJump !== null && aliases.has(entry.proxyJump)
                                        && !selected.has(entry.proxyJump) && !savedJump;
                                    const notes = [
                                        ...entry.warnings.map((warning) => warningText(t, warning)),
                                        ...(checked && jumpNotSelected ? [t('organization.sshImport.jumpNotSelected', { jump: entry.proxyJump ?? '' })] : [])
                                    ];
                                    return (
                                        <li key={entry.alias} className={cn('flex items-start gap-3 rounded-md px-2.5 py-2', checked && 'bg-white/[0.03]')}>
                                            <input
                                                id={id}
                                                type="checkbox"
                                                checked={checked}
                                                disabled={Boolean(entry.duplicateOf)}
                                                onChange={() => toggle(entry.alias)}
                                                aria-describedby={`${id}-details`}
                                                className="mt-1 h-4 w-4 shrink-0 accent-brand-500 focus-ring disabled:opacity-40"
                                            />
                                            <div className="min-w-0 flex-1">
                                                <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                                                    {entry.alias}
                                                    {entry.duplicateOf && (
                                                        <Badge tone="neutral">{t('organization.sshImport.alreadySaved', { name: entry.duplicateOf.name })}</Badge>
                                                    )}
                                                </label>
                                                <div id={`${id}-details`} className="mt-0.5 space-y-0.5 text-xs text-zinc-400">
                                                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                                                        <span>{target(entry)}</span>
                                                        {entry.proxyJump && (
                                                            <span className="inline-flex items-center gap-1">
                                                                <Network className="h-3 w-3" aria-hidden="true" />
                                                                {savedJump
                                                                    ? t('organization.sshImport.viaSaved', { jump: entry.proxyJump, name: savedJump.name })
                                                                    : t('organization.sshImport.via', { jump: entry.proxyJump })}
                                                            </span>
                                                        )}
                                                        {entry.identityFile && <span className="truncate">{entry.identityFile}</span>}
                                                        {entry.identityAgent && <span>{t('identities.sshImport.agent')}</span>}
                                                    </div>
                                                    {notes.map((note, index) => (
                                                        <p key={index} className="flex items-start gap-1 text-amber-300">
                                                            <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                                                            <span className="break-words">{note}</span>
                                                        </p>
                                                    ))}
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                            {preview.entries.some((entry) => selected.has(entry.alias) && (entry.identityFile || entry.identityAgent)) && (
                                <p className="flex items-start gap-1.5 text-xs text-zinc-400">
                                    <KeyRound className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    {t('identities.sshImport.hint')}
                                </p>
                            )}
                            <Field label={t('organization.sshImport.group')} hint={t('organization.sshImport.groupHint')}>
                                <Input value={groupName} onChange={(event) => setGroup(event.target.value)} maxLength={128} />
                            </Field>
                        </>
                    )}
                </div>
            )}

            {step === 'result' && result && (
                <div className="space-y-3" role="status">
                    <p className="flex items-center gap-2 text-sm text-zinc-200">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                        {t('organization.sshImport.resultSummary', { created: result.created.length, skipped: result.skipped.length })}
                    </p>
                    <ImportReportList report={result} />
                    {result.identities && <ImportReportList title={t('identities.import.identities')} report={result.identities} />}
                </div>
            )}

            {busy && step !== 'source' && (
                <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400" aria-live="polite">
                    <Spinner className="h-3.5 w-3.5" /> {t('organization.sshImport.working')}
                </div>
            )}
        </Modal>
    );
}
