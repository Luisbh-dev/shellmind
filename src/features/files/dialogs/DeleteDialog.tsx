import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { CountResult, FileEntry, FileItemRef } from '@shared/files';
import { Button, Modal, Spinner } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import type { FileClient } from '../client';
import { formatBytes } from '../listing';

const LISTED = 5;

export type DeleteDialogProps = {
    client: FileClient;
    entries: FileEntry[];
    items: FileItemRef[];
    onConfirm: () => Promise<void>;
    onClose: () => void;
};

type Count = { status: 'counting' } | { status: 'done'; result: CountResult } | { status: 'failed' };

// Confirms a delete, saying how much it removes: folders are counted on the
// server first because they go with everything inside them.
export function DeleteDialog({ client, entries, items, onConfirm, onClose }: DeleteDialogProps) {
    const t = useT();
    const language = useLanguage();
    const hasFolders = entries.some((entry) => entry.isDir && !entry.isLink);
    const [count, setCount] = useState<Count>({ status: 'counting' });
    const [busy, setBusy] = useState(false);
    const cancelRef = useRef<HTMLButtonElement>(null);

    // Cancel is the safe default for Enter.
    useEffect(() => { cancelRef.current?.focus(); }, []);

    useEffect(() => {
        if (!hasFolders) return;
        let current = true;
        client.count(items).then(
            (result) => { if (current) setCount({ status: 'done', result }); },
            () => { if (current) setCount({ status: 'failed' }); }
        );
        return () => { current = false; };
    }, [client, items, hasFolders]);

    const fileBytes = entries.reduce((total, entry) => total + (entry.isDir ? 0 : entry.size), 0);
    const title = entries.length === 1
        ? t('files.deleteDialog.titleOne', { name: entries[0].name })
        : t('files.deleteDialog.title', { count: entries.length });

    let summary: React.ReactNode;
    if (!hasFolders) {
        summary = entries.length === 1
            ? t('files.deleteDialog.fileOnly', { size: formatBytes(fileBytes, language) })
            : t('files.deleteDialog.filesOnly', { count: entries.length, size: formatBytes(fileBytes, language) });
    } else if (count.status === 'counting') {
        summary = <span className="inline-flex items-center gap-2"><Spinner className="h-3.5 w-3.5" />{t('files.deleteDialog.counting')}</span>;
    } else if (count.status === 'failed') {
        summary = t('files.deleteDialog.countFailed');
    } else {
        const { files, dirs, bytes, truncated } = count.result;
        const params = {
            files: files === 1 ? t('files.deleteDialog.fileCountOne') : t('files.deleteDialog.fileCount', { count: files.toLocaleString(language) }),
            dirs: dirs === 1 ? t('files.deleteDialog.folderCountOne') : t('files.deleteDialog.folderCount', { count: dirs.toLocaleString(language) }),
            size: formatBytes(bytes, language)
        };
        summary = t(truncated ? 'files.deleteDialog.contentsAtLeast' : 'files.deleteDialog.contents', params);
    }

    const confirm = async () => {
        setBusy(true);
        try {
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!busy}
            title={title}
            icon={<AlertTriangle className="h-4 w-4 text-rose-400" />}
            widthClass="max-w-md"
            footer={
                <>
                    <Button ref={cancelRef} variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
                    <Button variant="danger" size="sm" loading={busy} disabled={hasFolders && count.status === 'counting'} onClick={() => void confirm()}>
                        {t('files.deleteDialog.confirm')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3 text-sm text-zinc-300">
                {entries.length > 1 && (
                    <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2 font-mono text-xs text-zinc-300 scrollbar-thin">
                        {entries.slice(0, LISTED).map((entry) => <li key={entry.name} className="truncate">{entry.isDir ? `${entry.name}/` : entry.name}</li>)}
                        {entries.length > LISTED && <li className="text-zinc-500">{t('files.deleteDialog.more', { count: entries.length - LISTED })}</li>}
                    </ul>
                )}
                <p aria-live="polite">{summary}</p>
                <p className="text-xs text-zinc-500">{t('files.deleteDialog.irreversible')}</p>
            </div>
        </Modal>
    );
}
