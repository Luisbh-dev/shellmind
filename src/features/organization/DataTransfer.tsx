import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Download, FileCode, Network, Upload } from 'lucide-react';
import type { ConfigImportPreview, ConfigImportResult, ExportBundle } from '@shared/organization';
import { ApiError, api } from '@/lib/api';
import { saveText } from '@/lib/download';
import { useT } from '@/i18n';
import { Button, Checkbox, useToast } from '@/components/ui';
import { ImportCredentialsResult, ImportCredentialsReview } from '@/features/identities/ImportCredentials';
import { ImportReportList } from './ImportReportList';

const today = () => new Date().toISOString().slice(0, 10);

const createsAnything = (result: ConfigImportResult) =>
    result.servers.created.length > 0 || result.snippets.created.length > 0 || result.tunnels.created.length > 0
    || (result.identities?.created.length ?? 0) > 0;

// A chosen file, previewed and waiting for the user's go-ahead.
type Pending = { fileName: string; bundle: unknown; preview: ConfigImportPreview };

interface DataTransferProps {
    // Servers were created: refresh the list.
    onImported: () => void;
    onOpenSshImport: () => void;
}

// Settings → Data: export the configuration as JSON, import such a file (after
// reviewing what it adds), and import hosts from ~/.ssh/config.
export function DataTransfer({ onImported, onOpenSshImport }: DataTransferProps) {
    const t = useT();
    const toast = useToast();
    const fileRef = useRef<HTMLInputElement>(null);
    const reviewHeadingId = useId();
    const [exporting, setExporting] = useState(false);
    const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);
    const [trusted, setTrusted] = useState(false);
    // W7-S2: consent to give imported hosts the credentials saved here.
    const [linkCredentials, setLinkCredentials] = useState(false);
    const [result, setResult] = useState<ConfigImportResult | null>(null);
    const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);

    // The review and the report replace the controls that led to them: focus follows.
    useEffect(() => {
        if (pending) reviewHeadingRef.current?.focus();
    }, [pending]);
    useEffect(() => {
        if (result) resultRef.current?.focus();
    }, [result]);

    const exportConfig = async () => {
        setExporting(true);
        try {
            const bundle = await api.get<ExportBundle>('/api/export');
            saveText(`shellmind-config-${today()}.json`, JSON.stringify(bundle, null, 2), 'application/json');
            const count = bundle.servers.length;
            toast.success(count === 1 ? t('organization.transfer.exportedOne') : t('organization.transfer.exportedMany', { count }));
        } catch (err) {
            toast.error(t('organization.transfer.exportFailed'), err instanceof ApiError ? err.message : undefined);
        } finally {
            setExporting(false);
        }
    };

    const errorText = (err: unknown) => (err instanceof ApiError ? err.message : t('organization.transfer.importFailed'));

    // Nothing is saved yet: the backend runs the import and rolls it back.
    const previewFile = async (file: File) => {
        setBusy('preview');
        setError(null);
        setResult(null);
        setPending(null);
        setTrusted(false);
        setLinkCredentials(false);
        try {
            let bundle: unknown;
            try {
                bundle = JSON.parse(await file.text());
            } catch {
                setError(t('organization.transfer.notJson'));
                return;
            }
            const preview = await api.post<ConfigImportPreview>('/api/import/preview', bundle);
            setPending({ fileName: file.name, bundle, preview });
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(null);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    const apply = async () => {
        if (!pending) return;
        setBusy('apply');
        setError(null);
        try {
            const data = await api.post<ConfigImportResult>(linkCredentials ? '/api/import?link_credentials=1' : '/api/import', pending.bundle);
            setResult(data);
            setPending(null);
            if (createsAnything(data)) onImported();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(null);
        }
    };

    const review = pending?.preview.review;
    const needsTrust = Boolean(review && review.consoles.length > 0);
    const canApply = Boolean(pending && createsAnything(pending.preview)) && (!needsTrust || trusted);

    return (
        <div className="space-y-5">
            <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">{t('organization.transfer.exportHeading')}</h3>
                <p className="text-xs text-zinc-400">{t('organization.transfer.exportHint')}</p>
                <Button size="sm" variant="secondary" loading={exporting} onClick={() => void exportConfig()}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" /> {t('organization.transfer.export')}
                </Button>
            </section>

            <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">{t('organization.transfer.importHeading')}</h3>
                <p className="text-xs text-zinc-400">{t('organization.transfer.importHint')}</p>
                <div className="flex flex-wrap gap-2">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="application/json,.json"
                        className="sr-only"
                        tabIndex={-1}
                        aria-hidden="true"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void previewFile(file);
                        }}
                    />
                    <Button size="sm" variant="secondary" loading={busy === 'preview'} disabled={busy === 'apply'} onClick={() => fileRef.current?.click()}>
                        <Upload className="h-3.5 w-3.5" aria-hidden="true" /> {t('organization.transfer.import')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={onOpenSshImport}>
                        <FileCode className="h-3.5 w-3.5" aria-hidden="true" /> {t('organization.transfer.sshConfig')}
                    </Button>
                </div>
                {error && <p role="alert" className="text-xs text-rose-300 break-words">{error}</p>}

                {pending && review && (
                    <section aria-labelledby={reviewHeadingId} className="space-y-3 rounded-lg border border-white/10 bg-ink-900/50 p-3">
                        <div>
                            <h4 id={reviewHeadingId} ref={reviewHeadingRef} tabIndex={-1} className="rounded text-sm font-medium text-zinc-100 outline-none focus-ring">
                                {t('organization.transfer.reviewHeading', { file: pending.fileName })}
                            </h4>
                            <p className="text-xs text-zinc-400">{t('organization.transfer.reviewHint')}</p>
                        </div>

                        {!createsAnything(pending.preview) && (
                            <p className="text-xs text-zinc-300">
                                {[pending.preview.servers, pending.preview.snippets, pending.preview.tunnels].some((report) => report.skipped.length > 0)
                                    ? t('organization.transfer.nothingNew')
                                    : t('organization.transfer.nothing')}
                            </p>
                        )}
                        <ImportReportList preview title={t('organization.transfer.servers')} report={pending.preview.servers} />
                        <ImportReportList preview title={t('organization.transfer.snippets')} report={pending.preview.snippets} />
                        <ImportReportList preview title={t('organization.transfer.tunnels')} report={pending.preview.tunnels} />
                        {pending.preview.identities && <ImportReportList preview title={t('identities.import.identities')} report={pending.preview.identities} />}

                        <ImportCredentialsReview items={review.credentials ?? []} checked={linkCredentials} onChange={setLinkCredentials} disabled={busy === 'apply'} />

                        {review.consoles.length > 0 && (
                            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-100">
                                <p className="flex items-start gap-1.5 font-medium">
                                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                                    {t('organization.transfer.consolesWarning')}
                                </p>
                                <ul className="space-y-1.5">
                                    {review.consoles.map((entry, index) => (
                                        <li key={`${entry.name}-${index}`} className="rounded-md bg-black/20 px-2 py-1.5">
                                            <p className="font-medium text-zinc-100">{entry.name}</p>
                                            <dl className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-zinc-300">
                                                {entry.command && (
                                                    <>
                                                        <dt className="text-zinc-400">{t('organization.transfer.consoleCommand')}</dt>
                                                        <dd className="break-all font-mono">{entry.command}</dd>
                                                    </>
                                                )}
                                                {entry.initial_command && (
                                                    <>
                                                        <dt className="text-zinc-400">{t('organization.transfer.consoleInitialCommand')}</dt>
                                                        <dd className="break-all font-mono">{entry.initial_command}</dd>
                                                    </>
                                                )}
                                                {entry.cwd && (
                                                    <>
                                                        <dt className="text-zinc-400">{t('organization.transfer.consoleCwd')}</dt>
                                                        <dd className="break-all font-mono">{entry.cwd}</dd>
                                                    </>
                                                )}
                                            </dl>
                                        </li>
                                    ))}
                                </ul>
                                <Checkbox checked={trusted} onChange={setTrusted} label={t('organization.transfer.trustCommands')} />
                            </div>
                        )}

                        {review.tunnels.length > 0 && (
                            <div className="space-y-1.5 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-sky-100">
                                <p className="flex items-start gap-1.5">
                                    <Network className="mt-px h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />
                                    {t('organization.transfer.tunnelsNote')}
                                </p>
                                <ul className="space-y-0.5 pl-5 text-zinc-300">
                                    {review.tunnels.map((tunnel, index) => (
                                        <li key={`${tunnel.name}-${index}`} className="break-words">
                                            {t('organization.transfer.tunnelLine', {
                                                name: tunnel.name,
                                                server: tunnel.server,
                                                local: `${tunnel.local_host}:${tunnel.local_port}`,
                                                remote: `${tunnel.remote_host}:${tunnel.remote_port}`
                                            })}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        <div className="flex justify-end gap-2">
                            <Button size="sm" variant="ghost" disabled={busy === 'apply'} onClick={() => setPending(null)}>
                                {t('common.cancel')}
                            </Button>
                            {createsAnything(pending.preview) && (
                                <Button size="sm" variant="primary" loading={busy === 'apply'} disabled={!canApply} onClick={() => void apply()}>
                                    {t('organization.transfer.confirmImport')}
                                </Button>
                            )}
                        </div>
                    </section>
                )}

                {result && (
                    <div ref={resultRef} tabIndex={-1} role="status" className="space-y-3 rounded-lg border border-white/5 bg-ink-900/50 p-3 outline-none">
                        <p className="text-xs font-medium text-zinc-200">{t('organization.transfer.imported')}</p>
                        <ImportReportList title={t('organization.transfer.servers')} report={result.servers} />
                        <ImportReportList title={t('organization.transfer.snippets')} report={result.snippets} />
                        <ImportReportList title={t('organization.transfer.tunnels')} report={result.tunnels} />
                        {result.identities && <ImportReportList title={t('identities.import.identities')} report={result.identities} />}
                        <ImportCredentialsResult credentials={result.credentials} />
                    </div>
                )}
            </section>
        </div>
    );
}
